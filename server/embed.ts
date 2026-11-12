import { serverAliases } from '../shared/hostnames';
import { projectPageOrigins } from '../shared/runtime-targets';
import type { Settings } from '../shared/types';
import type { ProjectData } from './store';

export const EMBED_PAGE = 'embed.html';

// CSP host-source syntax: hostnames and IPv4 only. Other characters (including `;`, which URL
// parsing allows in a host) could end the directive, and IPv6 literals are not valid sources.
const CSP_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * `frame-ancestors` for /embed.html: this panel, browser extensions, and the pages the resolver can match
 * to a runtime. That is every server alias on any port, plus the addresses of registered projects, which
 * cover reverse-proxy dev pages that have no alias hostname.
 */
export function embedFramingPolicy(settings: Pick<Settings, 'hostnames'>, projects: readonly Pick<ProjectData, 'kind' | 'url' | 'hostname'>[]): string {
  const aliases = serverAliases(settings.hostnames);
  const sources = new Set(["'self'", 'chrome-extension:']);
  for (const host of aliases) {
    if (CSP_HOST.test(host)) { sources.add(`http://${host}:*`); sources.add(`https://${host}:*`); }
  }
  for (const project of projects) {
    if (project.kind !== 'project') continue;
    for (const origin of projectPageOrigins(project)) {
      const { protocol, hostname, port } = new URL(origin);
      if (!aliases.has(hostname) && CSP_HOST.test(hostname)) sources.add(`${protocol}//${hostname}${port ? `:${port}` : ''}`);
    }
  }
  return `frame-ancestors ${[...sources].join(' ')}`;
}
