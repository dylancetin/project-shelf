import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { createApp } from '../server/app';
import { AgentServers } from '../server/agent-servers';
import { agentEnvironment, SystemdAgentSupervisor, type AgentSupervisor, type UnitState } from '../server/agent-supervisor';
import { Store } from '../server/store';
import { T3StateThreads } from '../server/t3-threads';
import type { AgentServerRecord } from '../shared/agent-servers';
import { cleanup, files, fixture, until } from './helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

class MockSupervisor implements AgentSupervisor {
  units = new Map<string, UnitState>();
  starts = 0;
  failStop = false;
  failStart = false;
  async start(record: AgentServerRecord) {
    this.starts++;
    if (this.failStart) throw new Error('Supervisor unavailable');
    this.units.set(record.unit, { status: 'running', pid: 42, controlGroup: '/fixture', diagnostic: 'running' });
  }
  async state(record: AgentServerRecord): Promise<UnitState> { return this.units.get(record.unit) ?? { status: 'stopped', pid: null, controlGroup: '', diagnostic: 'missing' }; }
  async ready() { return true; }
  async logs() { return 'fixture stdout\nfixture stderr'; }
  async stop(record: AgentServerRecord) { if (this.failStop) throw new Error('stop failed'); this.units.delete(record.unit); }
}

const THREAD = 'fixture-thread';

interface FixtureThread { title?: string; parent?: string; relationship?: 'subagent' | 'fork'; root?: string; settled?: boolean; archived?: boolean; deleted?: boolean }

// A disposable copy of the T3 Code thread projection columns Project Shelf reads.
async function t3Fixture(root: string) {
  const home = `${root}/t3`;
  await files(home, { 'userdata/environment-id': 'fixture-env\n' });
  const filename = `${home}/userdata/statev2.sqlite`;
  const setup = new Database(filename);
  setup.exec(`PRAGMA journal_mode = WAL; CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL)`);
  setup.close();
  const now = new Date().toISOString();
  function thread(id: string, value: FixtureThread = {}) {
    const title = value.title ?? `Thread ${id}`;
    const payload = {
      id, title, settledOverride: value.settled ? 'settled' : null, settledAt: value.settled ? now : null,
      archivedAt: value.archived ? now : null, deletedAt: value.deleted ? now : null,
      lineage: { parentThreadId: value.parent ?? null, relationshipToParent: value.parent ? value.relationship ?? 'subagent' : null, rootThreadId: value.root ?? value.parent ?? id },
    };
    const db = new Database(filename);
    try {
      db.query('INSERT OR REPLACE INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'fixture-project', title, now, now, value.archived ? now : null, value.deleted ? now : null, JSON.stringify(payload));
    } finally { db.close(); }
  }
  thread(THREAD, { title: 'Fixture thread' });
  return { home, filename, thread, threads: new T3StateThreads(home) };
}

describe('T3 Code thread state', () => {
  test('resolves subagents to their top-level thread, keeps forks separate, and maps settled/archived/deleted', async () => {
    const root = await fixture();
    try {
      const t3 = await t3Fixture(root);
      const delegated = 'thread:delegated-task:command%3Amcp%3Afixture';
      t3.thread('parent', { title: 'Parent work' });
      t3.thread(delegated, { parent: 'parent' });
      t3.thread('nested', { parent: delegated, root: 'parent' });
      t3.thread('original', { settled: true });
      t3.thread('fork', { parent: 'original', relationship: 'fork' });
      t3.thread('orphan', { parent: 'gone' });
      t3.thread('settled', { settled: true }); t3.thread('archived', { archived: true }); t3.thread('deleted', { archived: true, deleted: true });
      const result = t3.threads.lookup([delegated, 'nested', 'fork', 'orphan', 'settled', 'archived', 'deleted', 'unknown']);
      expect(result.get(delegated)).toEqual({ id: delegated, rootId: 'parent', title: 'Parent work', status: 'active', link: 't3code://threads/fixture-env/parent' });
      expect(result.get('nested')).toMatchObject({ rootId: 'parent', status: 'active' });
      // T3 Code records a fork's original as its lineage root; the fork is still its own thread.
      expect(result.get('fork')).toMatchObject({ rootId: 'fork', status: 'active' });
      expect(result.get('orphan')).toMatchObject({ rootId: 'gone', status: 'missing', link: null });
      expect(['settled', 'archived', 'deleted'].map(id => result.get(id)!.status)).toEqual(['settled', 'archived', 'deleted']);
      expect(result.has('unknown')).toBe(false);
      expect(t3.threads.lookup([delegated]).get(delegated)!.id).toBe(delegated);
      // T3 Code keeps its database open in WAL mode; committed changes must be visible to a fresh read.
      const writer = new Database(t3.filename);
      try {
        writer.query(`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.settledOverride', 'settled') WHERE thread_id = 'parent'`).run();
        expect(t3.threads.lookup(['nested']).get('nested')!.status).toBe('settled');
      } finally { writer.close(); }
      expect(() => new T3StateThreads(`${root}/missing-home`).lookup([THREAD])).toThrow();
      expect(new T3StateThreads(`${root}/missing-home`).lookup([]).size).toBe(0);
    } finally { await cleanup(root); }
  });
});

describe('agent preview records', () => {
  test('Original hostname falls back to persistent local machine hostname and honors explicit preferences', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root);
    let store = new Store(`${root}/panel.sqlite`, { defaultHostname: '' });
    const supervisor = new MockSupervisor();
    let id = '';
    try {
      let servers = new AgentServers(store, supervisor, t3.threads);
      const created = await servers.add({ name: 'Original-host fixture', cwd: root, command: 'fixture', threadId: THREAD });
      id = created.id;
      expect(new URL(created.url).hostname).toBe(servers.machine.name);
      expect(new URL(created.url).port).toBe(String(created.port));
      const machineHostname = servers.machine.name;
      store.close(); store = new Store(`${root}/panel.sqlite`); servers = new AgentServers(store, supervisor, t3.threads);
      expect((await servers.list())[0]!.url).toBe(`http://${machineHostname}:${created.port}/`);
      store.setValue('settings', { ...store.settings(), defaultHostname: '192.168.1.50' });
      expect((await servers.list())[0]!.url).toBe(`http://192.168.1.50:${created.port}/`);
      await servers.delete(id); id = '';
    } finally {
      if (id) await new AgentServers(store, supervisor, t3.threads).delete(id);
      store.close(); await cleanup(root);
    }
  });
  test('concurrent random reservations, idempotent retry, durable reconciliation, failed stop retention, tombstones', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root);
    const supervisor = new MockSupervisor();
    let store = new Store(`${root}/panel.sqlite`);
    try {
      let servers = new AgentServers(store, supervisor, t3.threads);
      const input = { name: 'Fixture', cwd: root, command: 'fixture foreground command', threadId: THREAD, idempotencyKey: 'retry-1' };
      const [a, retry, b] = await Promise.all([servers.add(input), servers.add(input), servers.add({ ...input, idempotencyKey: 'retry-2' })]);
      expect(retry.id).toBe(a.id); expect(supervisor.starts).toBe(2);
      expect(a.port).not.toBe(b.port); expect(a.port).toBeGreaterThanOrEqual(5000); expect(a.port).toBeLessThan(6000);
      await expect(servers.add({ ...input, name: 'Different' })).rejects.toThrow('different inputs');
      store.close(); store = new Store(`${root}/panel.sqlite`); servers = new AgentServers(store, supervisor, t3.threads);
      expect((await servers.list()).map(item => item.id)).toContain(a.id);
      expect((await servers.add(input)).id).toBe(a.id); expect(supervisor.starts).toBe(2);
      supervisor.failStop = true;
      await expect(servers.delete(a.id)).rejects.toThrow('stop failed');
      expect((await servers.list()).some(item => item.id === a.id)).toBe(true);
      supervisor.failStop = false; await servers.delete(a.id); await servers.delete(a.id);
      await expect(servers.add(input)).rejects.toThrow('deleted');
      supervisor.units.clear();
      expect((await servers.list())[0]?.status).toBe('stopped');
      await servers.delete(b.id);
    } finally { store.close(); await cleanup(root); }
  });

  test('failed launches remain inspectable, retry never starts duplicates, invalid cwd rejected', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root); const store = new Store(`${root}/panel.sqlite`); const supervisor = new MockSupervisor();
    try {
      const servers = new AgentServers(store, supervisor, t3.threads); supervisor.failStart = true;
      const input = { name: 'Failure fixture', cwd: root, command: 'not-a-command', threadId: THREAD };
      await expect(servers.add(input)).rejects.toThrow('record retained');
      expect((await servers.list()).length).toBe(1);
      await servers.add(input); expect(supervisor.starts).toBe(1);
      await expect(servers.add({ ...input, cwd: 'relative' })).rejects.toThrow('absolute');
      await servers.delete((await servers.list())[0]!.id);
    } finally { store.close(); await cleanup(root); }
  });

  test('restart keeps identity and URL, and never starts over a failed stop or an occupied port', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root); const store = new Store(`${root}/panel.sqlite`); const supervisor = new MockSupervisor();
    let id = '';
    try {
      const servers = new AgentServers(store, supervisor, t3.threads);
      const created = await servers.add({ name: 'Restart fixture', cwd: root, command: 'fixture', threadId: THREAD });
      id = created.id;
      expect(await servers.restart(id)).toMatchObject({ id, port: created.port, url: created.url, unit: created.unit, status: 'running', ready: true, threadId: THREAD });
      expect(supervisor.starts).toBe(2);
      // The old process tree is still owned: never launch a second copy beside it.
      supervisor.failStop = true;
      await expect(servers.restart(id)).rejects.toThrow('not restarted');
      expect(supervisor.starts).toBe(2);
      supervisor.failStop = false;
      // After a reboot the unit is gone; the persisted record relaunches.
      supervisor.units.clear();
      expect((await servers.restart(id)).status).toBe('running');
      expect(supervisor.starts).toBe(3);
      // A foreign program took the port while it was down: leave it alone.
      const occupant = Bun.listen({ hostname: '0.0.0.0', port: created.port, socket: { data() {} } });
      try {
        await expect(servers.restart(id)).rejects.toThrow('in use by another process');
        expect(supervisor.starts).toBe(3);
        const blocked = (await servers.list()).find(item => item.id === id)!;
        expect(blocked.status).toBe('stopped'); expect(blocked.diagnostic).toContain('Restart blocked');
      } finally { occupant.stop(true); }
      supervisor.failStart = true;
      await expect(servers.restart(id)).rejects.toThrow('could not restart');
      expect((await servers.list()).find(item => item.id === id)!.diagnostic).toContain('Restart failed');
      supervisor.failStart = false;
      const recovered = await servers.restart(id);
      expect(recovered.launchError).toBeUndefined(); expect(recovered.status).toBe('running');
      expect((await servers.list()).length).toBe(1);
      await expect(servers.restart(crypto.randomUUID())).rejects.toThrow('not found');
      await servers.delete(id); id = '';
      await expect(servers.restart(created.id)).rejects.toThrow('not found');
    } finally {
      if (id) await new AgentServers(store, supervisor, t3.threads).delete(id);
      store.close(); await cleanup(root);
    }
  });

  test('add requires an active T3 thread and never shares a preview across threads', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root); const store = new Store(`${root}/panel.sqlite`); const supervisor = new MockSupervisor();
    try {
      const servers = new AgentServers(store, supervisor, t3.threads);
      const input = { name: 'Owned fixture', cwd: root, command: 'fixture' };
      await expect(servers.add(input as never)).rejects.toThrow('threadId is required');
      await expect(servers.add({ ...input, threadId: 'not a thread id' })).rejects.toThrow('threadId is required');
      await expect(servers.add({ ...input, threadId: 'unknown-thread' })).rejects.toThrow('Unknown T3 Code thread');
      t3.thread('settled-parent', { settled: true }); t3.thread('late-subagent', { parent: 'settled-parent' });
      await expect(servers.add({ ...input, threadId: 'late-subagent' })).rejects.toThrow('settled-parent is settled');
      await expect(new AgentServers(store, supervisor, new T3StateThreads(`${root}/missing-home`)).add({ ...input, threadId: THREAD })).rejects.toThrow('Could not read T3 Code threads');
      expect(supervisor.starts).toBe(0);
      t3.thread('other-thread');
      const mine = await servers.add({ ...input, threadId: THREAD });
      expect((await servers.add({ ...input, threadId: THREAD })).id).toBe(mine.id);
      const theirs = await servers.add({ ...input, threadId: 'other-thread' });
      expect(theirs.id).not.toBe(mine.id); expect(theirs.port).not.toBe(mine.port);
      expect(theirs.thread).toEqual({ id: 'other-thread', rootId: 'other-thread', title: 'Thread other-thread', status: 'active', link: 't3code://threads/fixture-env/other-thread' });
      // An unreadable T3 state still lists previews; it only hides thread details.
      const blind = await new AgentServers(store, supervisor, new T3StateThreads(`${root}/missing-home`)).list();
      expect(blind.map(item => item.thread?.status)).toEqual(['unavailable', 'unavailable']);
      for (const item of await servers.list()) await servers.delete(item.id);
    } finally { store.close(); await cleanup(root); }
  });

  test('settled, archived or deleted top-level threads fully remove their previews; nothing else is touched', async () => {
    const root = await fixture(); const t3 = await t3Fixture(root); const store = new Store(`${root}/panel.sqlite`); const supervisor = new MockSupervisor();
    try {
      const servers = new AgentServers(store, supervisor, t3.threads);
      for (const id of ['parent', 'archived', 'deleted', 'vanishing', 'legacy']) t3.thread(id);
      t3.thread('subagent', { parent: 'parent' });
      const add = (name: string, threadId: string) => servers.add({ name, cwd: root, command: 'fixture', threadId, idempotencyKey: name.replaceAll(' ', '-') });
      const fromSubagent = await add('subagent preview', 'subagent');
      const archived = await add('archived preview', 'archived');
      const deleted = await add('deleted preview', 'deleted');
      const vanishing = await add('vanishing preview', 'vanishing');
      const legacy = await add('legacy preview', 'legacy');
      // Records created before thread ownership have no threadId.
      store.db.query(`UPDATE agent_servers SET data = json_remove(data, '$.threadId') WHERE id = ?`).run(legacy.id);
      t3.thread('legacy', { settled: true });
      expect((await servers.removeSettled()).removed).toEqual([]);
      // Settling the subagent's own thread does not matter while its parent is in use.
      t3.thread('subagent', { parent: 'parent', settled: true });
      expect((await servers.removeSettled()).removed).toEqual([]);
      t3.thread('parent', { settled: true }); t3.thread('archived', { archived: true }); t3.thread('deleted', { deleted: true });
      const t3db = new Database(t3.filename);
      try { t3db.query(`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'vanishing'`).run(); } finally { t3db.close(); }
      supervisor.failStop = true;
      const failed = await servers.removeSettled();
      expect(failed.removed).toEqual([]);
      expect(failed.failed.map(item => item.id).sort()).toEqual([fromSubagent.id, archived.id, deleted.id].sort());
      expect((await servers.list()).length).toBe(5);
      supervisor.failStop = false;
      const result = await servers.removeSettled();
      expect(result.failed).toEqual([]);
      expect(result.removed.find(item => item.id === fromSubagent.id)).toEqual({ id: fromSubagent.id, name: 'subagent preview', threadId: 'parent', status: 'settled' });
      expect(result.removed.map(item => item.status).sort()).toEqual(['archived', 'deleted', 'settled']);
      const remaining = await servers.list();
      expect(remaining.map(item => item.id).sort()).toEqual([vanishing.id, legacy.id].sort());
      expect(remaining.find(item => item.id === vanishing.id)!.thread!.status).toBe('missing');
      expect(remaining.find(item => item.id === legacy.id)!.thread).toBeNull();
      for (const item of [fromSubagent, archived, deleted]) expect(supervisor.units.has(item.unit)).toBe(false);
      // Full deletion tombstones the request, so a delayed retry cannot resurrect it.
      t3.thread('parent');
      await expect(add('subagent preview', 'subagent')).rejects.toThrow('deleted');
      // Unreadable T3 state skips the check instead of guessing.
      await expect(new AgentServers(store, supervisor, new T3StateThreads(`${root}/missing-home`)).removeSettled()).rejects.toThrow();
      expect((await servers.list()).length).toBe(2);
      for (const item of remaining) await servers.delete(item.id);
    } finally { store.close(); await cleanup(root); }
  });

  test('child environment excludes panel/auth secrets', () => {
    process.env.PANEL_TEST_SECRET = 'private'; process.env.MCP_AUTH_TOKEN = 'private'; process.env.API_PORT = '4959';
    try { const env = agentEnvironment(5432); expect(env).toContain('PORT=5432'); expect(env.join('\n')).not.toContain('private'); expect(env.join('\n')).not.toContain('API_PORT'); }
    finally { delete process.env.PANEL_TEST_SECRET; delete process.env.MCP_AUTH_TOKEN; delete process.env.API_PORT; }
  });
});

test('MCP authenticated stateless official protocol, tool discovery, concurrent request IDs and resource logs', async () => {
  const root = await fixture(); const supervisor = new MockSupervisor(); const t3 = await t3Fixture(root);
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, agentSupervisor: supervisor, t3Threads: t3.threads });
  try {
    const credential = JSON.parse(await readFile(`${root}/panel.sqlite.mcp.json`, 'utf8')).bearerToken;
    expect((await stat(`${root}/panel.sqlite.mcp.json`)).mode & 0o777).toBe(0o600);
    const call = (method: string, params = {}, headers: Record<string, string> = {}, host = '127.0.0.1') => app.fetch(new Request(`http://${host}:4958/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${credential}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    expect((await call('tools/list', {}, { Authorization: '' })).status).toBe(401);
    expect((await call('tools/list', {}, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('tools/list', {}, {}, 'evil.test')).status).toBe(403);
    expect((await call('tools/list', {}, { Host: 'evil.test:4958' })).status).toBe(403);
    const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    expect(init.status).toBe(200); expect((await init.json()).result.serverInfo.name).toBe('project-shelf-agent-servers');
    const listed = await (await call('tools/list')).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['add', 'delete', 'project_logs', 'project_run', 'projects_list', 'restart']);
    const [first, second] = await Promise.all(['one', 'two'].map(key => call('tools/call', { name: 'add', arguments: { name: key, cwd: root, command: 'fixture', threadId: THREAD, idempotencyKey: key } }).then(response => response.json())));
    const a = JSON.parse(first.result.content[0].text); const b = JSON.parse(second.result.content[0].text);
    expect(a.name).toBe('one'); expect(b.name).toBe('two'); expect(a.port).not.toBe(b.port);
    expect(a.thread).toMatchObject({ id: THREAD, rootId: THREAD, title: 'Fixture thread', status: 'active' });
    const unowned = await (await call('tools/call', { name: 'add', arguments: { name: 'unowned', cwd: root, command: 'fixture' } })).json();
    expect(unowned.result.isError).toBe(true);
    const resource = await (await call('resources/read', { uri: `shelf://agent-servers/${a.id}/logs` })).json();
    expect(resource.result.contents[0].text).toContain('fixture stderr');
    const uiDelete = await app.fetch(new Request(`http://127.0.0.1:4958/api/agent-servers/${a.id}`, { method: 'DELETE', headers: { Origin: 'http://127.0.0.1:4958' } }));
    expect(uiDelete.status).toBe(200);
    expect((await call('tools/call', { name: 'delete', arguments: { id: b.id } })).status).toBe(200);
  } finally { await app.close(); await cleanup(root); }
});

test('the periodic T3 thread check removes previews of settled threads and stops with the app', async () => {
  const root = await fixture(); const t3 = await t3Fixture(root); const supervisor = new MockSupervisor();
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, agentSupervisor: supervisor, t3Threads: t3.threads, agentThreadCheckMs: 40 });
  try {
    t3.thread('kept');
    const settled = await app.agentServers.add({ name: 'Settled thread preview', cwd: root, command: 'fixture', threadId: THREAD });
    const kept = await app.agentServers.add({ name: 'Active thread preview', cwd: root, command: 'fixture', threadId: 'kept' });
    await Bun.sleep(150);
    expect((await app.agentServers.list()).length).toBe(2);
    t3.thread(THREAD, { settled: true });
    await until(async () => (await app.agentServers.list()).length === 1, 3000);
    expect((await app.agentServers.list())[0]!.id).toBe(kept.id);
    expect(supervisor.units.has(settled.unit)).toBe(false);
    await app.agentServers.delete(kept.id);
  } finally { await app.close(); await cleanup(root); }
});

test('official MCP HTTP client initializes, calls tools and reads resources', async () => {
  const root = await fixture(); const t3 = await t3Fixture(root);
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, agentSupervisor: new MockSupervisor(), t3Threads: t3.threads });
  const http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  const client = new Client({ name: 'official-fixture', version: '1' });
  try {
    const { bearerToken } = await Bun.file(`${root}/panel.sqlite.mcp.json`).json();
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } }));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['add', 'delete', 'project_logs', 'project_run', 'projects_list', 'restart']);
    const result = await client.callTool({ name: 'add', arguments: { name: 'Official client fixture', cwd: root, command: 'fixture', threadId: THREAD } });
    expect(result.isError).not.toBe(true);
    const resource = await client.readResource({ uri: 'shelf://agent-servers' });
    expect(JSON.stringify(resource.contents)).toContain('Official client fixture');
    const server = (await app.agentServers.list())[0]!;
    const restarted = await client.callTool({ name: 'restart', arguments: { id: server.id } });
    expect(restarted.isError).not.toBe(true);
    expect(JSON.parse((restarted.content as { text: string }[])[0]!.text)).toMatchObject({ id: server.id, port: server.port, url: server.url });
    const missing = await client.callTool({ name: 'restart', arguments: { id: crypto.randomUUID() } });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]!.text).toContain('not found');
    await client.callTool({ name: 'delete', arguments: { id: server.id } });
    expect((await app.agentServers.list()).length).toBe(0);
  } finally { await client.close(); await http.stop(true); await app.close(); await cleanup(root); }
});

// Explicit opt-in: starts only disposable fixture commands, never user projects.
test.skipIf(process.env.SHELF_SYSTEMD_TEST !== '1')('owned IPv6-only listener must not certify a foreign IPv4 HTTP server on the same port', async () => {
  const root = await fixture(); const t3 = await t3Fixture(root);
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, t3Threads: t3.threads });
  const supervisor = new SystemdAgentSupervisor();
  let record: AgentServerRecord | undefined;
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    // First register an owned, non-listening unit, then bind both address
    // families explicitly on its reserved port to reproduce the real collision.
    record = await app.agentServers.add({ name: 'Address-family ownership fixture', cwd: root, command: 'exec sleep 600', threadId: THREAD });
    await supervisor.stop(record);
    foreign = Bun.serve({ hostname: '0.0.0.0', port: record.port, fetch: () => new Response('foreign IPv4 response') });
    await files(root, { 'ipv6-only.ts': `import { createServer } from 'node:net'; const server = createServer(socket => socket.end('owned IPv6-only listener')); server.listen({ host: '::', port: Number(process.env.PORT), ipv6Only: true }, () => console.log('IPv6-only bound'));` });
    // Reuse only this test-owned generated record and unit; never adopt a PID.
    await supervisor.start({ ...record, command: `exec ${JSON.stringify(process.execPath)} ipv6-only.ts` });
    await until(async () => (await supervisor.logs(record!)).includes('IPv6-only bound'));
    const state = await supervisor.state(record);
    expect(state.status).toBe('running');
    expect(await (await fetch(`http://127.0.0.1:${record.port}/`)).text()).toBe('foreign IPv4 response');
    expect(await supervisor.ready(record, state)).toBe(false);
    expect((await app.agentServers.list())[0]!.ready).toBe(false);
  } finally {
    if (record) await app.agentServers.delete(record.id);
    if (foreign) await foreign.stop(true);
    await app.close(); await cleanup(root);
  }
}, 30000);

test.skipIf(process.env.SHELF_SYSTEMD_TEST !== '1')('real independent unit survives panel close/reopen; socket ownership, journal and descendant cleanup', async () => {
  const root = await fixture(); const dbPath = `${root}/panel.sqlite`;
  await files(root, { 'preview.ts': `const child = Bun.spawn(['/bin/sh', '-c', 'sleep 600'], {stdout:'ignore',stderr:'ignore'}); await Bun.write('child.pid', String(child.pid)); console.log('owned fixture ready'); console.error('owned fixture stderr'); Bun.serve({port:Number(process.env.PORT),hostname:'0.0.0.0',fetch:()=>new Response('fixture preview')});` });
  const t3 = await t3Fixture(root);
  let app = await createApp({ dbPath, bootstrap: false, t3Threads: t3.threads });
  let id = ''; let pid = 0;
  try {
    const record = await app.agentServers.add({ name: 'Disposable integration preview', cwd: root, command: `exec ${JSON.stringify(process.execPath)} preview.ts`, threadId: THREAD, idempotencyKey: crypto.randomUUID() });
    id = record.id;
    expect(record.status).toBe('running'); expect(record.ready).toBe(true);
    expect(record.pid).toBeGreaterThan(0); pid = Number(await readFile(`${root}/child.pid`, 'utf8'));
    expect(await app.agentServers.logs(id)).toContain('owned fixture ready');
    expect(await app.agentServers.logs(id)).toContain('[stdout] owned fixture ready');
    expect(await app.agentServers.logs(id)).toContain('[stderr] owned fixture stderr');
    const before = record.pid;
    await app.close(); app = await createApp({ dbPath, bootstrap: false, t3Threads: t3.threads });
    const after = (await app.agentServers.list())[0]!;
    expect(after.pid).toBe(before); expect(after.ready).toBe(true);
    const foreign = new SystemdAgentSupervisor();
    await expect(foreign.state({ ...after, machineId: crypto.randomUUID() })).rejects.toThrow('ownership mismatch');
    // Same HTTP listener, wrong control group: readiness must not trust HTTP.
    expect(await foreign.ready(after, { status: 'running', pid: process.pid, diagnostic: '', controlGroup: '/nonexistent-fixture-group' })).toBe(false);
    // Restart stops the whole old control group, including the descendant,
    // then relaunches the same command on the same port and URL.
    const restarted = await app.agentServers.restart(id);
    expect(restarted.port).toBe(after.port); expect(restarted.url).toBe(after.url);
    expect(restarted.pid).toBeGreaterThan(0); expect(restarted.pid).not.toBe(before);
    expect(restarted.status).toBe('running'); expect(restarted.ready).toBe(true);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 4000);
    pid = Number(await readFile(`${root}/child.pid`, 'utf8'));
    expect(await (await fetch(`http://127.0.0.1:${restarted.port}/`)).text()).toBe('fixture preview');
    await app.agentServers.delete(id); id = '';
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 4000);
    expect((await app.agentServers.list()).length).toBe(0);
  } finally {
    if (id) await app.agentServers.delete(id);
    await app.close(); await cleanup(root);
  }
}, 30000);
