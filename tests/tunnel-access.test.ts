import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import { clearLocateCache } from '../server/project-owner';
import { TunnelAccessResolver, type AccessEntry } from '../server/tunnel-access';
import type { TunnelAccessMode } from '../shared/tunnels';
import { activeThreads, cleanup, FakeAgentSupervisor, fakeCloudflared, files, fixture, project, request } from './helpers';

function entry(id: string, directory: string, mode: TunnelAccessMode = 'inherit', emails: string[] = [], kind = 'project'): AccessEntry {
  return { id, name: id, kind, directory, tunnelAccessMode: mode, tunnelAllowedEmails: emails };
}
const ids = (refs: { id: string }[]) => refs.map(ref => ref.id);

describe('layered tunnel access resolution', () => {
  let root: string;
  let main: string;
  let worktree: string;
  beforeEach(async () => {
    clearLocateCache();
    root = await fixture();
    main = path.join(root, 'main');
    worktree = path.join(root, 'worktrees', 'feature');
    // A main checkout with a linked worktree laid out the way `git worktree add` writes it.
    await files(root, {
      'main/.git/HEAD': 'ref: refs/heads/main\n',
      'main/.git/worktrees/feature/commondir': '../..\n',
      'main/apps/web/src/index.ts': '',
      'main/apps/api/index.ts': '',
      'worktrees/feature/.git': `gitdir: ${path.join(main, '.git/worktrees/feature')}\n`,
      'worktrees/feature/apps/web/src/index.ts': '',
      'elsewhere/readme.md': '',
    });
  });
  afterEach(async () => { await cleanup(root); });

  test('combines the lists of custom entries registered at the same folder, in order', () => {
    const access = new TunnelAccessResolver([
      entry('a', main, 'custom', ['a@example.com', '*@team.example.org']),
      entry('b', main + '/', 'custom', ['*@team.example.org', 'b@example.com']),
      entry('c', main),
    ]);
    const resolved = access.resolveDirectory(path.join(main, 'apps/web'));
    expect(resolved).toEqual({ source: 'project', from: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], allowedEmails: ['a@example.com', '*@team.example.org', 'b@example.com'] });
    // An inheriting entry beside custom peers gets their combined list.
    expect(access.fields(entry('c', main)).tunnelAccess).toEqual(resolved);
    expect(ids(access.fields(entry('c', main)).tunnelAccessPeers!)).toEqual(['a', 'b']);
  });

  test('custom beats public inside one folder layer', () => {
    const access = new TunnelAccessResolver([entry('open', main, 'public'), entry('closed', main, 'custom', ['x@example.com'])]);
    expect(access.resolveDirectory(main)).toMatchObject({ source: 'project', allowedEmails: ['x@example.com'] });
    expect(ids(access.resolveDirectory(main).from)).toEqual(['closed']);
  });

  test('public stops inheritance for its folder and everything below it', () => {
    const web = path.join(main, 'apps/web');
    const access = new TunnelAccessResolver([
      entry('root', main, 'custom', ['team@example.com']),
      entry('web', web, 'public'),
      entry('src', path.join(web, 'src')),
    ], ['default@example.com']);
    expect(access.resolveDirectory(path.join(web, 'src'))).toEqual({ source: 'project', from: [{ id: 'web', name: 'web' }], allowedEmails: [] });
    expect(access.fields(entry('src', path.join(web, 'src'))).tunnelAccess).toMatchObject({ source: 'project', allowedEmails: [] });
    expect(access.fields(entry('web', web, 'public')).tunnelAccess).toEqual({ source: 'own', from: [{ id: 'web', name: 'web' }], allowedEmails: [] });
    // Siblings still inherit from the root.
    expect(access.resolveDirectory(path.join(main, 'apps/api'))).toMatchObject({ allowedEmails: ['team@example.com'], from: [{ id: 'root' }] });
  });

  test('inherit walks up to the nearest ancestor layer that sets access, then the Settings default', () => {
    const web = path.join(main, 'apps/web');
    const access = new TunnelAccessResolver([entry('root', main, 'custom', ['team@example.com']), entry('web', web)], ['default@example.com']);
    expect(access.fields(entry('web', web)).tunnelAccess).toEqual({ source: 'project', from: [{ id: 'root', name: 'root' }], allowedEmails: ['team@example.com'] });
    const none = new TunnelAccessResolver([entry('root', main), entry('web', web)]);
    expect(none.fields(entry('web', web)).tunnelAccess).toEqual({ source: 'none', from: [], allowedEmails: [] });
    const fallback = new TunnelAccessResolver([entry('root', main), entry('web', web)], ['default@example.com']);
    expect(fallback.fields(entry('web', web)).tunnelAccess).toEqual({ source: 'default', from: [], allowedEmails: ['default@example.com'] });
  });

  test('the inherited preview leaves out the project itself, but not its same-folder peers', () => {
    const web = path.join(main, 'apps/web');
    const self = entry('web', web, 'custom', ['own@example.com']);
    const alone = new TunnelAccessResolver([entry('root', main, 'custom', ['team@example.com']), self]);
    const fields = alone.fields(self);
    expect(fields.tunnelAccess).toEqual({ source: 'own', from: [{ id: 'web', name: 'web' }], allowedEmails: ['own@example.com'] });
    expect(fields.tunnelAccessInherited).toMatchObject({ source: 'project', allowedEmails: ['team@example.com'] });
    expect(fields.tunnelAccessPeers).toEqual([]);
    // Agent previews in the folder get the layer, which includes the project's own list.
    expect(alone.resolveDirectory(path.join(web, 'src')).allowedEmails).toEqual(['own@example.com']);

    const shared = new TunnelAccessResolver([self, entry('peer', web, 'custom', ['peer@example.com'])]);
    expect(shared.fields(self).tunnelAccessInherited).toEqual({ source: 'project', from: [{ id: 'peer', name: 'peer' }], allowedEmails: ['peer@example.com'] });
  });

  test('a linked Git worktree continues from its main checkout (monorepo regression)', () => {
    // The root is custom; the hidden apps/web entry inherits. A preview in the worktree's
    // apps/web used to take that entry's empty list and open a public tunnel.
    const projects = [
      entry('root', main, 'custom', ['team@example.com']),
      { ...entry('web', path.join(main, 'apps/web')), name: '@dernek/web' },
    ];
    const access = new TunnelAccessResolver(projects, ['default@example.com']);
    const cwd = path.join(worktree, 'apps/web');
    expect(access.resolveDirectory(cwd)).toEqual({ source: 'project', from: [{ id: 'root', name: 'root' }], allowedEmails: ['team@example.com'] });
    expect(access.owner(cwd)).toEqual({ id: 'web', name: '@dernek/web' });
    expect(access.resolveDirectory(path.join(worktree, 'apps/web/src')).allowedEmails).toEqual(['team@example.com']);
    // A public layer in the main checkout also applies through the worktree.
    const open = new TunnelAccessResolver([...projects, entry('webPublic', path.join(main, 'apps/web'), 'public')], ['default@example.com']);
    expect(open.resolveDirectory(cwd)).toMatchObject({ source: 'project', allowedEmails: [], from: [{ id: 'webPublic' }] });
  });

  test('previews outside every project get the Settings default, or nothing', () => {
    const projects = [entry('root', main, 'custom', ['team@example.com']), entry('svc', path.join(root, 'elsewhere'), 'custom', ['svc@example.com'], 'service')];
    expect(new TunnelAccessResolver(projects, ['*@example.com']).resolveDirectory(path.join(root, 'elsewhere')))
      .toEqual({ source: 'default', from: [], allowedEmails: ['*@example.com'] });
    expect(new TunnelAccessResolver(projects).resolveDirectory(path.join(root, 'elsewhere'))).toEqual({ source: 'none', from: [], allowedEmails: [] });
    expect(new TunnelAccessResolver(projects).owner(path.join(root, 'elsewhere'))).toBeNull();
    // A sibling whose name only shares a prefix is not inside the project.
    expect(new TunnelAccessResolver(projects).resolveDirectory(`${main}-copy`).source).toBe('none');
    // Services carry none of the computed fields.
    expect(new TunnelAccessResolver(projects).fields(projects[1]!)).toEqual({});
  });

  test('reads entries saved before modes existed', () => {
    const legacy = { ...entry('root', main), tunnelAccessMode: undefined, tunnelAllowedEmails: ['old@example.com'] };
    expect(new TunnelAccessResolver([legacy]).resolveDirectory(main).allowedEmails).toEqual(['old@example.com']);
  });
});

describe('layered tunnel access through the API', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let supervisor: FakeAgentSupervisor;
  beforeEach(async () => {
    clearLocateCache();
    root = await fixture();
    await files(root, {
      'main/.git/HEAD': 'ref: refs/heads/main\n',
      'main/.git/worktrees/feature/commondir': '../..\n',
      'main/apps/web/package.json': '{}',
      'worktrees/feature/.git': `gitdir: ${path.join(root, 'main/.git/worktrees/feature')}\n`,
      'worktrees/feature/apps/web/src/index.ts': '',
      'elsewhere/readme.md': '',
    });
    supervisor = new FakeAgentSupervisor();
    app = await createApp({
      dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [] }, agentSupervisor: supervisor, t3Threads: activeThreads,
      tunnelOptions: { binary: await fakeCloudflared(root), startTimeoutMs: 3000, stopGraceMs: 150 },
    });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  const patch = (route: string, data: unknown) => app.fetch(request(route, 'PATCH', data));
  const get = async (id: string) => (await (await app.fetch(request('/api/projects'))).json()).projects.find((item: { id: string }) => item.id === id);
  const launches = async () => (await readFile(path.join(root, 'cloudflared.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

  test('older clients that send only the list still work', async () => {
    const item = project(path.join(root, 'main'));
    app.store.insert(item);
    expect((await get(item.id)).tunnelAccessMode).toBe('inherit');
    let response = await patch(`/api/projects/${item.id}`, { tunnelAllowedEmails: ['A@example.com'] });
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['a@example.com'], tunnelAccess: { source: 'own', allowedEmails: ['a@example.com'] } });
    response = await patch(`/api/projects/${item.id}`, { tunnelAllowedEmails: [] });
    expect((await response.json()).project).toMatchObject({ tunnelAccessMode: 'inherit', tunnelAllowedEmails: [], tunnelAccess: { source: 'none' } });
    // An explicitly public entry stays public when an old client saves an empty list.
    expect((await patch(`/api/projects/${item.id}`, { tunnelAccessMode: 'public' })).status).toBe(200);
    response = await patch(`/api/projects/${item.id}`, { name: 'Renamed', tunnelAllowedEmails: [] });
    expect((await response.json()).project).toMatchObject({ tunnelAccessMode: 'public', tunnelAccess: { source: 'own', allowedEmails: [] } });
  });

  test('validates modes: custom needs rules, inherit and public clear the stored list', async () => {
    const item = project(path.join(root, 'main'));
    app.store.insert(item);
    const route = `/api/projects/${item.id}`;
    let response = await patch(route, { tunnelAccessMode: 'custom' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Add at least one email, or choose inherit or public');
    expect((await patch(route, { tunnelAccessMode: 'custom', tunnelAllowedEmails: [] })).status).toBe(400);
    expect((await patch(route, { tunnelAccessMode: 'shared' })).status).toBe(400);
    expect((await patch(route, { tunnelAccessMode: 'custom', tunnelAllowedEmails: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) })).status).toBe(400);
    expect((await patch(route, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['x@example.com'] })).status).toBe(200);
    // Custom without a new list keeps the saved one.
    expect((await patch(route, { tunnelAccessMode: 'custom' })).status).toBe(200);
    expect(app.store.get(item.id)).toMatchObject({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['x@example.com'] });
    for (const mode of ['inherit', 'public'] as const) {
      expect((await patch(route, { tunnelAccessMode: 'custom', tunnelAllowedEmails: ['x@example.com'] })).status).toBe(200);
      expect((await patch(route, { tunnelAccessMode: mode, tunnelAllowedEmails: ['ignored@example.com'] })).status).toBe(200);
      expect(app.store.get(item.id)).toMatchObject({ tunnelAccessMode: mode, tunnelAllowedEmails: [] });
    }
  });

  test('ignores echoed computed fields on PATCH and never stores them', async () => {
    const item = project(path.join(root, 'main'));
    app.store.insert(item);
    const echoed = await get(item.id);
    const response = await patch(`/api/projects/${item.id}`, {
      name: 'Echoed', tunnelAccess: { source: 'own', from: [], allowedEmails: ['evil@example.com'] },
      tunnelAccessInherited: echoed.tunnelAccessInherited, tunnelAccessPeers: [{ id: 'x', name: 'x' }],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ name: 'Echoed', tunnelAccess: { source: 'none', allowedEmails: [] }, tunnelAccessPeers: [] });
    const row = app.store.db.query('SELECT data FROM projects WHERE id = ?').get(item.id) as { data: string };
    expect(Object.keys(JSON.parse(row.data))).not.toContain('tunnelAccess');
    expect(Object.keys(JSON.parse(row.data))).not.toContain('tunnelAccessPeers');
    // Other read-only fields are still refused.
    expect((await patch(`/api/projects/${item.id}`, { runtime: {} })).status).toBe(400);
  });

  test('reads stored rows from before modes existed without rewriting them', async () => {
    const listed = project(path.join(root, 'main'), { name: 'Listed' });
    const bare = project(path.join(root, 'main/apps/web'), { name: 'Bare' });
    const legacy = { ...listed, tunnelAllowedEmails: ['old@example.com'] } as Record<string, unknown>;
    const older = { ...bare } as Record<string, unknown>;
    delete older.hidden;
    for (const data of [legacy, older]) {
      app.store.db.query('INSERT INTO projects (id, directory, url, kind, data) VALUES (?, ?, ?, ?, ?)').run(data.id as string, data.directory as string, '', 'project', JSON.stringify(data));
    }
    expect(await get(listed.id)).toMatchObject({ tunnelAccessMode: 'custom', tunnelAllowedEmails: ['old@example.com'], tunnelAccess: { source: 'own' } });
    expect(await get(bare.id)).toMatchObject({ tunnelAccessMode: 'inherit', tunnelAllowedEmails: [], hidden: false,
      tunnelAccess: { source: 'project', from: [{ id: listed.id, name: 'Listed' }], allowedEmails: ['old@example.com'] } });
    const raw = app.store.db.query('SELECT data FROM projects WHERE id = ?').get(listed.id) as { data: string };
    expect(JSON.parse(raw.data).tunnelAccessMode).toBeUndefined();
  });

  test('Settings stores a validated default list', async () => {
    expect((await (await app.fetch(request('/api/settings'))).json()).settings.tunnelAllowedEmails).toEqual([]);
    const response = await patch('/api/settings', { tunnelAllowedEmails: [' Me@Example.com', '*@team.example.org', 'me@example.com'] });
    expect(response.status).toBe(200);
    expect((await response.json()).settings.tunnelAllowedEmails).toEqual(['me@example.com', '*@team.example.org']);
    for (const value of [['example.com'], 'me@example.com', [1], Array.from({ length: 51 }, (_, i) => `u${i}@example.com`)]) {
      expect((await patch('/api/settings', { tunnelAllowedEmails: value })).status).toBe(400);
    }
    expect(app.store.settings().tunnelAllowedEmails).toEqual(['me@example.com', '*@team.example.org']);
    expect((await patch('/api/settings', { tunnelAllowedEmails: [] })).status).toBe(200);
    expect(app.store.settings().tunnelAllowedEmails).toEqual([]);
  });

  test('services carry no computed access fields; projects report peers', async () => {
    const a = project(path.join(root, 'main'), { name: 'A' });
    const b = project(path.join(root, 'main'), { name: 'B', tunnelAccessMode: 'custom', tunnelAllowedEmails: ['b@example.com'] });
    const service = project('', { kind: 'service', url: 'http://beelinkk:8080/', name: 'Service' });
    for (const item of [a, b, service]) app.store.insert(item);
    const listed = await get(service.id);
    expect(listed.tunnelAccess).toBeUndefined();
    expect(listed.tunnelAccessInherited).toBeUndefined();
    expect(listed.tunnelAccessPeers).toBeUndefined();
    expect(await get(a.id)).toMatchObject({ tunnelAccessPeers: [{ id: b.id, name: 'B' }], tunnelAccess: { source: 'project', allowedEmails: ['b@example.com'] } });
    expect(await get(b.id)).toMatchObject({ tunnelAccessPeers: [{ id: a.id, name: 'A' }], tunnelAccessInherited: { source: 'none' } });
  });

  test('a preview in a worktree of a hidden, inheriting app opens a tunnel with the monorepo root list', async () => {
    const rootEntry = project(path.join(root, 'main'), { name: 'Dernek', tunnelAccessMode: 'custom', tunnelAllowedEmails: ['*@dernek.example.org'] });
    const web = project(path.join(root, 'main/apps/web'), { name: '@dernek/web', hidden: true });
    app.store.insert(rootEntry); app.store.insert(web);
    const created = await app.agentServers.add({ name: 'Preview', cwd: path.join(root, 'worktrees/feature/apps/web'), command: 'fixture', threadId: 'fixture-thread' });
    expect(created.owner).toEqual({ id: web.id, name: '@dernek/web' });
    expect(created.tunnelAccess).toEqual({ source: 'project', from: [{ id: rootEntry.id, name: 'Dernek' }], allowedEmails: ['*@dernek.example.org'] });
    const listed = (await (await app.fetch(request('/api/agent-servers'))).json()).servers[0];
    expect(listed.tunnelAccess.allowedEmails).toEqual(['*@dernek.example.org']);
    const response = await app.fetch(request(`/api/agent-servers/${created.id}/tunnel`, 'POST', {}));
    expect(response.status).toBe(200);
    expect((await response.json()).tunnel.allowedEmails).toEqual(['*@dernek.example.org']);
    expect((await launches())[0]).toContain('--allowed-mail *@dernek.example.org --url');
  });

  test('a preview outside every project takes the Settings default', async () => {
    expect((await patch('/api/settings', { tunnelAllowedEmails: ['me@example.com'] })).status).toBe(200);
    const created = await app.agentServers.add({ name: 'Preview', cwd: path.join(root, 'elsewhere'), command: 'fixture', threadId: 'fixture-thread' });
    expect(created).toMatchObject({ owner: null, tunnelAccess: { source: 'default', allowedEmails: ['me@example.com'] } });
    expect((await app.fetch(request(`/api/agent-servers/${created.id}/tunnel`, 'POST', {}))).status).toBe(200);
    expect((await launches())[0]).toContain('--allowed-mail me@example.com --url');
  });

  test('refuses to open a tunnel whose combined list exceeds what Cloudflare accepts', async () => {
    const rules = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix}${i}@example.com`);
    app.store.insert(project(path.join(root, 'main'), { name: 'One', tunnelAccessMode: 'custom', tunnelAllowedEmails: rules('a') }));
    app.store.insert(project(path.join(root, 'main'), { name: 'Two', tunnelAccessMode: 'custom', tunnelAllowedEmails: rules('b') }));
    const created = await app.agentServers.add({ name: 'Preview', cwd: path.join(root, 'main/apps/web'), command: 'fixture', threadId: 'fixture-thread' });
    expect(created.tunnelAccess.allowedEmails).toHaveLength(60);
    const response = await app.fetch(request(`/api/agent-servers/${created.id}/tunnel`, 'POST', {}));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/60 rules from One, Two.*at most 50/);
    expect(await launches()).toHaveLength(0);
  });
});
