import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { LogLine, Project, RunMode } from '../shared/types';
import { ApiError, errorMessage } from './errors';
import { canonicalDirectory } from './paths';
import type { ProjectData } from './store';

type Runtime = Project['runtime'];
interface ManagedProcess {
  runtime: Runtime;
  child: ChildProcess | null;
  groupPid: number | null;
  cancelled: boolean;
  task: Promise<void>;
  stopping?: Promise<void>;
  stopDeadline?: number;
}

const EMPTY_RUNTIME: Runtime = { status: 'stopped', mode: null, pid: null, startedAt: null, exitCode: null };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function signalGroup(pid: number | null, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Fall back to the direct child if a platform cannot signal process groups.
      try { process.kill(pid, signal); } catch { /* Already exited. */ }
    }
  }
}

export interface ProcessOptions {
  maxLogLines?: number;
  maxLineLength?: number;
  stopGraceMs?: number;
  maxProcesses?: number;
}

export function childEnvironment(project: Pick<ProjectData, 'port'>, mode: RunMode, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // These configure the panel, not the project it is launching. In particular,
  // a systemd PORT=4958 must never make a child contend with the panel itself.
  delete env.PORT;
  delete env.API_PORT;
  delete env.PANEL_DB_PATH;
  if (project.port !== null) env.PORT = String(project.port);
  env.HOST = '0.0.0.0';
  env.NODE_ENV = mode === 'dev' ? 'development' : 'production';
  return env;
}

export class ProcessManager {
  private records = new Map<string, ManagedProcess>();
  private buffers = new Map<string, LogLine[]>();
  private nextLogId = 1;
  private closed = false;
  private readonly maxLogLines: number;
  private readonly maxLineLength: number;
  private readonly stopGraceMs: number;
  private readonly maxProcesses: number;

  constructor(options: ProcessOptions = {}) {
    this.maxLogLines = options.maxLogLines ?? 500;
    this.maxLineLength = options.maxLineLength ?? 4000;
    this.stopGraceMs = options.stopGraceMs ?? 1800;
    this.maxProcesses = options.maxProcesses ?? 20;
  }

  runtime(id: string): Runtime {
    return { ...(this.records.get(id)?.runtime ?? EMPTY_RUNTIME) };
  }

  project(data: ProjectData): Project {
    return { ...data, runtime: this.runtime(data.id) };
  }

  logs(id: string): LogLine[] {
    return (this.buffers.get(id) ?? []).map((line) => ({ ...line }));
  }

  active(id: string): boolean {
    return ['starting', 'running', 'stopping'].includes(this.runtime(id).status);
  }

  private log(id: string, stream: LogLine['stream'], text: string): void {
    const lines = this.buffers.get(id) ?? [];
    const cleaned = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\0/g, '');
    lines.push({ id: this.nextLogId++, timestamp: new Date().toISOString(), stream, text: cleaned.slice(0, this.maxLineLength) });
    if (lines.length > this.maxLogLines) lines.splice(0, lines.length - this.maxLogLines);
    this.buffers.set(id, lines);
    // Bound aggregate retention too, including projects removed outside this process.
    if (this.buffers.size > 200) {
      for (const key of this.buffers.keys()) {
        if (key !== id && !this.active(key)) { this.buffers.delete(key); break; }
      }
    }
  }

  async start(project: ProjectData, mode: RunMode): Promise<Project> {
    if (this.closed) throw new ApiError(503, 'The server is shutting down');
    if (project.kind !== 'project') throw new ApiError(400, 'Services are links and cannot be started');
    if (!['dev', 'prod', 'build'].includes(mode)) throw new ApiError(400, 'mode must be dev, prod, or build');
    if (this.active(project.id)) throw new ApiError(409, 'This project already has a managed command running');
    const command = mode === 'dev' ? project.devCommand : mode === 'build' ? project.buildCommand : project.prodCommand;
    if (!command.trim()) throw new ApiError(400, `No ${mode === 'prod' ? 'production' : mode} command is configured`);
    await canonicalDirectory(project.directory);
    // Recheck after filesystem validation; concurrent start requests must not launch two trees.
    if (this.closed) throw new ApiError(503, 'The server is shutting down');
    if (this.active(project.id)) throw new ApiError(409, 'This project already has a managed command running');
    const running = [...this.records.values()].filter((record) => ['starting', 'running', 'stopping'].includes(record.runtime.status)).length;
    if (running >= this.maxProcesses) throw new ApiError(429, `At most ${this.maxProcesses} commands can run simultaneously`);
    const record: ManagedProcess = {
      runtime: { status: 'starting', mode, pid: null, startedAt: new Date().toISOString(), exitCode: null },
      child: null, groupPid: null, cancelled: false, task: Promise.resolve(),
    };
    this.records.set(project.id, record);
    this.log(project.id, 'system', `Starting ${mode} in ${project.directory}`);
    record.task = this.run(project, record, mode);
    return this.project(project);
  }

  private async run(project: ProjectData, record: ManagedProcess, mode: RunMode): Promise<void> {
    let exitCode: number | null = null;
    try {
      if (mode === 'prod' && project.buildCommand.trim()) {
        this.log(project.id, 'system', 'Building before production start');
        exitCode = await this.command(project, record, project.buildCommand);
        if (exitCode !== 0 || record.cancelled) return;
      }
      if (record.cancelled) return;
      exitCode = await this.command(project, record,
        mode === 'dev' ? project.devCommand : mode === 'build' ? project.buildCommand : project.prodCommand);
    } catch (error) {
      exitCode = 1;
      this.log(project.id, 'system', `Command failed: ${errorMessage(error)}`);
    } finally {
      record.child = null;
      record.groupPid = null;
      record.runtime.pid = null;
      record.runtime.exitCode = exitCode;
      record.runtime.status = record.cancelled || exitCode === 0 ? 'stopped' : 'failed';
      this.log(project.id, 'system', record.cancelled ? 'Stopped' : `Command exited${exitCode === null ? ' after a signal' : ` with code ${exitCode}`}`);
    }
  }

  private async command(project: ProjectData, record: ManagedProcess, command: string): Promise<number | null> {
    if (record.cancelled) return null;
    this.log(project.id, 'system', `$ ${command}`);
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: project.directory,
      env: childEnvironment(project, record.runtime.mode!),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    record.child = child;
    record.groupPid = child.pid ?? null;
    record.runtime.pid = child.pid ?? null;
    const flushers: (() => void)[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const emit = (value: string) => {
        pending += value;
        // Both newline-delimited and endless single-line output remain bounded.
        while (pending.length) {
          const newline = pending.search(/[\n\r]/);
          if (newline >= 0 && newline <= this.maxLineLength) {
            this.log(project.id, stream, pending.slice(0, newline));
            pending = pending.slice(newline + (pending.slice(newline, newline + 2) === '\r\n' ? 2 : 1));
          } else if (pending.length >= this.maxLineLength) {
            this.log(project.id, stream, pending.slice(0, this.maxLineLength));
            pending = pending.slice(this.maxLineLength);
          } else break;
        }
      };
      child[stream]?.on('data', (chunk: Buffer) => emit(decoder.write(chunk)));
      let flushed = false;
      const flush = () => {
        if (flushed) return;
        flushed = true;
        emit(decoder.end());
        if (pending) { this.log(project.id, stream, pending); pending = ''; }
      };
      child[stream]?.once('end', flush);
      flushers.push(flush);
    }
    child.once('spawn', () => {
      if (!record.cancelled) record.runtime.status = 'running';
      else signalGroup(record.groupPid, 'SIGTERM');
    });
    const pid = child.pid;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve(exitCode));
      });
      // A shell can exit while grandchildren stay alive with inherited output pipes.
      // Never leave those process groups behind, even on a normal command exit.
      if (pid && groupAlive(pid)) {
        signalGroup(pid, 'SIGTERM');
        const grace = record.cancelled ? Math.max(0, (record.stopDeadline ?? Date.now()) - Date.now()) : Math.min(this.stopGraceMs, 150);
        await delay(grace);
        if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
      }
      // Give final pipe chunks a turn, then explicitly release all descriptors.
      await delay(10);
      return code;
    } finally {
      for (const flush of flushers) flush();
      child.stdout?.destroy();
      child.stderr?.destroy();
      record.child = null;
      record.groupPid = null;
      record.runtime.pid = null;
    }
  }

  async stop(id: string): Promise<Runtime> {
    const record = this.records.get(id);
    if (!record || !this.active(id)) return this.runtime(id);
    if (record.stopping) { await record.stopping; return this.runtime(id); }
    record.cancelled = true;
    record.stopDeadline = Date.now() + this.stopGraceMs;
    record.runtime.status = 'stopping';
    this.log(id, 'system', 'Stopping process group (SIGTERM)');
    record.stopping = (async () => {
      const pid = record.groupPid;
      signalGroup(pid, 'SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.stopGraceMs); });
      await Promise.race([record.task, deadline]);
      if (timer) clearTimeout(timer);
      if (pid && groupAlive(pid)) {
        this.log(id, 'system', 'Escalating process group to SIGKILL');
        signalGroup(pid, 'SIGKILL');
      }
      // SIGKILL guarantees an eventual child exit on the supported Linux host.
      await record.task;
    })();
    await record.stopping;
    return this.runtime(id);
  }

  forget(id: string): void {
    if (this.active(id)) throw new ApiError(409, 'Stop the project before forgetting it');
    this.records.delete(id);
    this.buffers.delete(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.records.keys()].map((id) => this.stop(id)));
  }
}
