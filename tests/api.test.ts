import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import { startServer } from '../server/index';
import { cleanup, files, fixture, project, request, until } from './helpers';

describe('API contract and persistence', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    root = await fixture();
    await files(root, { 'source/package.json': '{"name":"fixture"}', 'source/src/file.txt': 'source contents' });
    app = await createApp({ dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [root] }, processOptions: { stopGraceMs: 100 } });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  async function add(overrides: Record<string, unknown> = {}) {
    const response = await app.fetch(request('/api/projects', 'POST', { name: 'Fixture project', kind: 'project', directory: path.join(root, 'source'), ...overrides }));
    expect(response.status).toBe(201);
    return (await response.json()).project;
  }

  test('extension bridge is an inert framed document, not a cross-origin mutation exception', async () => {
    const response = await app.fetch(request('/api/extension/bridge'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors chrome-extension:');
    expect(await response.text()).not.toContain('<script');
    const denied = await app.fetch(request('/api/projects', 'POST', {}, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }));
    expect(denied.status).toBe(403);
    expect((await app.fetch(request('/api/extension/bridge', 'POST', {}, { Origin: 'https://evil.example' }))).status).toBe(403);
  });

  test('registers, edits, lists and removes project metadata without deleting real files', async () => {
    const saved = await add({ port: 6100, hostname: 'beelinkk' });
    expect(saved).toMatchObject({ url: 'http://localhost:6100/', runtime: { status: 'stopped', pid: null } });
    const changed = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { name: 'Renamed', favorite: true, devCommand: 'echo fixture' }));
    expect(changed.status).toBe(200);
    expect((await changed.json()).project).toMatchObject({ name: 'Renamed', favorite: true });
    const listing = await (await app.fetch(request('/api/projects'))).json();
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0].name).toBe('Renamed');
    const removed = await app.fetch(request(`/api/projects/${saved.id}`, 'DELETE'));
    expect(await removed.json()).toEqual({ ok: true });
    expect(await readFile(path.join(root, 'source/src/file.txt'), 'utf8')).toBe('source contents');
    expect((await app.fetch(request(`/api/projects/${saved.id}/logs`))).status).toBe(404);
  });

  test('configuration-only and real-file duplication implement the same project contract', async () => {
    const source = await add({ devCommand: 'echo fixture', favorite: true });
    const configResponse = await app.fetch(request(`/api/projects/${source.id}/duplicate`, 'POST', { name: 'Config clone', copyFiles: false }));
    expect(configResponse.status).toBe(201);
    const config = (await configResponse.json()).project;
    expect(config.id).not.toBe(source.id);
    expect(config).toMatchObject({ directory: source.directory, name: 'Config clone', devCommand: 'echo fixture', favorite: true, runtime: { status: 'stopped' } });
    const destination = path.join(root, 'copied');
    const copiedResponse = await app.fetch(request(`/api/projects/${source.id}/duplicate`, 'POST', { name: 'File clone', copyFiles: true, directory: destination }));
    expect(copiedResponse.status).toBe(201);
    expect((await copiedResponse.json()).project.directory).toBe(destination);
    expect(await readFile(path.join(destination, 'src/file.txt'), 'utf8')).toBe('source contents');
    const conflict = await app.fetch(request(`/api/projects/${source.id}/duplicate`, 'POST', { name: 'Existing', copyFiles: true, directory: destination }));
    expect(conflict.status).toBe(409);
    expect((await (await app.fetch(request('/api/projects'))).json()).projects).toHaveLength(3);
  });

  test('remote logos can be registered, edited and cleared without server-side image requests', async () => {
    let imageRequests = 0;
    const imageServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { imageRequests++; return new Response('not fetched'); } });
    try {
      const logo = new URL('/logo.png?version=1#image', imageServer.url).href;
      const saved = await add({ logo });
      expect(saved.logo).toBe(logo);
      expect(app.store.get(saved.id)?.logo).toBe(logo);
      const remote = 'https://tip.cu.edu.tr/storage/settings/April2019/5vMnGIZ4b3XRgvIKKStA.png';
      const changed = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { logo: `  ${remote}  ` }));
      expect(changed.status).toBe(200);
      expect((await changed.json()).project.logo).toBe(remote);
      expect((await (await app.fetch(request('/api/projects'))).json()).projects[0].logo).toBe(remote);
      // The local-file endpoint must not become a remote image proxy.
      expect((await app.fetch(request(`/api/projects/${saved.id}/logo?path=${encodeURIComponent(logo)}`))).status).toBe(400);
      expect(imageRequests).toBe(0);
      for (const logo of ['src/logo.svg', '']) {
        const response = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { logo }));
        expect(response.status).toBe(200);
        expect((await response.json()).project.logo).toBe(logo);
      }
    } finally {
      await imageServer.stop(true);
    }
  });

  test('unsafe logo URLs and escaping file paths are rejected without overwriting the saved logo', async () => {
    const saved = await add({ logo: 'public/logo.svg' });
    for (const logo of [
      'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///etc/passwd', 'ftp://example.test/logo.png',
      'https://user:password@example.test/logo.png', 'https://', 'https:/example.test/logo.png',
      'https://exa mple.test/logo.png', 'https://example.test/lo\ngo.png', 'https://example.test\\logo.png',
      '//example.test/logo.png', '/etc/logo.png', '../logo.svg', 'images/../../logo.svg',
    ]) {
      const response = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { logo }));
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe('string');
      expect(app.store.get(saved.id)?.logo).toBe('public/logo.svg');
    }
  });

  test('hiding is reversible, validates booleans, and never stops a managed command or removes files', async () => {
    const saved = await add({ devCommand: 'echo visibility-ready; sleep 60', favorite: true });
    expect(saved.hidden).toBe(false);
    expect((await app.fetch(request(`/api/projects/${saved.id}/start`, 'POST', { mode: 'dev' }))).status).toBe(200);
    await until(() => app.processes.logs(saved.id).some(line => line.text === 'visibility-ready'));
    const pid = app.processes.runtime(saved.id).pid;

    const hidden = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { hidden: true }));
    expect(hidden.status).toBe(200);
    expect((await hidden.json()).project).toMatchObject({ hidden: true, favorite: true, runtime: { status: 'running', pid } });
    // Hidden entries remain in the API so they can be managed and restored.
    expect((await (await app.fetch(request('/api/projects'))).json()).projects).toHaveLength(1);
    expect(app.store.get(saved.id)?.hidden).toBe(true);
    expect(await readFile(path.join(root, 'source/src/file.txt'), 'utf8')).toBe('source contents');

    for (const hidden of ['true', 1, null, {}, []]) {
      const invalid = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { hidden }));
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toBe('hidden must be a boolean');
      expect(app.store.get(saved.id)?.hidden).toBe(true);
    }
    const restored = await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { hidden: false }));
    expect(restored.status).toBe(200);
    expect((await restored.json()).project).toMatchObject({ hidden: false, favorite: true, runtime: { status: 'running', pid } });
  });

  test('registrations saved before visibility support remain visible without losing metadata', async () => {
    const { hidden: _, ...legacy } = project(path.join(root, 'source'), { name: 'Legacy edit', favorite: true, url: 'http://localhost:6100/' });
    app.store.db.query('INSERT INTO projects (id, directory, url, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(legacy.id, legacy.directory, legacy.url, legacy.kind, JSON.stringify(legacy));
    expect(app.store.get(legacy.id)).toMatchObject({ ...legacy, hidden: false });
    expect(app.store.byDirectory(legacy.directory)?.hidden).toBe(false);
    expect(app.store.byUrl(legacy.url)?.hidden).toBe(false);
    expect((await (await app.fetch(request('/api/projects'))).json()).projects).toEqual([
      expect.objectContaining({ ...legacy, hidden: false }),
    ]);
    const changed = await app.fetch(request(`/api/projects/${legacy.id}`, 'PATCH', { hidden: true }));
    expect(changed.status).toBe(200);
    expect(app.store.get(legacy.id)).toMatchObject({ ...legacy, hidden: true, updatedAt: expect.any(String) });
  });

  test('rejects cross-origin mutations, malformed input, read-only fields and invalid URLs/ports', async () => {
    expect((await app.fetch(request('/api/projects', 'POST', {}, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect((await app.fetch(request('/api/scan', 'POST', undefined, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await app.fetch(request('/api/settings', 'PATCH', {}, { Origin: 'http://shelf.test' }))).status).toBe(200);
    for (const input of [
      { name: '', kind: 'service', url: 'http://localhost/' },
      { name: 'Unsafe', kind: 'service', url: 'javascript:alert(1)' },
      { name: 'Bad port', kind: 'project', directory: path.join(root, 'source'), port: 99999 },
      { name: 'Invalid directory', kind: 'project', directory: '../relative' },
      { name: 'Read-only', kind: 'service', url: 'http://localhost/', runtime: { status: 'running' } },
    ]) {
      const response = await app.fetch(request('/api/projects', 'POST', input));
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe('string');
    }
    const malformed = await app.fetch(new Request('http://shelf.test/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }));
    expect(malformed.status).toBe(400);
    const form = await app.fetch(new Request('http://shelf.test/api/projects', { method: 'POST', body: 'name=bad' }));
    expect(form.status).toBe(415);
  });

  test('services preserve full URLs and hostname selection but never launch commands', async () => {
    const service = await add({ kind: 'service', directory: '', url: 'https://localhost:8123/path?q=hello#fragment', hostname: 'beelinkk' });
    expect(service.url).toBe('https://localhost:8123/path?q=hello#fragment');
    expect(service.hostname).toBe('beelinkk');
    expect((await app.fetch(request(`/api/projects/${service.id}/start`, 'POST', { mode: 'dev' }))).status).toBe(400);
    const imported = await app.fetch(request('/api/bookmarks/import', 'POST', { html: '<A HREF="http://10.0.0.1:9000/">Local</A><A HREF="https://example.com/">External</A>' }));
    expect(await imported.json()).toEqual({ added: 1, skipped: 1 });
  });

  test('API process controls run fixture commands and deletion stops the managed process', async () => {
    const item = await add({ devCommand: 'echo fixture-ready; sleep 60' });
    const started = await app.fetch(request(`/api/projects/${item.id}/start`, 'POST', { mode: 'dev' }));
    expect(started.status).toBe(200);
    await until(() => app.processes.logs(item.id).some((line) => line.text === 'fixture-ready'));
    const logs = await (await app.fetch(request(`/api/projects/${item.id}/logs`))).json();
    expect(logs.logs.some((line: { text: string }) => line.text === 'fixture-ready')).toBe(true);
    expect((await app.fetch(request(`/api/projects/${item.id}`, 'PATCH', { directory: path.join(root, 'source'), name: 'Still running' }))).status).toBe(200);
    expect((await app.fetch(request(`/api/projects/${item.id}`, 'PATCH', { directory: root }))).status).toBe(409);
    expect((await app.fetch(request(`/api/projects/${item.id}`, 'DELETE'))).status).toBe(200);
    expect(app.processes.runtime(item.id).status).toBe('stopped');
  });

  test('settings are validated, and scan reports actual discovery counts', async () => {
    const changed = await app.fetch(request('/api/settings', 'PATCH', { roots: [root, root], hostnames: ['nas.local', '192.168.1.50'], defaultHostname: 'nas.local' }));
    expect((await changed.json()).settings.roots).toEqual([root]);
    expect((await app.fetch(request('/api/settings', 'PATCH', { roots: ['relative'] }))).status).toBe(400);
    expect((await app.fetch(request('/api/settings', 'PATCH', { hostnames: ['http://bad:123'] }))).status).toBe(400);
    expect((await app.fetch(request('/api/settings', 'PATCH', { hostnames: ['*.bad'] }))).status).toBe(400);
    expect(await (await app.fetch(request('/api/scan', 'POST'))).json()).toMatchObject({ added: 1, scanned: 1, existing: 0 });
    expect(await (await app.fetch(request('/api/scan', 'POST'))).json()).toMatchObject({ added: 0, scanned: 1, existing: 1 });
  });

  test('SQLite persistence and initial scan/bookmark seeding happen only once', async () => {
    await app.close();
    const dbPath = path.join(root, 'panel.sqlite');
    const bookmarksPath = path.join(root, 'bookmarks.html');
    await files(root, { 'bookmarks.html': '<A HREF="http://localhost:9000/">Seed service</A>' });
    app = await createApp({ dbPath, bookmarksPath, initialSettings: { roots: [path.join(root, 'source')] } });
    expect(app.store.list()).toHaveLength(2);
    const saved = app.store.list().find((item) => item.kind === 'project')!;
    const logo = 'https://example.test/logo.png?v=2#image';
    await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { name: 'Persisted edit', favorite: true, hidden: true, logo }));
    const lastScanAt = app.store.settings().lastScanAt;
    await app.close();
    await files(root, { 'source/new-project/go.mod': 'module new-project', 'bookmarks.html': '<A HREF="http://localhost:9100/">New seed</A>' });
    app = await createApp({ dbPath, bookmarksPath });
    expect(app.store.list()).toHaveLength(2);
    expect(app.store.get(saved.id)).toMatchObject({ name: 'Persisted edit', favorite: true, hidden: true, logo });
    expect(app.store.settings().lastScanAt).toBe(lastScanAt);
    expect((await (await app.fetch(request('/api/scan', 'POST'))).json()).added).toBe(1);
    expect(app.store.get(saved.id)).toMatchObject({ name: 'Persisted edit', hidden: true, logo });
    expect(app.store.list().filter(item => item.directory === saved.directory)).toHaveLength(1);
    expect((await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { hidden: false }))).status).toBe(200);
    await app.close();
    app = await createApp({ dbPath, bookmarksPath });
    expect(app.store.get(saved.id)).toMatchObject({ name: 'Persisted edit', favorite: true, hidden: false });
    await app.close();
    expect((await app.fetch(request('/api/health'))).status).toBe(503);
  });

  test('serves built files and SPA routes without exposing adjacent files', async () => {
    await app.close();
    await files(root, { 'dist/index.html': '<html>fixture app</html>', 'dist/assets/app.js': 'console.log("fixture")', 'dist/assets/index-ABCd1234.js': '// fingerprinted bundle', 'dist/assets/index-ABCd1234.css': '/* fingerprinted styles */', 'dist/sw.js': '// service worker', 'dist/manifest.webmanifest': '{"name":"Fixture"}', 'secret.txt': 'private' });
    app = await createApp({ dbPath: ':memory:', bootstrap: false, staticDir: path.join(root, 'dist') });
    expect(await (await app.fetch(request('/'))).text()).toContain('fixture app');
    expect(await (await app.fetch(request('/project/fixture'))).text()).toContain('fixture app');
    expect((await app.fetch(request('/assets/app.js'))).headers.get('Content-Type')).toContain('javascript');
    expect((await app.fetch(request('/%2e%2e%2fsecret.txt'))).status).toBe(400);
    expect((await app.fetch(request('/api/missing'))).status).toBe(404);
    expect((await app.fetch(request('/missing.js'))).status).toBe(404);
    for (const route of ['/', '/index.html', '/project/fixture']) {
      expect((await app.fetch(request(route))).headers.get('Cache-Control')).toBe('private, max-age=0, stale-while-revalidate=86400, stale-if-error=604800');
    }
    for (const route of ['/assets/index-ABCd1234.js', '/assets/index-ABCd1234.css']) {
      expect((await app.fetch(request(route))).headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    }
    expect((await app.fetch(request('/assets/app.js'))).headers.get('Cache-Control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
    for (const route of ['/sw.js', '/manifest.webmanifest']) {
      expect((await app.fetch(request(route))).headers.get('Cache-Control')).toBe('no-cache');
    }
    for (const route of ['/api/projects', '/api/settings']) {
      expect((await app.fetch(request(route))).headers.get('Cache-Control')).toBe('no-store');
    }
    const saved = await add();
    expect((await app.fetch(request(`/api/projects/${saved.id}/logs`))).headers.get('Cache-Control')).toBe('no-store');
    expect((await app.fetch(request(`/api/projects/${saved.id}`, 'PATCH', { favorite: true }))).headers.get('Cache-Control')).toBe('no-store');
  });

  test('Bun entrypoint can bind a temporary port and shut down without touching user roots', async () => {
    const instance = await startServer({ dbPath: ':memory:', bootstrap: false, port: 0, hostname: '127.0.0.1', initialSettings: { roots: [] } });
    try {
      const health = await fetch(new URL('/api/health', instance.server.url));
      expect(await health.json()).toEqual({ ok: true });
    } finally { await instance.stop(); }
  });
});
