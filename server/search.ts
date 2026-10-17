import { parseBang, resolveBang, resolveWebSearch, type Bang, type BangCatalog } from '../shared/bangs';
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, type SearchEngine } from '../shared/search';
import entries from '../src/data/bangs.json';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
let catalog: BangCatalog | undefined;

export function searchRedirect(url: URL, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): Response {
  const query = (url.searchParams.get('q') ?? '').trim();
  let destination = '/';
  if (query) {
    catalog ??= new Map(entries.map(([trigger, name, domain, template]) => [trigger, [trigger, name, domain, template] satisfies Bang]));
    const bang = parseBang(query);
    // Plain queries (including a lone '!') use the saved engine. Malformed targets
    // also fall back safely instead of returning an unusable browser search.
    const result = bang?.trigger ? resolveBang(bang, catalog, engine) : null;
    destination = (result ?? resolveWebSearch(bang?.trigger ? bang.search || query : query, engine)).url;
  }
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: destination } });
}

export function openSearchDescription(request: Request, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): Response {
  // Derive the template from this request, not the preferred project hostname:
  // LAN aliases, non-default ports, and HTTPS reverse proxies all stay usable.
  const address = new URL(request.url);
  // TLS can terminate at Tailscale Serve. This affects only discovery metadata,
  // never the origin checks that protect API mutations.
  if (request.headers.get('x-forwarded-proto') === 'https') address.protocol = 'https:';
  const origin = address.origin.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Project Shelf</ShortName>
  <Description>Search the web with Project Shelf bang shortcuts. Plain searches use ${SEARCH_ENGINES[engine][1]}.</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="${origin}/search?q={searchTerms}" />
</OpenSearchDescription>`;
  return new Response(request.method === 'HEAD' ? null : xml, {
    headers: { ...HEADERS, 'Content-Type': 'application/opensearchdescription+xml; charset=utf-8' },
  });
}
