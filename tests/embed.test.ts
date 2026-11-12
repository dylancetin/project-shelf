import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
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

  const embed = (search: string, base = 'http://shelf.test') => new Request(`${base}/embed.html${search}`);
  const bubble = (page: string) => `?surface=bubble&url=${encodeURIComponent(page)}`;
  async function ancestors(search = '', { base, route = '/embed.html', method = 'GET' }: { base?: string; route?: string; method?: string } = {}) {
    const response = await app.fetch(route === '/embed.html' && method === 'GET' ? embed(search, base) : new Request(`${base ?? 'http://shelf.test'}${route}${search}`, { method }));
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy');
    expect(policy).not.toBeNull();
    expect(policy).toStartWith('frame-ancestors ');
    expect(policy!.split(';')).toHaveLength(1);
    return new Set(policy!.slice('frame-ancestors '.length).split(' '));
  }

  test('serves the page with no X-Frame-Options and revalidates it every time', async () => {
    const response = await app.fetch(embed(bubble('http://beelinkk:5173/')));
    expect(await response.text()).toBe('<html>Embedded controls</html>');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  test('the bubble may be framed by its own page origin and by nothing else', async () => {
    expect(await ancestors(bubble('http://beelinkk:5173/some/path?token=x#frag'))).toEqual(new Set(["'self'", 'http://beelinkk:5173']));
    expect(await ancestors(bubble('https://BEELINKK:5173'))).toEqual(new Set(["'self'", 'https://beelinkk:5173']));
    expect(await ancestors(bubble('http://beelinkk/'))).toEqual(new Set(["'self'", 'http://beelinkk']));
    expect(await ancestors(bubble('http://devbox.lan:3000/'))).toEqual(new Set(["'self'", 'http://devbox.lan:3000']));
    // A page on another port of the same machine is not in the policy for this one, so it cannot frame the bubble for it.
    const own = await ancestors(bubble('http://beelinkk:5173/'));
    for (const hostile of ['http://beelinkk:3000', 'https://beelinkk:5173', 'http://192.168.1.50:5173', 'http://beelinkk']) expect(own.has(hostile)).toBe(false);
    expect([...own].some(source => source.includes('*') || source === 'chrome-extension:')).toBe(false);
  });

  test('the popup is the extension’s page: only this panel and extensions may frame it, whatever url says', async () => {
    const expected = new Set(["'self'", 'chrome-extension:']);
    for (const search of ['', '?surface=popup', '?surface=popup&url=http%3A%2F%2Fbeelinkk%3A3000%2F', '?url=http%3A%2F%2Fbeelinkk%3A3000%2F',
      '?surface=sidebar&url=http%3A%2F%2Fbeelinkk%3A3000%2F', '?surface=BUBBLE&url=http%3A%2F%2Fbeelinkk%3A3000%2F']) {
      expect(await ancestors(search)).toEqual(expected);
    }
  });

  test('a bubble url that is missing, malformed, or not a server page gets this panel alone', async () => {
    app.store.insert(project(root, { url: 'http://inject;frame-ancestors.example/' }));
    app.store.insert(project(root, { url: 'http://[::1]:3002/' }));
    app.store.insert(project(root, { kind: 'service', url: 'https://bookmark.example/' }));
    for (const search of ['?surface=bubble', '?surface=bubble&url=', ...[
      'not a url', 'beelinkk:3000', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://beelinkk:21/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      'https://evil.example/', 'http://evil.example:3000/', 'http://beelinkk.evil.example:3000/', 'http://inject;frame-ancestors.example/',
      'http://[::1]:3002/', 'https://bookmark.example/', 'https://app.tail750ac6.ts.net/', 'http://localhost:3000/', 'http://127.0.0.1:3000/',
    ].map(bubble)]) {
      expect(await ancestors(search)).toEqual(new Set(["'self'"]));
    }
  });

  test('reads surface and url the way the page does', async () => {
    expect(await ancestors('?surface=popup&surface=bubble&url=http%3A%2F%2Fbeelinkk%3A1%2F')).toEqual(new Set(["'self'", 'chrome-extension:']));
    expect(await ancestors('?surface=bubble&surface=popup&url=http%3A%2F%2Fbeelinkk%3A1%2F&url=http%3A%2F%2Fbeelinkk%3A2%2F'))
      .toEqual(new Set(["'self'", 'http://beelinkk:1']));
    expect(await ancestors('?surface=bubble&url=http%3A%2F%2Fbeelinkk%3A1%2F%23a%26url%3Dhttp%3A%2F%2Fbeelinkk%3A2%2F')).toEqual(new Set(["'self'", 'http://beelinkk:1']));
  });

  test('applies to HEAD requests and every path spelling of the file', async () => {
    const search = bubble('http://beelinkk:5173/');
    const own = new Set(["'self'", 'http://beelinkk:5173']);
    expect(await ancestors(search, { route: '/embed.html', method: 'HEAD' })).toEqual(own);
    expect(await ancestors(search, { route: '/%65mbed.html' })).toEqual(own);
  });

  test('follows Network hostname edits immediately', async () => {
    const page = bubble('http://newhost.lan:5173/');
    expect((await ancestors(page)).has('http://newhost.lan:5173')).toBe(false);
    expect((await ancestors(bubble('http://devbox.lan:5173/'))).has('http://devbox.lan:5173')).toBe(true);
    const saved = await app.fetch(request('/api/settings', 'PATCH', { hostnames: ['beelinkk', 'newhost.lan'] }));
    expect(saved.status).toBe(200);
    expect((await ancestors(page)).has('http://newhost.lan:5173')).toBe(true);
    expect((await ancestors(bubble('https://newhost.lan:5173/'))).has('https://newhost.lan:5173')).toBe(true);
    expect((await ancestors(bubble('http://devbox.lan:5173/'))).has('http://devbox.lan:5173')).toBe(false);
  });

  test('registered project addresses cover reverse-proxy dev pages, exact origin only, never services', async () => {
    app.store.insert(project(root, { port: 3000, url: 'https://app.tail750ac6.ts.net/' }));
    app.store.insert(project(root, { port: 3001, url: 'http://localhost:3001/', hostname: 'workstation' }));
    app.store.insert(project(root, { kind: 'service', url: 'https://bookmark.example/' }));
    expect(await ancestors(bubble('https://app.tail750ac6.ts.net/dashboard'))).toEqual(new Set(["'self'", 'https://app.tail750ac6.ts.net']));
    expect(await ancestors(bubble('http://workstation:3001/'))).toEqual(new Set(["'self'", 'http://workstation:3001']));
    for (const page of ['http://app.tail750ac6.ts.net/', 'https://app.tail750ac6.ts.net:8443/', 'https://other.tail750ac6.ts.net/', 'http://workstation:3002/', 'https://bookmark.example/']) {
      expect(await ancestors(bubble(page))).toEqual(new Set(["'self'"]));
    }
  });

  test('loopback names are allowed only when the page was requested from loopback', async () => {
    app.store.insert(project(root, { port: 3001, url: 'http://localhost:3001/', hostname: 'workstation' }));
    for (const page of ['http://localhost:3000/', 'http://127.0.0.1:3000/', 'http://localhost:3001/']) {
      expect(await ancestors(bubble(page))).toEqual(new Set(["'self'"]));
      expect(await ancestors(bubble(page), { base: 'https://panel.tail750ac6.ts.net' })).toEqual(new Set(["'self'"]));
    }
    expect(await ancestors(bubble('http://localhost:3000/'), { base: 'http://127.0.0.1:4958' })).toEqual(new Set(["'self'", 'http://localhost:3000']));
    expect(await ancestors(bubble('http://127.0.0.1:3000/'), { base: 'http://localhost:4958' })).toEqual(new Set(["'self'", 'http://127.0.0.1:3000']));
    expect(await ancestors(bubble('http://localhost:3001/'), { base: 'http://localhost:4958' })).toEqual(new Set(["'self'", 'http://localhost:3001']));
    expect(await ancestors(bubble('http://beelinkk:3000/'), { base: 'http://127.0.0.1:4958' })).toEqual(new Set(["'self'", 'http://beelinkk:3000']));
    // The popup never lists loopback, nor any http origin.
    expect(await ancestors('?surface=popup', { base: 'http://127.0.0.1:4958' })).toEqual(new Set(["'self'", 'chrome-extension:']));
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
