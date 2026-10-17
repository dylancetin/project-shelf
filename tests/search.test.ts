import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../server/app';
import { SEARCH_ENGINES, type SearchEngine } from '../shared/search';
import { cleanup, fixture, request } from './helpers';

describe('browser search engine', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    app = await createApp({ dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [] } });
  });
  afterEach(async () => { await app.close(); });

  async function search(query: string, method = 'GET') {
    const response = await app.fetch(request(`/search?q=${encodeURIComponent(query)}`, method));
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toBe('');
    return response.headers.get('location')!;
  }

  test('redirects directly without a frontend build, using the same leading/trailing bangs as Home', async () => {
    expect(await search('!gh bun sqlite')).toBe('https://github.com/search?utf8=%E2%9C%93&q=bun%20sqlite');
    expect(await search('bun sqlite !GH')).toBe('https://github.com/search?utf8=%E2%9C%93&q=bun%20sqlite');
    expect(await search('  !yt bun tutorials  ')).toBe('https://www.youtube.com/results?search_query=bun%20tutorials');
    expect(await search('!t3 explain caching')).toBe('https://www.t3.chat/new?q=explain%20caching');
    expect(await search('!ghr t3-content/unduck')).toBe('https://github.com/t3-content/unduck');
    expect(await search('!pdf bun sqlite')).toBe('https://duckduckgo.com/?q=bun%20sqlite+filetype:pdf');
    expect(await search('!gh')).toBe('https://github.com/');
    expect(await search('!w', 'HEAD')).toBe('https://en.wikipedia.org/');
    expect((await app.fetch(request('/search/?q=%21gh'))).headers.get('location')).toBe('https://github.com/');
  });

  test('plain text and unknown bangs default to DuckDuckGo, not local navigation or a caller-supplied redirect', async () => {
    expect((await (await app.fetch(request('/api/settings'))).json()).settings.defaultSearchEngine).toBe('duckduckgo');
    for (const [query, expected] of [
      ['sonarr', 'sonarr'], ['hello!world', 'hello!world'], ['!', '!'],
      ['!not-a-real-shelf-bang café & tea?#', 'café & tea?#'],
      ['!dauser not a valid subdomain', 'not a valid subdomain'],
      ['javascript:alert(1)', 'javascript:alert(1)'], ['https://example.test/path', 'https://example.test/path'],
    ]) {
      const destination = new URL(await search(query));
      expect(destination.origin).toBe('https://duckduckgo.com');
      expect(destination.searchParams.get('q')).toBe(expected);
    }
    expect(app.store.list()).toHaveLength(0);
  });

  test('saved engine changes apply immediately to plain searches and unknown bangs, but never override explicit bangs', async () => {
    for (const engine of Object.keys(SEARCH_ENGINES) as SearchEngine[]) {
      const changed = await app.fetch(request('/api/settings', 'PATCH', { defaultSearchEngine: engine }));
      expect(changed.status).toBe(200);
      expect((await changed.json()).settings.defaultSearchEngine).toBe(engine);
      const [, name, domain] = SEARCH_ENGINES[engine];
      for (const query of ['bun sqlite', '!not-a-real-shelf-bang bun sqlite', '!dauser bun sqlite']) {
        const destination = new URL(await search(query));
        expect(destination.hostname).toBe(domain);
        expect(destination.searchParams.get('q')).toBe('bun sqlite');
      }
      expect(new URL(await search('!g bun')).origin).toBe('https://www.google.com');
      expect(new URL(await search('!ddg bun')).hostname).toBe('duckduckgo.com');
      expect(new URL(await search('!gh bun')).origin).toBe('https://github.com');
      const description = await (await app.fetch(request('/opensearch.xml'))).text();
      expect(description).toContain(`Plain searches use ${name}.`);
    }
    for (const value of ['', 'DuckDuckGo', 'https://evil.test', 'javascript:alert(1)', '__proto__', 'constructor', null, 1, {}, []]) {
      const invalid = await app.fetch(request('/api/settings', 'PATCH', { defaultSearchEngine: value }));
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toContain('defaultSearchEngine');
      expect(app.store.settings().defaultSearchEngine).toBe('brave');
    }
    const denied = await app.fetch(request('/api/settings', 'PATCH', { defaultSearchEngine: 'google' }, { Origin: 'https://evil.test' }));
    expect(denied.status).toBe(403);
    expect(app.store.settings().defaultSearchEngine).toBe('brave');
  });

  test('legacy preferences gain DuckDuckGo without losing edits, and chosen engines persist across restarts', async () => {
    const root = await fixture();
    try {
      await app.close();
      const options = { dbPath: `${root}/panel.sqlite`, bootstrap: false, initialSettings: { roots: [root] } };
      app = await createApp(options);
      const { defaultSearchEngine: _, ...legacy } = { ...app.store.settings(), hostnames: ['saved-host'], defaultHostname: 'saved-host', lastScanAt: '2026-10-17T12:00:00.000Z' };
      app.store.setValue('settings', legacy);
      const registered = await app.fetch(request('/api/projects', 'POST', { name: 'Persisted service', kind: 'service', url: 'https://example.test/', hidden: true }));
      expect(registered.status).toBe(201);
      const saved = (await registered.json()).project;
      await app.close();
      app = await createApp(options);
      expect(app.store.settings()).toEqual({ ...legacy, defaultSearchEngine: 'duckduckgo' });
      expect(new URL(await search('bun')).hostname).toBe('duckduckgo.com');
      expect((await app.fetch(request('/api/settings', 'PATCH', { defaultSearchEngine: 'google' }))).status).toBe(200);
      await app.close();
      app = await createApp(options);
      expect(app.store.settings()).toEqual({ ...legacy, defaultSearchEngine: 'google' });
      expect(new URL(await search('bun')).hostname).toBe('www.google.com');
      expect(app.store.get(saved.id)).toMatchObject({ name: 'Persisted service', hidden: true, url: 'https://example.test/' });
      expect((await app.fetch(request('/api/settings', 'PATCH', { roots: [] }))).status).toBe(200);
      expect(app.store.settings().defaultSearchEngine).toBe('google');
    } finally {
      await app.close();
      await cleanup(root);
    }
  });

  test('preserves Unicode, plus signs, delimiters and literal percent encodings without double decoding', async () => {
    const query = 'café 日本語 C++ & tea? #fragment %2F / <script>\r\nLocation: https://evil.test';
    const destination = new URL(await search(query));
    expect(destination.searchParams.get('q')).toBe(query);
    const formEncoded = await app.fetch(request('/search?q=%21g+C%2B%2B+%26+tea%3F'));
    expect(new URL(formEncoded.headers.get('location')!).searchParams.get('q')).toBe('C++ & tea?');
  });

  test('missing/blank queries return Home without redirect loops, and mutation methods are rejected', async () => {
    for (const route of ['/search', '/search?q=', '/search?q=+%20']) {
      const response = await app.fetch(request(route));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
    }
    for (const route of ['/search?q=%21g+test', '/opensearch.xml']) {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        expect((await app.fetch(request(route, method))).status).toBe(405);
      }
      expect((await app.fetch(request(route, 'POST', {}, { Origin: 'https://evil.test' }))).status).toBe(403);
    }
  });

  test('OpenSearch uses the requested origin across LAN aliases, ports and HTTPS, not project hostname settings', async () => {
    for (const origin of [
      'http://beelinkk:4958', 'http://192.168.1.50:4958', 'http://100.119.176.63:4958',
      'http://beelinkk.tail750ac6.ts.net:4958', 'https://beelinkk.tail750ac6.ts.net',
    ]) {
      const response = await app.fetch(new Request(`${origin}/opensearch.xml`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/opensearchdescription+xml; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const xml = await response.text();
      expect(xml).toContain('<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">');
      expect(xml).toContain(`template="${origin}/search?q={searchTerms}"`);
      expect(xml).toContain('<InputEncoding>UTF-8</InputEncoding>');
    }
    const head = await app.fetch(request('/opensearch.xml', 'HEAD'));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const proxied = await app.fetch(new Request('http://beelinkk.tail750ac6.ts.net/opensearch.xml', { headers: { 'X-Forwarded-Proto': 'https' } }));
    expect(await proxied.text()).toContain('template="https://beelinkk.tail750ac6.ts.net/search?q={searchTerms}"');
    const escaped = await app.fetch(new Request('http://shelf&test/opensearch.xml'));
    expect(await escaped.text()).toContain('template="http://shelf&amp;test/search?q={searchTerms}"');
  });
});
