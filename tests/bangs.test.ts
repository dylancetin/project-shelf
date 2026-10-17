import { describe, expect, test } from 'bun:test';
import entries from '../src/data/bangs.json';
import { parseBang, resolveBang, resolveWebSearch, type Bang, type BangCatalog } from '../shared/bangs';
import { SEARCH_ENGINES, type SearchEngine } from '../shared/search';

const catalog: BangCatalog = new Map(entries.map(([trigger, name, domain, template]) => [trigger, [trigger, name, domain, template] satisfies Bang]));

describe('local bang search', () => {
  test('normal searches and embedded punctuation stay local', () => {
    for (const query of ['', 'sonarr', 'hello!world', 'https://example.test/path!part']) expect(parseBang(query)).toBeNull();
    expect(parseBang('!')).toEqual({ trigger: '', search: '' });
    expect(parseBang('!GH react hooks')).toEqual({ trigger: 'gh', search: 'react hooks' });
    expect(parseBang('react !gh hooks')).toEqual({ trigger: 'gh', search: 'react hooks' });
    expect(parseBang('react hooks !gh')).toEqual({ trigger: 'gh', search: 'react hooks' });
    expect(parseBang('!gh react !g')).toEqual({ trigger: 'gh', search: 'react !g' });
  });

  test('resolves searches locally, safely encodes Unicode and special characters, and preserves repository slashes', () => {
    const google = resolveBang(parseBang('!g café & tea?#')!, catalog)!;
    expect(new URL(google.url).searchParams.get('q')).toBe('café & tea?#');
    expect(google).toMatchObject({ name: 'Google', fallback: false });
    expect(resolveBang(parseBang('!ghr t3-content/unduck')!, catalog)?.url).toBe('https://github.com/t3-content/unduck');
    expect(resolveBang(parseBang('!yt bun tutorials')!, catalog)?.url).toBe('https://www.youtube.com/results?search_query=bun%20tutorials');
    expect(resolveBang(parseBang('!w Bun runtime')!, catalog)?.name).toBe('Wikipedia');
    expect(resolveBang(parseBang('!t3 explain caching')!, catalog)?.url).toBe('https://www.t3.chat/new?q=explain%20caching');
  });

  test('bare bangs open the homepage, and unknown bangs default to DuckDuckGo', () => {
    expect(resolveBang(parseBang('!gh')!, catalog)?.url).toBe('https://github.com/');
    expect(resolveBang(parseBang('!npmx')!, catalog)?.url).toBe('https://npmx.dev/');
    expect(resolveBang(parseBang('!not-a-real-shelf-bang query')!, catalog)).toMatchObject({ trigger: 'ddg', name: 'DuckDuckGo', search: 'query', fallback: true });
    expect(resolveBang(parseBang('!')!, catalog)).toBeNull();
  });

  test('all default engines encode queries safely and only unknown bangs follow the preference', () => {
    for (const engine of Object.keys(SEARCH_ENGINES) as SearchEngine[]) {
      const [, name, domain] = SEARCH_ENGINES[engine];
      const query = 'café 日本語 C++ & tea?# %2F';
      const plain = resolveWebSearch(query, engine);
      expect(plain.name).toBe(name);
      expect(new URL(plain.url).hostname).toBe(domain);
      expect(new URL(plain.url).searchParams.get('q')).toBe(query);
      expect(resolveBang({ trigger: 'not-a-real-shelf-bang', search: query }, catalog, engine)).toMatchObject({ name, search: query, url: plain.url, fallback: true });
      expect(resolveBang({ trigger: 'g', search: query }, catalog, engine)).toMatchObject({ name: 'Google', fallback: false });
      expect(resolveBang({ trigger: 'ddg', search: query }, catalog, engine)).toMatchObject({ name: 'DuckDuckGo', fallback: false });
      expect(resolveBang({ trigger: 'gh', search: query }, catalog, engine)).toMatchObject({ name: 'GitHub', fallback: false });
    }
  });

  test('relative upstream templates use DuckDuckGo, never the panel origin; unsafe destinations are rejected', () => {
    expect(resolveBang(parseBang('!pdf bun sqlite')!, catalog)?.url).toBe('https://duckduckgo.com/?q=bun%20sqlite+filetype:pdf');
    for (const template of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.test/?q={{{s}}}']) {
      const unsafe: BangCatalog = new Map([['unsafe', ['unsafe', 'Unsafe', 'example.test', template]]]);
      expect(resolveBang({ trigger: 'unsafe', search: 'test' }, unsafe)).toBeNull();
    }
  });

  test('the full imported catalog has unique triggers and resolves only HTTP(S) destinations', () => {
    expect(entries.length).toBe(13570);
    expect(catalog.size).toBe(entries.length);
    for (const [trigger] of catalog) {
      for (const search of ['', 'shelf']) {
        const result = resolveBang({ trigger, search }, catalog);
        expect(result).not.toBeNull();
        expect(['http:', 'https:']).toContain(new URL(result!.url).protocol);
      }
    }
    expect(resolveBang({ trigger: 'dauser', search: 'not a valid subdomain' }, catalog)).toBeNull();
  });
});
