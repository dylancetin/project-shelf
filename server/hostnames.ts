import type { Settings } from '../shared/types';
import { DEFAULT_HOSTNAMES } from './store';

/** Direct server links can use the preferred host; virtual hosts must stay intact. */
export function serviceHostname(url: string, settings: Settings): string {
  const aliases = new Set([...DEFAULT_HOSTNAMES, ...settings.hostnames, 'localhost', '127.0.0.1', '[::1]']);
  return aliases.has(new URL(url).hostname) ? settings.defaultHostname : '';
}
