import { FAVICON_PROVIDER_ORIGIN } from './favicon-policy';

/** Match patterns for dev pages on one hostname. Chrome match patterns without a port cover every port. */
export function hostPattern(scheme: 'http' | 'https', hostname: string): string | null {
  try {
    const url = new URL(`${scheme}://${hostname}`);
    if (!url.hostname || url.hostname.includes('*') || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return `${scheme}://${url.hostname}/*`;
  } catch { return null; }
}

/**
 * What the bubble needs on one hostname. An http panel can only frame into http pages (an https
 * page would block it as mixed content), so its host grant already covers every page it can serve.
 * An https panel can frame into both, and its own grant covers only the https half.
 */
export function bubblePatterns(hostname: string, panelProtocol: string): string[] {
  const schemes: ('http' | 'https')[] = panelProtocol === 'https:' ? ['http', 'https'] : ['http'];
  return schemes.flatMap(scheme => hostPattern(scheme, hostname) ?? []);
}

const EXACT_HOST = /^https?:\/\/[^*/]+\/\*$/;

/** The content script is matched only on exact hosts the user granted, never on "all sites" or wildcard grants. */
export function bubbleMatches(grantedOrigins: readonly string[]): string[] {
  return [...new Set(grantedOrigins.filter(origin => EXACT_HOST.test(origin) && origin !== FAVICON_PROVIDER_ORIGIN))].sort();
}

export function sameMatches(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function patternHostname(pattern: string): string {
  return pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
}

/** Whether a page can host the bubble at all. The embed still decides if the page is a dev server. */
export function canHostBubble(page: { origin: string; protocol: string }, panel: { origin: string; protocol: string }): boolean {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  if (page.origin === panel.origin) return false;
  return !(page.protocol === 'https:' && panel.protocol === 'http:');
}

/** The only part of a tab's address that is passed to the panel: paths and queries can carry secrets. */
export function pageOrigin(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch { return ''; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Hostnames from a `GET /api/settings` body, normalized and deduplicated. Entries with ports, paths or wildcards are dropped. */
export function parseHostnames(body: unknown): string[] {
  const settings = isRecord(body) ? body.settings : null;
  const list = isRecord(settings) && Array.isArray(settings.hostnames) ? settings.hostnames.slice(0, 100) : [];
  const names = new Set<string>();
  for (const item of list) {
    const pattern = typeof item === 'string' ? hostPattern('http', item.trim()) : null;
    if (pattern) names.add(patternHostname(pattern));
  }
  return [...names];
}
