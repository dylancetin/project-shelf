import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
import { cleanup, FakeCloudflare, files, fixture, project, request, shellCommand } from './helpers';

const HOSTNAME = /^[a-z]+-[a-z]+-[a-z]+-tunnel\.example\.com$/;

describe('persistent Cloudflare tunnels for managed projects (fake Cloudflare API)', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>> | null;
  let cf: FakeCloudflare;
  let port: number;
  let dbPath: string;

  async function open(extra: Record<string, unknown> = {}) {
    app = await createApp({ dbPath, bootstrap: false, initialSettings: { roots: [] }, processOptions: { stopGraceMs: 150 }, launchOptions: { timeoutMs: 3000 },
      tunnelOptions: cf.options(extra) });
    await app.tunnels.idle();
    return app;
  }
  beforeEach(async () => {
    root = await fixture();
    dbPath = path.join(root, 'panel.sqlite');
    cf = new FakeCloudflare();
    const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('reserved') });
    port = reservation.port!;
    await reservation.stop(true);
    await files(root, { 'dev.ts': `Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch: () => new Response('fixture') });` });
  });
  afterEach(async () => { await app?.close(); app = null; cf.stop(); await cleanup(root); });

  async function running(overrides: Parameters<typeof project>[1] = {}) {
    const item = project(root, { port, devCommand: shellCommand(path.join(root, 'dev.ts')), ...overrides });
    app!.store.insert(item);
    expect((await app!.fetch(request(`/api/projects/${item.id}/launch`, 'POST', {}))).status).toBe(200);
    return item;
  }
  const tunnel = (id: string, method = 'POST') => app!.fetch(request(`/api/projects/${id}/tunnel`, method, method === 'POST' ? {} : undefined));
  const patch = (id: string, data: unknown) => app!.fetch(request(`/api/projects/${id}`, 'PATCH', data));
  const hostOf = (url: string) => new URL(url).hostname;

  test('opens a stable three-word hostname routed to the local port through the named tunnel', async () => {
    await open();
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.tunnel).toMatchObject({ status: 'running', allowedEmails: [], port });
    const host = hostOf(result.tunnel.url);
    expect(host).toMatch(HOSTNAME);
    expect(result.project.runtime.tunnel).toEqual(result.tunnel);
    expect(cf.tunnels).toEqual([{ id: expect.any(String), name: 'project-shelf' }]);
    expect(cf.routes()).toEqual([{ hostname: host, service: `http://127.0.0.1:${port}` }]);
    expect(cf.record(host)).toMatchObject({ type: 'CNAME', content: `${cf.tunnels[0]!.id}.cfargotunnel.com`, proxied: true });
    expect(cf.app(host)).toBeNull(); // public: no Access app
    expect(cf.connector).toMatchObject({ running: true, token: `fixture-tunnel-token-${cf.tunnels[0]!.id}` });
    // Opening again re-applies and keeps the same hostname and record.
    expect((await (await tunnel(item.id)).json()).tunnel.url).toBe(result.tunnel.url);
    expect(cf.dns).toHaveLength(1);
    expect(cf.tunnels).toHaveLength(1);
  });

  test('only the user closes it: stop, restart and exits keep the link', async () => {
    await open();
    const item = await running();
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    const stopped = await (await app!.fetch(request(`/api/projects/${item.id}/stop`, 'POST', {}))).json();
    expect(stopped.project.runtime.status).toBe('stopped');
    expect(stopped.project.runtime.tunnel).toMatchObject({ url: opened.url, status: 'running' });
    expect(cf.routes()).toHaveLength(1);
    expect(cf.connector.running).toBe(true);
    // While stopped the open tunnel can still re-apply its access.
    expect((await tunnel(item.id)).status).toBe(200);
    const restarted = await (await app!.fetch(request(`/api/projects/${item.id}/restart`, 'POST', { mode: 'dev' }))).json();
    expect(restarted.project.runtime.tunnel.url).toBe(opened.url);
  });

  test('closing removes DNS, route and access, stops the idle connector, and reopening keeps the name', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    const host = hostOf(opened.url);
    expect(cf.app(host)?.rules).toEqual(['me@example.com']);
    const closed = await (await tunnel(item.id, 'DELETE')).json();
    expect(closed.project.runtime).toMatchObject({ status: 'running', tunnel: null });
    expect(cf.record(host)).toBeNull();
    expect(cf.routes()).toEqual([]);
    expect(cf.app(host)).toBeNull();
    expect(cf.connector.running).toBe(false);
    expect((await tunnel(item.id, 'DELETE')).status).toBe(200); // repeated close is safe
    const reopened = await (await tunnel(item.id)).json();
    expect(reopened.tunnel.url).toBe(opened.url);
    expect(cf.app(host)?.rules).toEqual(['me@example.com']);
  });

  test('a protected hostname gets its Access app before it becomes reachable', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['you@example.com', '*@team.example.org'] });
    const result = await (await tunnel(item.id)).json();
    expect(result.tunnel.allowedEmails).toEqual(['you@example.com', '*@team.example.org']);
    expect(cf.app(hostOf(result.tunnel.url))?.rules).toEqual(['you@example.com', '*@team.example.org']);
    const order = (step: string) => cf.calls.indexOf(step);
    expect(order('POST /access/apps')).toBeLessThan(order('PUT /cfd_tunnel/:id/configurations'));
    expect(order('PUT /cfd_tunnel/:id/configurations')).toBeLessThan(order('POST /dns_records'));
  });

  test('a new Access app guards the hostname with a 503 until Cloudflare enforces it', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    const created = new Promise<string>(resolve => {
      const timer = setInterval(() => { const app = cf.apps[0]; if (app) { clearInterval(timer); cf.propagating.add(app.domain); resolve(app.domain); } }, 2);
    });
    const pending = tunnel(item.id);
    const host = await created;
    await Bun.sleep(150);
    expect(cf.routes()).toEqual([{ hostname: host, service: 'http_status:503' }]);
    expect(app!.tunnels.get(`project:${item.id}`)?.status).toBe('starting');
    cf.propagating.clear();
    expect((await pending).status).toBe(200);
    expect(cf.routes()).toEqual([{ hostname: host, service: `http://127.0.0.1:${port}` }]);
    // Making an open public tunnel protected guards it again until the new app applies.
    await patch(item.id, { tunnelAccessMode: 'public' });
    cf.propagating.add(host);
    await patch(item.id, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    expect(cf.routes()).toEqual([{ hostname: host, service: 'http_status:503' }]);
    cf.propagating.clear();
    for (let i = 0; i < 100 && cf.routes()[0]!.service === 'http_status:503'; i++) await Bun.sleep(20);
    expect(cf.routes()).toEqual([{ hostname: host, service: `http://127.0.0.1:${port}` }]);
  });

  test('Access that never applies keeps the 503 and reports it', async () => {
    await open({ accessTimeoutMs: 200 });
    cf.propagating.add('*');
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    const probe = cf.enforced.bind(cf);
    cf.enforced = () => false;
    const response = await tunnel(item.id);
    expect(response.status).toBe(504);
    expect(cf.routes()[0]!.service).toBe('http_status:503');
    expect(app!.tunnels.get(`project:${item.id}`)?.error).toContain('answers 503');
    cf.enforced = probe;
    cf.propagating.clear();
    expect((await tunnel(item.id)).status).toBe(200);
    expect(cf.routes()[0]!.service).toBe(`http://127.0.0.1:${port}`);
    expect(app!.tunnels.get(`project:${item.id}`)?.error).toBeUndefined();
  });

  test('access changes apply to the open tunnel in place, without changing its link', async () => {
    await open();
    const item = await running();
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    const host = hostOf(opened.url);
    let saved = await (await patch(item.id, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['Me@Example.com'] })).json();
    expect(saved.project.runtime.tunnel).toMatchObject({ url: opened.url, allowedEmails: ['me@example.com'] });
    expect(cf.app(host)?.rules).toEqual(['me@example.com']);
    const appId = cf.app(host)!.id;
    saved = await (await patch(item.id, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['other@example.com'] })).json();
    expect(cf.app(host)).toEqual({ id: appId, domain: host, rules: ['other@example.com'] });
    // Inherit falls back to the Settings default, and a Settings change follows.
    await patch(item.id, { tunnelAccessMode: 'inherit' });
    expect(cf.app(host)).toBeNull();
    expect((await app!.fetch(request('/api/settings', 'PATCH', { tunnelAllowedEmails: ['default@example.com'] }))).status).toBe(200);
    expect(cf.app(host)?.rules).toEqual(['default@example.com']);
    // A same-folder peer with its own list now decides for the inheriting project.
    const created = await app!.fetch(request('/api/projects', 'POST', { name: 'Peer', kind: 'project', directory: root, tunnelAccessMode: 'custom', tunnelAllowedEmails: ['peer@example.com'] }));
    expect(created.status).toBe(201);
    expect(cf.app(host)?.rules).toEqual(['peer@example.com']);
    expect(app!.tunnels.get(`project:${item.id}`)).toMatchObject({ url: opened.url, allowedEmails: ['peer@example.com'] });
  });

  test('a failed access update is reported on the tunnel and applied by opening again', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    cf.fail.add('PUT /access/apps/:id');
    const saved = await (await patch(item.id, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['new@example.com'] })).json();
    expect(saved.project.runtime.tunnel).toMatchObject({ allowedEmails: ['me@example.com'], error: expect.stringContaining('fixture failure') });
    expect(saved.project.tunnelAccess.allowedEmails).toEqual(['new@example.com']);
    cf.fail.clear();
    const applied = await (await tunnel(item.id)).json();
    expect(applied.tunnel).toMatchObject({ url: opened.url, allowedEmails: ['new@example.com'] });
    expect(applied.tunnel.error).toBeUndefined();
    expect(cf.app(hostOf(opened.url))?.rules).toEqual(['new@example.com']);
  });

  test('a changed project port reroutes the open tunnel', async () => {
    await open();
    const item = await running();
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    await app!.fetch(request(`/api/projects/${item.id}/stop`, 'POST', {}));
    expect((await patch(item.id, { port: port + 1 })).status).toBe(200);
    expect(cf.routes()).toEqual([{ hostname: hostOf(opened.url), service: `http://127.0.0.1:${port + 1}` }]);
  });

  test('open tunnels survive a panel restart and are restored from the database', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    const host = hostOf(opened.url);
    await app!.close();
    app = null;
    // Shutdown leaves everything in place.
    expect(cf.connector.running).toBe(true);
    expect(cf.record(host)).not.toBeNull();
    // Simulate a reboot: the connector is gone and the routes were lost.
    cf.connector.running = false;
    cf.ingress.clear();
    await open();
    expect(app!.tunnels.get(`project:${item.id}`)).toMatchObject({ url: opened.url, status: 'running', allowedEmails: ['me@example.com'] });
    expect(cf.routes()).toEqual([{ hostname: host, service: `http://127.0.0.1:${port}` }]);
    expect(cf.connector.running).toBe(true);
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.apps).toHaveLength(1);
  });

  test('restoring closes tunnels whose registration is gone, and stops an idle connector', async () => {
    await open();
    const item = await running();
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    await app!.close();
    app = null;
    // Removed behind the panel's back (for example a hand-edited database).
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.query('DELETE FROM projects WHERE id = ?').run(item.id);
    db.close();
    await open();
    expect(cf.record(hostOf(opened.url))).toBeNull();
    expect(cf.routes()).toEqual([]);
    expect(cf.connector.running).toBe(false);
  });

  test('deleting a project closes its tunnel', async () => {
    await open();
    const item = await running();
    const { tunnel: opened } = await (await tunnel(item.id)).json();
    expect((await app!.fetch(request(`/api/projects/${item.id}`, 'DELETE'))).status).toBe(200);
    expect(cf.record(hostOf(opened.url))).toBeNull();
    expect(cf.routes()).toEqual([]);
  });

  test('a failed open leaves nothing behind in Cloudflare', async () => {
    await open();
    const item = await running({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['me@example.com'] });
    cf.fail.add('POST /dns_records');
    const response = await tunnel(item.id);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('create the DNS record');
    expect(app!.tunnels.get(`project:${item.id}`)).toBeNull();
    expect(cf.apps).toEqual([]);
    expect(cf.routes()).toEqual([]);
    expect(cf.dns).toEqual([]);
  });

  test('a connector that never connects is reported, and the tunnel stays open for the user to close', async () => {
    await open({ readyTimeoutMs: 200 });
    cf.connect = false;
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain('stays open');
    expect(app!.tunnels.get(`project:${item.id}`)).toMatchObject({ status: 'running' });
    expect((await tunnel(item.id, 'DELETE')).status).toBe(200);
    expect(cf.dns).toEqual([]);
  });

  test('refuses stopped projects and services without calling Cloudflare', async () => {
    await open();
    const stopped = project(root, { port, devCommand: 'true' });
    const service = project('', { kind: 'service', url: 'http://beelinkk:8080/' });
    app!.store.insert(stopped); app!.store.insert(service);
    const before = cf.calls.length;
    expect((await tunnel(stopped.id)).status).toBe(409);
    expect((await tunnel(service.id)).status).toBe(400);
    expect((await app!.fetch(request(`/api/projects/${stopped.id}/tunnel`, 'POST', { port: 22 }))).status).toBe(400);
    expect(cf.calls.length).toBe(before);
  });

  test('without a Cloudflare config tunnels are unavailable', async () => {
    app = await createApp({ dbPath: ':memory:', bootstrap: false, processOptions: { stopGraceMs: 150 }, launchOptions: { timeoutMs: 3000 } });
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('not configured');
  });

  test('rejects access rules Cloudflare Access would refuse and keeps the saved list', async () => {
    await open();
    const item = project(root, { port });
    app!.store.insert(item);
    expect((await patch(item.id, { tunnelAllowedEmails: ['ok@example.com'] })).status).toBe(200);
    for (const value of [['@example.com'], ['example.com'], ['*.example.com'], ['a@b.com,c@d.com'], ['two@@example.com'], [42], 'ok@example.com', Array(51).fill('a@example.com')]) {
      const response = await patch(item.id, { tunnelAllowedEmails: value });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/tunnel/i);
    }
    expect(app!.store.get(item.id)!.tunnelAllowedEmails).toEqual(['ok@example.com']);
  });
});
