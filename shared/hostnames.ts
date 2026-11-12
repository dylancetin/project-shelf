import type { Settings } from './types';

export const DEFAULT_HOSTNAMES = ['beelinkk', '192.168.1.50', 'beelinkk.tail750ac6.ts.net', '100.119.176.63'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export const isLoopbackHostname = (hostname: string): boolean => LOOPBACK_HOSTNAMES.includes(hostname.toLowerCase());

/** The names another machine uses to reach this one: the built-in names and the saved Network hostnames. */
export function networkAliases(hostnames: readonly string[]): Set<string> {
  return new Set([...DEFAULT_HOSTNAMES, ...hostnames].map(name => name.toLowerCase()));
}

/**
 * Every hostname that reaches this machine's own servers: the network names and loopback.
 * Loopback only means this machine in a browser running on it; for a browser elsewhere,
 * `localhost` is that other machine, so page matching uses {@link networkAliases} there.
 */
export function serverAliases(hostnames: readonly string[]): Set<string> {
  return new Set([...networkAliases(hostnames), ...LOOPBACK_HOSTNAMES]);
}

/** Direct server links can use the preferred host; virtual hosts must stay intact. */
export function serviceHostname(url: string, settings: Pick<Settings, 'hostnames' | 'defaultHostname'>): string {
  return serverAliases(settings.hostnames).has(new URL(url).hostname) ? settings.defaultHostname : '';
}
