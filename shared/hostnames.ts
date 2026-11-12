import type { Settings } from './types';

export const DEFAULT_HOSTNAMES = ['beelinkk', '192.168.1.50', 'beelinkk.tail750ac6.ts.net', '100.119.176.63'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Every hostname that reaches this machine's own servers: the built-in names, the saved Network hostnames and loopback. */
export function serverAliases(hostnames: readonly string[]): Set<string> {
  return new Set([...DEFAULT_HOSTNAMES, ...hostnames, ...LOOPBACK_HOSTNAMES].map(name => name.toLowerCase()));
}

/** Direct server links can use the preferred host; virtual hosts must stay intact. */
export function serviceHostname(url: string, settings: Pick<Settings, 'hostnames' | 'defaultHostname'>): string {
  return serverAliases(settings.hostnames).has(new URL(url).hostname) ? settings.defaultHostname : '';
}
