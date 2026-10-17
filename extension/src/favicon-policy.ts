// An exact, optional grant: never ask for access to bookmarked websites.
export const FAVICON_PROVIDER_ORIGIN = 'https://icons.duckduckgo.com/*';
export const FAVICON_PROVIDER_BASE = 'https://icons.duckduckgo.com/ip3/';

export function faviconLocation(value: string): { origin: string; page: string } | null {
  try {
    if (value.length > 16_384) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { origin: url.origin, page: url.href };
  } catch { return null; }
}

// Be deliberately conservative. Names used by LANs, VPNs, special-use DNS,
// wildcard-IP services and development environments are not public websites.
const privateLabels = new Set(['localhost', 'local', 'localdomain', 'lan', 'home', 'internal', 'intranet', 'private', 'corp', 'test', 'example', 'invalid']);
const privateSuffixes = [
  'home.arpa', 'arpa', 'onion', 'i2p', 'ts.net', 'tailscale.net', 'nip.io', 'sslip.io',
  'localtest.me', 'lvh.me', 'vcap.me', 'traefik.me', 'example.com', 'example.net', 'example.org',
];

export function publicFaviconHostname(value: string): string | null {
  const location = faviconLocation(value);
  if (!location) return null;
  const url = new URL(location.page);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Nonstandard ports commonly identify private/self-hosted services. All IP
  // literals (including URL-normalized integer/hex IPv4 and IPv6) stay local.
  if (url.port || host.length > 253 || /^[\d.]+$/.test(host) || host.includes(':') || host.includes('[')) return null;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || privateLabels.has(label))) return null;
  if (!/^[a-z]{2,63}$/.test(labels.at(-1)!)) return null;
  if (privateSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return null;
  return host;
}

export function faviconProviderUrl(hostname: string): string {
  // Callers only pass a hostname accepted by publicFaviconHostname. Encoding is
  // defense-in-depth: paths, query strings, ports and credentials cannot escape.
  return `${FAVICON_PROVIDER_BASE}${encodeURIComponent(hostname)}.ico`;
}
