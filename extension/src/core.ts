export interface ExtensionSettings {
  url: string;
}

export const SETTINGS_KEY = 'project-shelf.settings';
export const DEFAULT_URL = 'http://beelinkk:4958/';

export function normalizeUrl(value: string): string {
  const input = value.trim();
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error('Enter a full address, including http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Use an http:// or https:// Project Shelf address.');
  }
  if (url.hostname.includes('*')) throw new Error('Use a single server hostname, not a wildcard.');
  if (url.username || url.password) throw new Error('Do not include a username or password in the address.');
  if (/\s/.test(input)) throw new Error('The address cannot contain spaces or line breaks.');
  return url.href;
}

export function parseSettings(value: unknown): ExtensionSettings | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string') {
    throw new Error('Your saved extension settings could not be read. Open extension settings and save your address again.');
  }
  // v1.0's checkBeforeOpen is deliberately ignored: native new tabs never gate
  // rendering on a server check, and existing configured addresses are retained.
  return { url: normalizeUrl(value.url) };
}

export function appBaseUrl(value: string): string {
  const url = new URL(normalizeUrl(value));
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export function bridgeUrl(value: string): string { return new URL('api/extension/bridge', appBaseUrl(value)).href; }
export function extensionSnapshotKey(value: string): string { return `project-shelf.extension.snapshot.v1:${appBaseUrl(value)}`; }

export function permissionOrigin(value: string): string {
  const url = new URL(normalizeUrl(value));
  // Chrome host permissions are hostname-scoped: the grant includes every port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function manageUrl(value: string): string {
  const url = new URL(normalizeUrl(value));
  url.hash = 'manage';
  return url.href;
}

export function healthUrl(value: string): string {
  const url = new URL(normalizeUrl(value));
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/health`;
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function checkConnection(value: string, request: typeof fetch = fetch, timeoutMs = 2500): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(healthUrl(value), {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`Your shelf returned HTTP ${response.status}. Check the server or choose Open anyway.`);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error('This address did not return a Project Shelf health response. Check the address or choose Open anyway.'); }
    if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true) {
      throw new Error('This address did not return a Project Shelf health response. Check the address or choose Open anyway.');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Your shelf took too long to answer. Check your network or Tailscale connection, then try again.');
    if (error instanceof TypeError) throw new Error('Could not reach your shelf. Check the server, network, or Tailscale connection.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
