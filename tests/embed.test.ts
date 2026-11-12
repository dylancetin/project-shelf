import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
import { DEFAULT_HOSTNAMES } from '../shared/hostnames';
import { cleanup, files, fixture, project, request } from './helpers';

describe('framing policy for /embed.html', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    root = await fixture();
    await files(root, {
      'dist/index.html': '<html>Shelf</html>', 'dist/embed.html': '<html>Embedded controls</html>',
      'dist/assets/app-abcdef12.js': 'export {}', 'dist/notes.html': '<html>Other page</html>',
    });
    app = await createApp({
      dbPath: ':memory:', bootstrap: false, staticDir: path.join(root, 'dist'),
      initialSettings: { roots: [], hostnames: ['beelinkk', 'devbox.lan'] },
    });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  async function ancestors(route = '/embed.html', method = 'GET') {
    const response = await app.fetch(request(route, method));
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy');
    expect(policy).not.toBeNull();
    expect(policy).toStartWith('frame-ancestors ');
    expect(policy!.split(';')).toHaveLength(1);
    return new Set(policy!.slice('frame-ancestors '.length).split(' '));
  }

  test('lets this panel, extensions, and every server alias on any port frame the page, and nothing else', async () => {
    const response = await app.fetch(request('/embed.html'));
    expect(await response.text()).toBe('<html>Embedded controls</html>');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-frame-options')).toBeNull();
    const aliases = [...new Set([...DEFAULT_HOSTNAMES, 'devbox.lan', 'localhost', '127.0.0.1'])];
    expect(await ancestors()).toEqual(new Set(["'self'", 'chrome-extension:', ...aliases.flatMap(host => [`http://${host}:*`, `https://${host}:*`])]));
  });

  test('applies to HEAD requests and every path spelling of the file, and is always revalidated', async () => {
    for (const [route, method] of [['/embed.html', 'HEAD'], ['/%65mbed.html', 'GET'], ['/embed.html?surface=bubble&url=http%3A%2F%2Fbeelinkk%3A5173%2F', 'GET']] as const) {
      expect((await ancestors(route, method)).has("'self'")).toBe(true);
    }
    expect((await app.fetch(request('/embed.html'))).headers.get('cache-control')).toBe('no-cache');
  });

  test('follows Network hostname edits immediately', async () => {
    expect((await ancestors()).has('http://newhost.lan:*')).toBe(false);
    const saved = await app.fetch(request('/api/settings', 'PATCH', { hostnames: ['beelinkk', 'newhost.lan'] }));
    expect(saved.status).toBe(200);
    const sources = await ancestors();
    expect(sources.has('http://newhost.lan:*')).toBe(true);
    expect(sources.has('https://newhost.lan:*')).toBe(true);
    expect(sources.has('http://devbox.lan:*')).toBe(false);
  });

  test('adds registered project addresses, which cover reverse-proxy dev pages, but never services or unsafe hosts', async () => {
    app.store.insert(project(root, { port: 3000, url: 'https://app.tail750ac6.ts.net/' }));
    app.store.insert(project(root, { port: 3001, url: 'http://localhost:3001/', hostname: 'workstation' }));
    app.store.insert(project(root, { kind: 'service', url: 'https://bookmark.example/' }));
    app.store.insert(project(root, { url: 'http://inject;frame-ancestors.example/' }));
    app.store.insert(project(root, { url: 'http://[::1]:3002/' }));
    const sources = await ancestors();
    expect(sources.has('https://app.tail750ac6.ts.net')).toBe(true);
    expect(sources.has('http://workstation:3001')).toBe(true);
    expect([...sources].some(source => source.includes('bookmark.example') || source.includes('inject'))).toBe(false);
    expect([...sources].some(source => source.includes('::1'))).toBe(false);
  });

  test('leaves every other page, the bridge page, and missing files as they were', async () => {
    for (const route of ['/', '/index.html', '/notes.html', '/assets/app-abcdef12.js', '/some/client/route']) {
      const response = await app.fetch(request(route));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBeNull();
      expect(response.headers.get('x-frame-options')).toBeNull();
    }
    expect((await app.fetch(request('/api/extension/bridge'))).headers.get('content-security-policy')).toContain('frame-ancestors chrome-extension:;');
    expect((await app.fetch(request('/api/extension/bridge'))).headers.get('content-security-policy')).not.toContain('beelinkk');
    expect((await app.fetch(request('/api/health'))).headers.get('content-security-policy')).toBeNull();
    // Navigations to an index.html-style route still get the app shell, with the shell's own caching.
    expect((await app.fetch(request('/'))).headers.get('cache-control')).toContain('stale-while-revalidate');
  });

  test('a build without the embed page is a plain 404, not the app shell', async () => {
    await cleanup(path.join(root, 'dist/embed.html'));
    const response = await app.fetch(request('/embed.html'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});
