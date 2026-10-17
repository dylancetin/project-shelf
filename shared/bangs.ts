import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, type SearchEngine } from './search';

export type Bang = readonly [trigger: string, name: string, domain: string, template: string];
export type BangCatalog = ReadonlyMap<string, Bang>;
export interface BangQuery { trigger: string; search: string }
export interface BangResult { trigger: string; name: string; search: string; url: string; fallback: boolean }

export function parseBang(query: string): BangQuery | null {
  // Only standalone bang tokens switch out of local search, not punctuation
  // inside a project name, URL, or normal sentence ("hello!world").
  const match = query.match(/(?:^|\s)!([^\s!]*)/);
  if (!match) return null;
  return { trigger: match[1].toLowerCase(), search: query.replace(/(?:^|\s)![^\s!]*\s*/, ' ').trim() };
}

export function resolveBang(query: BangQuery, catalog: BangCatalog, defaultSearchEngine: SearchEngine = DEFAULT_SEARCH_ENGINE): BangResult | null {
  if (!query.trigger) return null;
  const found = catalog.get(query.trigger);
  return resolveTarget(query, found ?? SEARCH_ENGINES[defaultSearchEngine], !found);
}

export function resolveWebSearch(search: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): BangResult {
  const bang = SEARCH_ENGINES[engine];
  // Provider templates are fixed, validated HTTPS URLs, independent of the catalog.
  return resolveTarget({ trigger: bang[0], search }, bang, false)!;
}

function resolveTarget(query: BangQuery, bang: Bang, fallback: boolean): BangResult | null {
  const [trigger, name, domain, template] = bang;
  try {
    // The source catalog contains a few DuckDuckGo-relative search templates.
    // Never resolve these against the panel's own origin.
    const base = new URL(template.replaceAll('{{{s}}}', 'search'), 'https://duckduckgo.com');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const encoded = encodeURIComponent(query.search).replace(/%2F/g, '/');
    let url = query.search ? new URL(template.replaceAll('{{{s}}}', encoded), 'https://duckduckgo.com') : new URL(base.origin);
    const staticDomain = domain.split('.').filter(part => !part.includes('{{{s}}}')).join('.');
    if (!query.search && staticDomain) {
      try {
        const homepage = new URL(`https://${staticDomain}`);
        if (homepage.hostname.includes('.') && !homepage.username && !homepage.password) url = homepage;
      } catch { /* Missing/malformed domains use the valid search origin. */ }
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { trigger, name, search: query.search, url: url.href, fallback };
  } catch { return null; }
}
