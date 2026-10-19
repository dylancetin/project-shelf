import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { createApp } from '../server/app';
import { AgentServers } from '../server/agent-servers';
import { agentEnvironment, SystemdAgentSupervisor, type AgentSupervisor, type UnitState } from '../server/agent-supervisor';
import { Store } from '../server/store';
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

describe('agent preview records', () => {
  test('Original hostname falls back to persistent local machine hostname and honors explicit preferences', async () => {
    const root = await fixture();
    let store = new Store(`${root}/panel.sqlite`, { defaultHostname: '' });
    const supervisor = new MockSupervisor();
    let id = '';
    try {
      let servers = new AgentServers(store, supervisor);
      const created = await servers.add({ name: 'Original-host fixture', cwd: root, command: 'fixture' });
      id = created.id;
      expect(new URL(created.url).hostname).toBe(servers.machine.name);
      expect(new URL(created.url).port).toBe(String(created.port));
      const machineHostname = servers.machine.name;
      store.close(); store = new Store(`${root}/panel.sqlite`); servers = new AgentServers(store, supervisor);
      expect((await servers.list())[0]!.url).toBe(`http://${machineHostname}:${created.port}/`);
      store.setValue('settings', { ...store.settings(), defaultHostname: '192.168.1.50' });
      expect((await servers.list())[0]!.url).toBe(`http://192.168.1.50:${created.port}/`);
      await servers.delete(id); id = '';
    } finally {
      if (id) await new AgentServers(store, supervisor).delete(id);
      store.close(); await cleanup(root);
    }
  });
  test('concurrent random reservations, idempotent retry, durable reconciliation, failed stop retention, tombstones', async () => {
    const root = await fixture();
    const supervisor = new MockSupervisor();
    let store = new Store(`${root}/panel.sqlite`);
    try {
      let servers = new AgentServers(store, supervisor);
      const input = { name: 'Fixture', cwd: root, command: 'fixture foreground command', idempotencyKey: 'retry-1' };
      const [a, retry, b] = await Promise.all([servers.add(input), servers.add(input), servers.add({ ...input, idempotencyKey: 'retry-2' })]);
      expect(retry.id).toBe(a.id); expect(supervisor.starts).toBe(2);
      expect(a.port).not.toBe(b.port); expect(a.port).toBeGreaterThanOrEqual(5000); expect(a.port).toBeLessThan(6000);
      await expect(servers.add({ ...input, name: 'Different' })).rejects.toThrow('different inputs');
      store.close(); store = new Store(`${root}/panel.sqlite`); servers = new AgentServers(store, supervisor);
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
    const root = await fixture(); const store = new Store(`${root}/panel.sqlite`); const supervisor = new MockSupervisor();
    try {
      const servers = new AgentServers(store, supervisor); supervisor.failStart = true;
      const input = { name: 'Failure fixture', cwd: root, command: 'not-a-command' };
      await expect(servers.add(input)).rejects.toThrow('record retained');
      expect((await servers.list()).length).toBe(1);
      await servers.add(input); expect(supervisor.starts).toBe(1);
      await expect(servers.add({ ...input, cwd: 'relative' })).rejects.toThrow('absolute');
      await servers.delete((await servers.list())[0]!.id);
    } finally { store.close(); await cleanup(root); }
  });

  test('child environment excludes panel/auth secrets', () => {
    process.env.PANEL_TEST_SECRET = 'private'; process.env.MCP_AUTH_TOKEN = 'private'; process.env.API_PORT = '4959';
    try { const env = agentEnvironment(5432); expect(env).toContain('PORT=5432'); expect(env.join('\n')).not.toContain('private'); expect(env.join('\n')).not.toContain('API_PORT'); }
    finally { delete process.env.PANEL_TEST_SECRET; delete process.env.MCP_AUTH_TOKEN; delete process.env.API_PORT; }
  });
});

test('MCP authenticated stateless official protocol, exact two mutations, concurrent request IDs and resource logs', async () => {
  const root = await fixture(); const supervisor = new MockSupervisor();
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, agentSupervisor: supervisor });
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
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['add', 'delete']);
    const [first, second] = await Promise.all(['one', 'two'].map(key => call('tools/call', { name: 'add', arguments: { name: key, cwd: root, command: 'fixture', idempotencyKey: key } }).then(response => response.json())));
    const a = JSON.parse(first.result.content[0].text); const b = JSON.parse(second.result.content[0].text);
    expect(a.name).toBe('one'); expect(b.name).toBe('two'); expect(a.port).not.toBe(b.port);
    const resource = await (await call('resources/read', { uri: `shelf://agent-servers/${a.id}/logs` })).json();
    expect(resource.result.contents[0].text).toContain('fixture stderr');
    const uiDelete = await app.fetch(new Request(`http://127.0.0.1:4958/api/agent-servers/${a.id}`, { method: 'DELETE', headers: { Origin: 'http://127.0.0.1:4958' } }));
    expect(uiDelete.status).toBe(200);
    expect((await call('tools/call', { name: 'delete', arguments: { id: b.id } })).status).toBe(200);
  } finally { await app.close(); await cleanup(root); }
});

test('official MCP HTTP client initializes, calls tools and reads resources', async () => {
  const root = await fixture();
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false, agentSupervisor: new MockSupervisor() });
  const http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  const client = new Client({ name: 'official-fixture', version: '1' });
  try {
    const { bearerToken } = await Bun.file(`${root}/panel.sqlite.mcp.json`).json();
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } }));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['add', 'delete']);
    const result = await client.callTool({ name: 'add', arguments: { name: 'Official client fixture', cwd: root, command: 'fixture' } });
    expect(result.isError).not.toBe(true);
    const resource = await client.readResource({ uri: 'shelf://agent-servers' });
    expect(JSON.stringify(resource.contents)).toContain('Official client fixture');
    const server = (await app.agentServers.list())[0]!;
    await client.callTool({ name: 'delete', arguments: { id: server.id } });
    expect((await app.agentServers.list()).length).toBe(0);
  } finally { await client.close(); await http.stop(true); await app.close(); await cleanup(root); }
});

// Explicit opt-in: starts only disposable fixture commands, never user projects.
test.skipIf(process.env.SHELF_SYSTEMD_TEST !== '1')('owned IPv6-only listener must not certify a foreign IPv4 HTTP server on the same port', async () => {
  const root = await fixture();
  const app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false });
  const supervisor = new SystemdAgentSupervisor();
  let record: AgentServerRecord | undefined;
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    // First register an owned, non-listening unit, then bind both address
    // families explicitly on its reserved port to reproduce the real collision.
    record = await app.agentServers.add({ name: 'Address-family ownership fixture', cwd: root, command: 'exec sleep 600' });
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
  let app = await createApp({ dbPath, bootstrap: false });
  let id = ''; let pid = 0;
  try {
    const record = await app.agentServers.add({ name: 'Disposable integration preview', cwd: root, command: `exec ${JSON.stringify(process.execPath)} preview.ts`, idempotencyKey: crypto.randomUUID() });
    id = record.id;
    expect(record.status).toBe('running'); expect(record.ready).toBe(true);
    expect(record.pid).toBeGreaterThan(0); pid = Number(await readFile(`${root}/child.pid`, 'utf8'));
    expect(await app.agentServers.logs(id)).toContain('owned fixture ready');
    expect(await app.agentServers.logs(id)).toContain('[stdout] owned fixture ready');
    expect(await app.agentServers.logs(id)).toContain('[stderr] owned fixture stderr');
    const before = record.pid;
    await app.close(); app = await createApp({ dbPath, bootstrap: false });
    const after = (await app.agentServers.list())[0]!;
    expect(after.pid).toBe(before); expect(after.ready).toBe(true);
    const foreign = new SystemdAgentSupervisor();
    await expect(foreign.state({ ...after, machineId: crypto.randomUUID() })).rejects.toThrow('ownership mismatch');
    // Same HTTP listener, wrong control group: readiness must not trust HTTP.
    expect(await foreign.ready(after, { status: 'running', pid: process.pid, diagnostic: '', controlGroup: '/nonexistent-fixture-group' })).toBe(false);
    await app.agentServers.delete(id); id = '';
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 4000);
    expect((await app.agentServers.list()).length).toBe(0);
  } finally {
    if (id) await app.agentServers.delete(id);
    await app.close(); await cleanup(root);
  }
}, 30000);
