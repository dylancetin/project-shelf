import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSupervisor, UnitState } from '../server/agent-supervisor';
import type { ProjectData } from '../server/store';
import type { T3Threads } from '../server/t3-threads';
import type { AgentServerRecord } from '../shared/agent-servers';

export async function fixture(): Promise<string> {
  await mkdir('/tmp/opencode', { recursive: true });
  return mkdtemp('/tmp/opencode/project-shelf-test-');
}

export async function files(root: string, entries: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(entries)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export const cleanup = (root: string) => rm(root, { recursive: true, force: true });

export function project(directory: string, overrides: Partial<ProjectData> = {}): ProjectData {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name: 'Disposable fixture', description: '', kind: 'project',
    directory, source: 'test', url: '', hostname: '', devCommand: '', buildCommand: '',
    prodCommand: '', port: null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now, ...overrides,
  };
}

export function request(route: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://shelf.test${route}`, {
    method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await Bun.sleep(20);
  }
}

export function shellCommand(filename: string): string {
  return `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(filename)}`;
}

/**
 * A disposable stand-in for cloudflared. It records its arguments and PID, then
 * prints a quick-tunnel address and edge registration (or a startup error).
 */
export async function fakeCloudflared(root: string, mode: 'ready' | 'fail' | 'hang' = 'ready'): Promise<string> {
  const filename = path.join(root, `cloudflared-${mode}`);
  const log = JSON.stringify(path.join(root, 'cloudflared.log'));
  const body = mode === 'fail'
    ? `echo "2026-01-01T00:00:00Z ERR failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": fixture outage" >&2\nexit 1`
    : mode === 'hang' ? 'exec sleep 60'
    : `echo "2026-01-01T00:00:00Z INF |  https://fixture-$$.trycloudflare.com  |" >&2\nsleep 0.05\necho "2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0" >&2\nexec sleep 60`;
  await writeFile(filename, `#!/bin/sh\necho "$$ $*" >> ${log}\n${body}\n`, { mode: 0o755 });
  return filename;
}

export async function processAlive(pid: number): Promise<boolean> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

/** An in-memory stand-in for systemd: units are "running" from start until stop. */
export class FakeAgentSupervisor implements AgentSupervisor {
  units = new Map<string, UnitState>();
  starts = 0;
  async start(record: AgentServerRecord) {
    this.starts++;
    this.units.set(record.unit, { status: 'running', pid: 1000 + this.starts, controlGroup: '/fixture', diagnostic: 'running' });
  }
  async state(record: AgentServerRecord): Promise<UnitState> {
    return this.units.get(record.unit) ?? { status: 'stopped', pid: null, controlGroup: '', diagnostic: 'missing' };
  }
  async ready() { return true; }
  async logs() { return 'fixture stdout'; }
  async stop(record: AgentServerRecord) { this.units.delete(record.unit); }
}

/** Every thread ID is an active top-level thread. */
export const activeThreads: T3Threads = {
  lookup: ids => new Map(ids.map(id => [id, { id, rootId: id, title: 'Fixture thread', status: 'active', link: null }])),
};
