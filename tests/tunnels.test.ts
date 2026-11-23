import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import { cleanup, fakeCloudflared, files, fixture, processAlive, project, request, shellCommand, until } from './helpers';

// Each entry is "<pid> <arguments>" for one fake cloudflared launch.
async function launches(root: string) {
  const text = await readFile(path.join(root, 'cloudflared.log'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map(line => ({ pid: Number(line.split(' ')[0]), args: line.slice(line.indexOf(' ') + 1) }));
}

describe('Cloudflare quick tunnels for managed projects (fake cloudflared)', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;

  async function open(mode: 'ready' | 'fail' | 'hang' = 'ready', startTimeoutMs = 3000) {
    app = await createApp({ dbPath: ':memory:', bootstrap: false, processOptions: { stopGraceMs: 150 }, launchOptions: { timeoutMs: 3000 },
      tunnelOptions: { binary: await fakeCloudflared(root, mode), startTimeoutMs, stopGraceMs: 150 } });
  }
  beforeEach(async () => {
    root = await fixture();
    const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('reserved') });
    port = reservation.port!;
    await reservation.stop(true);
    await files(root, { 'dev.ts': `Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch: () => new Response('fixture') });` });
  });
  afterEach(async () => { await app?.close(); await cleanup(root); });

  async function running(overrides: Parameters<typeof project>[1] = {}) {
    const item = project(root, { port, devCommand: shellCommand(path.join(root, 'dev.ts')), ...overrides });
    app.store.insert(item);
    expect((await app.fetch(request(`/api/projects/${item.id}/launch`, 'POST', {}))).status).toBe(200);
    return item;
  }
  const tunnel = (id: string, method = 'POST') => app.fetch(request(`/api/projects/${id}/tunnel`, method, method === 'POST' ? {} : undefined));

  test('opens a tunnel to the local port, reports it, and stopping the project closes it', async () => {
    await open();
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.tunnel.status).toBe('running');
    expect(result.tunnel.url).toMatch(/^https:\/\/fixture-\d+\.trycloudflare\.com$/);
    expect(result.project.runtime.tunnel).toEqual(result.tunnel);
    const [launch] = await launches(root);
    expect(launch!.args).toContain(`--url http://127.0.0.1:${port}`);
    expect(launch!.args).toContain('--http-host-header localhost');
    // Repeated opens reuse the same tunnel.
    expect((await (await tunnel(item.id)).json()).tunnel.url).toBe(result.tunnel.url);
    expect(await launches(root)).toHaveLength(1);
    expect((await (await app.fetch(request('/api/projects'))).json()).projects[0].runtime.tunnel.url).toBe(result.tunnel.url);

    const stopped = await (await app.fetch(request(`/api/projects/${item.id}/stop`, 'POST', {}))).json();
    expect(stopped.project.runtime).toMatchObject({ status: 'stopped', tunnel: null });
    expect(await processAlive(launch!.pid)).toBe(false);
  });

  const patch = (id: string, data: unknown) => app.fetch(request(`/api/projects/${id}`, 'PATCH', data));

  test('public by default; the project allowlist protects tunnels opened afterwards', async () => {
    await open();
    const item = await running();
    const other = project(root, { name: 'Sibling' });
    app.store.insert(other);
    const publicTunnel = await (await tunnel(item.id)).json();
    expect(publicTunnel.tunnel.allowedEmails).toEqual([]);
    expect(publicTunnel.project.tunnelAllowedEmails).toEqual([]);
    expect((await launches(root))[0]!.args).not.toContain('--allowed-mail');

    const saved = await patch(item.id, { tunnelAllowedEmails: [' You@Example.com ', '*@team.example.org', 'you@example.com'] });
    expect(saved.status).toBe(200);
    expect((await saved.json()).project.tunnelAllowedEmails).toEqual(['you@example.com', '*@team.example.org']);
    // Only this project changes, and an open tunnel keeps the access it started with.
    expect(app.store.get(other.id)!.tunnelAllowedEmails).toEqual([]);
    expect((await (await tunnel(item.id)).json()).tunnel.allowedEmails).toEqual([]);
    expect(await launches(root)).toHaveLength(1);

    expect((await tunnel(item.id, 'DELETE')).status).toBe(200);
    const protectedTunnel = await (await tunnel(item.id)).json();
    expect(protectedTunnel.tunnel.allowedEmails).toEqual(['you@example.com', '*@team.example.org']);
    expect(protectedTunnel.project.runtime.tunnel.allowedEmails).toEqual(['you@example.com', '*@team.example.org']);
    expect((await launches(root))[1]!.args).toContain('--allowed-mail you@example.com --allowed-mail *@team.example.org --url');
  });

  test('an inheriting project opens its tunnel with the access of its folder layer, else the Settings default', async () => {
    await open();
    expect((await app.fetch(request('/api/settings', 'PATCH', { tunnelAllowedEmails: ['default@example.com'] }))).status).toBe(200);
    const item = await running();
    expect((await (await tunnel(item.id)).json()).tunnel.allowedEmails).toEqual(['default@example.com']);
    expect((await tunnel(item.id, 'DELETE')).status).toBe(200);
    // A same-folder peer with its own list now decides for the inheriting project.
    const peer = project(root, { name: 'Peer', tunnelAccessMode: 'custom', tunnelAllowedEmails: ['peer@example.com'] });
    app.store.insert(peer);
    const result = await (await tunnel(item.id)).json();
    expect(result.tunnel.allowedEmails).toEqual(['peer@example.com']);
    expect(result.project.tunnelAccess).toEqual({ source: 'project', from: [{ id: peer.id, name: 'Peer' }], allowedEmails: ['peer@example.com'] });
    expect((await launches(root))[1]!.args).toContain('--allowed-mail peer@example.com --url');
  });

  test('rejects access rules cloudflared would refuse and keeps the saved list', async () => {
    await open();
    const item = project(root, { port });
    app.store.insert(item);
    expect((await patch(item.id, { tunnelAllowedEmails: ['ok@example.com'] })).status).toBe(200);
    for (const value of [['@example.com'], ['example.com'], ['*.example.com'], ['a@b.com,c@d.com'], ['two@@example.com'], [42], 'ok@example.com', Array(51).fill('a@example.com')]) {
      const response = await patch(item.id, { tunnelAllowedEmails: value });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/tunnel/i);
    }
    expect(app.store.get(item.id)!.tunnelAllowedEmails).toEqual(['ok@example.com']);
    expect((await patch(item.id, { tunnelAllowedEmails: [] })).status).toBe(200);
    expect(app.store.get(item.id)!.tunnelAllowedEmails).toEqual([]);
  });

  test('a project that exits on its own takes its tunnel with it', async () => {
    await open();
    await files(root, { 'short.ts': `Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch: () => new Response('fixture') }); setTimeout(() => process.exit(0), 900);` });
    const item = await running({ devCommand: shellCommand(path.join(root, 'short.ts')) });
    expect((await tunnel(item.id)).status).toBe(200);
    const [launch] = await launches(root);
    await until(() => !app.processes.active(item.id), 4000);
    await until(async () => !(await processAlive(launch!.pid)), 2000);
    expect(app.tunnels.get(`project:${item.id}`)).toBeNull();
  });

  test('closing only the tunnel keeps the project running', async () => {
    await open();
    const item = await running();
    expect((await tunnel(item.id)).status).toBe(200);
    const [launch] = await launches(root);
    const closed = await (await tunnel(item.id, 'DELETE')).json();
    expect(closed.project.runtime).toMatchObject({ status: 'running', tunnel: null });
    expect(await processAlive(launch!.pid)).toBe(false);
    expect((await tunnel(item.id, 'DELETE')).status).toBe(200); // repeated close is safe
  });

  test('refuses stopped projects and services without starting cloudflared', async () => {
    await open();
    const stopped = project(root, { port, devCommand: 'true' });
    const service = project('', { kind: 'service', url: 'http://beelinkk:8080/' });
    app.store.insert(stopped); app.store.insert(service);
    expect((await tunnel(stopped.id)).status).toBe(409);
    expect((await tunnel(service.id)).status).toBe(400);
    expect((await app.fetch(request(`/api/projects/${stopped.id}/tunnel`, 'POST', { port: 22 }))).status).toBe(400);
    expect(await launches(root)).toHaveLength(0);
  });

  test('reports a cloudflared startup failure and leaves no tunnel behind', async () => {
    await open('fail');
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('fixture outage');
    expect(app.tunnels.get(`project:${item.id}`)).toBeNull();
  });

  test('a tunnel that never connects times out and its process group is stopped', async () => {
    await open('hang', 300);
    const item = await running();
    const response = await tunnel(item.id);
    expect(response.status).toBe(504);
    const [launch] = await launches(root);
    await until(async () => !(await processAlive(launch!.pid)), 2000);
  });

  test('stopping a project while its tunnel is starting cancels the tunnel', async () => {
    await open('hang', 5000);
    const item = await running();
    const pending = tunnel(item.id);
    await until(async () => (await launches(root)).length === 1);
    expect(app.tunnels.get(`project:${item.id}`)).toMatchObject({ status: 'starting', url: null });
    expect((await app.fetch(request(`/api/projects/${item.id}/stop`, 'POST', {}))).status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(await processAlive((await launches(root))[0]!.pid)).toBe(false);
  });

  test('app shutdown closes open tunnels', async () => {
    await open();
    const item = await running();
    expect((await tunnel(item.id)).status).toBe(200);
    const [launch] = await launches(root);
    await app.close();
    expect(await processAlive(launch!.pid)).toBe(false);
  });
});
