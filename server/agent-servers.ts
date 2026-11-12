import { createHash, randomInt } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { AddAgentServer, AgentServer, AgentServerRecord, AgentServerThread } from '../shared/agent-servers';
import { ApiError, errorMessage } from './errors';
import type { Store } from './store';
import { SystemdAgentSupervisor, type AgentSupervisor } from './agent-supervisor';
import { T3StateThreads, T3_THREAD_ID, type T3Thread, type T3Threads } from './t3-threads';
import { agentTunnel, type TunnelManager } from './tunnels';
import type { TunnelState } from '../shared/tunnels';

const INACTIVE_THREADS = new Set<AgentServerThread['status']>(['settled', 'archived', 'deleted']);

// Shared by app instances in this process. SQLite's unique port index also
// reserves ports across processes; there is no check-then-insert allocation race.
let allocation: Promise<unknown> = Promise.resolve();

export class AgentServers {
  readonly machine: { id: string; name: string };
  constructor(private store: Store, private supervisor: AgentSupervisor = new SystemdAgentSupervisor(), private threads: T3Threads = new T3StateThreads(), private tunnels?: TunnelManager) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_servers (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, port INTEGER UNIQUE NOT NULL, data TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS agent_server_requests (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);`);
    this.machine = store.getValue('agentMachine') ?? { id: crypto.randomUUID(), name: hostname() };
    store.setValue('agentMachine', this.machine);
  }

  private records(): AgentServerRecord[] {
    return (this.store.db.query('SELECT data FROM agent_servers ORDER BY rowid').all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  private require(id: string) {
    const record = this.records().find(row => row.id === id);
    if (!record) throw new ApiError(404, 'Agent server not found');
    // Never accept caller-selected unit names or externally registered PIDs.
    if (record.machineId !== this.machine.id || record.unit !== `project-shelf-agent-${record.id}.service` || !/^[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid agent server ownership');
    return record;
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const pending = allocation.catch(() => {}).then(fn); allocation = pending;
    return pending;
  }
  private save(record: AgentServerRecord) {
    this.store.db.query('UPDATE agent_servers SET data = ? WHERE id = ?').run(JSON.stringify(record), record.id);
  }
  // Briefly wait for an owned listener so callers get a meaningful first status.
  private async settle(record: AgentServerRecord) {
    const deadline = Date.now() + 4000;
    let result = await this.view(record);
    while (!result.ready && ['running', 'starting'].includes(result.status) && Date.now() < deadline) {
      await Bun.sleep(150); result = await this.view(record);
    }
    return result;
  }
  private lookupThreads(records: AgentServerRecord[]): Map<string, T3Thread> | Error {
    try { return this.threads.lookup(records.flatMap(record => record.threadId ? [record.threadId] : [])); }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }
  private threadView(record: AgentServerRecord, threads: Map<string, T3Thread> | Error): AgentServerThread | null {
    if (!record.threadId) return null;
    const fallback = { id: record.threadId, rootId: null, title: null, link: null };
    if (threads instanceof Error) return { ...fallback, status: 'unavailable' };
    return threads.get(record.threadId) ?? { ...fallback, status: 'missing' };
  }
  // Previews are only tied to threads that exist and are still being worked on.
  private requireActiveThread(threadId: unknown): string {
    if (typeof threadId !== 'string' || !T3_THREAD_ID.test(threadId)) throw new ApiError(400, 'threadId is required: pass your T3 Code thread ID from the T3CODE_THREAD_ID environment variable');
    let thread;
    try { thread = this.threads.lookup([threadId]).get(threadId); }
    catch (error) { throw new ApiError(503, `Could not read T3 Code threads to verify threadId: ${errorMessage(error)}`); }
    if (!thread) throw new ApiError(400, `Unknown T3 Code thread ${threadId}; pass this session's T3CODE_THREAD_ID`);
    if (thread.status !== 'active') throw new ApiError(409, `The top-level T3 Code thread ${thread.rootId ?? threadId} is ${thread.status}; previews tied to it are removed automatically`);
    return threadId;
  }
  async view(record: AgentServerRecord, threads = this.lookupThreads([record])): Promise<AgentServer> {
    let state;
    let ready = false;
    try { state = await this.supervisor.state(record); ready = await this.supervisor.ready(record, state); }
    catch (error) { state = { status: 'unknown' as const, pid: null, diagnostic: String(error) }; }
    return { ...record, machine: this.machine.name, pid: state.pid, status: state.status,
      diagnostic: record.launchError || `${state.diagnostic}${!ready && state.status === 'running' ? '; waiting for an owned HTTP listener on the assigned port, bound to 0.0.0.0' : ''}`, ready,
      url: `http://${this.store.settings().defaultHostname || this.machine.name}:${record.port}/`, logsUrl: `/api/agent-servers/${record.id}/logs`,
      thread: this.threadView(record, threads), tunnel: this.tunnels?.get(agentTunnel(record.id)) ?? null };
  }
  /** All previews, or only those assigned `port`. */
  async list(port?: number) {
    const records = this.records().filter(record => port === undefined || record.port === port).map(record => this.require(record.id));
    const threads = this.lookupThreads(records);
    return Promise.all(records.map(record => this.view(record, threads)));
  }
  async logs(id: string) {
    const record = this.require(id);
    try {
      const logs = await this.supervisor.logs(record);
      return record.launchError ? `${record.launchError}\n${logs}`.slice(-65536) : logs;
    } catch (error) {
      if (record.launchError) return `${record.launchError}\nJournal unavailable: ${String(error)}`;
      throw error;
    }
  }

  async add(input: AddAgentServer): Promise<AgentServer> {
    for (const [key, max] of [['name', 200], ['cwd', 4096], ['command', 16000]] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max || input[key].includes('\0')) throw new ApiError(400, `Invalid ${key}`);
    }
    if (!path.isAbsolute(input.cwd)) throw new ApiError(400, 'cwd must be an absolute working directory (use the actual worktree)');
    const cwd = await realpath(input.cwd).catch(() => { throw new ApiError(400, 'cwd does not exist'); });
    if (!(await stat(cwd)).isDirectory()) throw new ApiError(400, 'cwd must be a directory');
    if (input.idempotencyKey !== undefined && (!/^[\w.:-]{1,200}$/.test(input.idempotencyKey))) throw new ApiError(400, 'Invalid idempotencyKey');
    const threadId = this.requireActiveThread(input.threadId);
    // The thread is part of the identity: another thread never reuses (and later
    // removes) a preview it does not own.
    const fingerprint = createHash('sha256').update(JSON.stringify([input.name.trim(), cwd, input.command, threadId])).digest('hex');
    const key = input.idempotencyKey ? `explicit:${input.idempotencyKey}` : `implicit:${fingerprint}`;
    return this.locked(async () => {
      const prior = this.store.db.query('SELECT fingerprint, deleted FROM agent_server_requests WHERE request_key = ?').get(key) as { fingerprint: string; deleted: number } | null;
      if (prior && prior.fingerprint !== fingerprint) throw new ApiError(409, 'Idempotency key was already used with different inputs');
      if (prior?.deleted) throw new ApiError(409, 'This request was deleted. Use a new idempotencyKey to explicitly create another server.');
      const existing = this.records().find(row => row.requestKey === key);
      if (existing) return this.view(this.require(existing.id));
      const used = new Set(this.records().map(row => row.port));
      const first = randomInt(1000);
      for (let offset = 0; offset < 1000; offset++) {
        const port = 5000 + (first + offset) % 1000;
        if (used.has(port)) continue;
        // Reserve both families; don't kill a process occupying a candidate port.
        let reservation: { stop(closeActiveConnections?: boolean): void };
        try { reservation = Bun.listen({ hostname: '::', port, socket: { data() {} } }); } catch { continue; }
        const id = crypto.randomUUID();
        const record: AgentServerRecord = { id, machineId: this.machine.id, name: input.name.trim(), cwd, command: input.command, port, unit: `project-shelf-agent-${id}.service`, createdAt: new Date().toISOString(), requestKey: key, threadId };
        try {
          this.store.db.transaction(() => {
            this.store.db.query('INSERT INTO agent_servers VALUES (?, ?, ?, ?)').run(id, key, port, JSON.stringify(record));
            this.store.db.query('INSERT INTO agent_server_requests VALUES (?, ?, 0)').run(key, fingerprint);
          })();
        } catch (error) { reservation.stop(true); throw error; }
        reservation.stop(true);
        // Persist BEFORE starting. A crash leaves an inspectable record; retries
        // never launch duplicate units. A launch failure remains visible too.
        try { await this.supervisor.start(record); }
        catch (error) {
          record.launchError = `Launch failed: ${String(error)}`;
          this.save(record);
          throw new ApiError(502, `Agent server ${id} could not start; record retained for logs, restart, or Stop at /api/agent-servers/${id}/logs: ${String(error)}`);
        }
        return this.settle(record);
      }
      throw new ApiError(409, 'No free preview ports in 5000–5999');
    });
  }

  // Restart in place: same ID, unit, worktree, command, port and URL. The old
  // control group must be fully stopped first, or the new run is never started.
  async restart(id: string): Promise<AgentServer> {
    return this.locked(async () => {
      const record = this.require(id);
      // A tunnel never outlives the process it exposes. Once the old one is stopped, whatever listens on this
      // port next (nothing, or another program when the restart is refused) is not what the link was opened for.
      try { await this.supervisor.stop(record); }
      catch (error) { throw new ApiError(502, `Agent server ${id} could not be stopped, so it was not restarted: ${errorMessage(error)}`); }
      finally { await this.tunnels?.stop(agentTunnel(id)); }
      // Keep the URL stable. Never kill a program that took the port while the
      // preview was down; record why it stays stopped instead.
      try { Bun.listen({ hostname: '::', port: record.port, socket: { data() {} } }).stop(true); }
      catch {
        record.launchError = `Restart blocked: port ${record.port} is in use by another process`;
        this.save(record);
        throw new ApiError(409, `${record.launchError}. Agent server ${id} is stopped; delete it and add a new preview to get a different port.`);
      }
      delete record.launchError;
      try { await this.supervisor.start(record); }
      catch (error) {
        record.launchError = `Restart failed: ${String(error)}`;
        this.save(record);
        throw new ApiError(502, `Agent server ${id} could not restart; record retained for logs, restart, or Stop: ${String(error)}`);
      }
      this.save(record);
      return this.settle(record);
    });
  }

  /** Opens a Cloudflare quick tunnel to a ready preview's port; resolves once its public URL works. */
  async openTunnel(id: string): Promise<TunnelState> {
    if (!this.tunnels) throw new ApiError(503, 'Cloudflare tunnels are not available on this server');
    const tunnels = this.tunnels;
    const record = this.require(id);
    if (!tunnels.get(agentTunnel(id)) && !(await this.view(record)).ready) throw new ApiError(409, 'Wait until the preview is ready before opening a Cloudflare tunnel');
    // A Stop that lands while readiness was checked wins; never tunnel a deleted preview.
    this.require(id);
    return tunnels.start(agentTunnel(id), record.port);
  }
  async closeTunnel(id: string) {
    this.require(id);
    await this.tunnels?.stop(agentTunnel(id));
    return { ok: true };
  }

  async delete(id: string) {
    return this.locked(async () => {
      const row = this.records().find(record => record.id === id);
      if (!row) return { ok: true }; // safe repeated deletion
      const record = this.require(id);
      await this.supervisor.stop(record); // failure must retain the registration
      this.store.db.transaction(() => {
        this.store.db.query('UPDATE agent_server_requests SET deleted = 1 WHERE request_key = ?').run(record.requestKey);
        this.store.db.query('DELETE FROM agent_servers WHERE id = ?').run(id);
      })();
      // Stopping a preview always closes its public tunnel too.
      await this.tunnels?.stop(agentTunnel(id));
      return { ok: true };
    });
  }

  // Fully delete previews whose top-level T3 thread is settled, archived or
  // deleted. Missing threads, unreadable T3 state and records without a thread
  // are left alone. A failed stop keeps the record for the next check.
  async removeSettled() {
    const records = this.records().filter(record => record.threadId);
    const removed: { id: string; name: string; threadId: string; status: AgentServerThread['status'] }[] = [];
    const failed: (typeof removed[number] & { error: string })[] = [];
    if (!records.length) return { removed, failed };
    const threads = this.threads.lookup(records.map(record => record.threadId!));
    for (const record of records) {
      const thread = threads.get(record.threadId!);
      if (!thread || !INACTIVE_THREADS.has(thread.status)) continue;
      const item = { id: record.id, name: record.name, threadId: thread.rootId ?? thread.id, status: thread.status };
      try { await this.delete(record.id); removed.push(item); }
      catch (error) { failed.push({ ...item, error: errorMessage(error) }); }
    }
    return { removed, failed };
  }
}
