import { createHash, randomInt } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { AddAgentServer, AgentServer, AgentServerRecord } from '../shared/agent-servers';
import { ApiError } from './errors';
import type { Store } from './store';
import { SystemdAgentSupervisor, type AgentSupervisor } from './agent-supervisor';

// Shared by app instances in this process. SQLite's unique port index also
// reserves ports across processes; there is no check-then-insert allocation race.
let allocation: Promise<unknown> = Promise.resolve();

export class AgentServers {
  readonly machine: { id: string; name: string };
  constructor(private store: Store, private supervisor: AgentSupervisor = new SystemdAgentSupervisor()) {
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
  async view(record: AgentServerRecord): Promise<AgentServer> {
    let state;
    let ready = false;
    try { state = await this.supervisor.state(record); ready = await this.supervisor.ready(record, state); }
    catch (error) { state = { status: 'unknown' as const, pid: null, diagnostic: String(error) }; }
    return { ...record, machine: this.machine.name, pid: state.pid, status: state.status,
      diagnostic: record.launchError || `${state.diagnostic}${!ready && state.status === 'running' ? '; waiting for an owned HTTP listener on the assigned port, bound to 0.0.0.0' : ''}`, ready,
      url: `http://${this.store.settings().defaultHostname || this.machine.name}:${record.port}/`, logsUrl: `/api/agent-servers/${record.id}/logs` };
  }
  async list() { return Promise.all(this.records().map(record => this.view(this.require(record.id)))); }
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
    const fingerprint = createHash('sha256').update(JSON.stringify([input.name.trim(), cwd, input.command])).digest('hex');
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
        const record: AgentServerRecord = { id, machineId: this.machine.id, name: input.name.trim(), cwd, command: input.command, port, unit: `project-shelf-agent-${id}.service`, createdAt: new Date().toISOString(), requestKey: key };
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
          this.store.db.query('UPDATE agent_servers SET data = ? WHERE id = ?').run(JSON.stringify(record), id);
          throw new ApiError(502, `Agent server ${id} could not start; record retained for logs/Stop at /api/agent-servers/${id}/logs: ${String(error)}`);
        }
        const deadline = Date.now() + 4000;
        let result = await this.view(record);
        while (!result.ready && ['running', 'starting'].includes(result.status) && Date.now() < deadline) {
          await Bun.sleep(150); result = await this.view(record);
        }
        return result;
      }
      throw new ApiError(409, 'No free preview ports in 5000–5999');
    });
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
      return { ok: true };
    });
  }
}
