import { isLoopbackHostname, networkAliases, serverAliases } from '../shared/hostnames';
import { readEmbedParams } from '../shared/embed';
import { projectPageOrigins } from '../shared/runtime-targets';
import type { Settings } from '../shared/types';
import type { ProjectData } from './store';

export const EMBED_PAGE = 'embed.html';

// CSP host-source syntax: hostnames and IPv4 only. Other characters (including `;`, which URL parsing
// allows in a host) could end the directive, and IPv6 literals are not valid sources.
const CSP_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * `frame-ancestors` for one /embed.html request. The embed acts on whatever page `url` names, so a page must
 * only ever be able to frame the controls for its own origin: the bubble is framed by exactly that origin,
 * and only when it is one the resolver can match to a runtime (a server alias on any port, or a registered
 * project's address). The popup is the extension's own page. `request` is the embed's address; it is
 * read with the same parser the page uses, so both sides agree on the surface and the page.
 */
export function embedFramingPolicy(
  request: URL, settings: Pick<Settings, 'hostnames'>, projects: readonly Pick<ProjectData, 'kind' | 'url' | 'hostname'>[],
): string {
  const { surface, pageUrl } = readEmbedParams(request.search);
  if (surface === 'popup') return "frame-ancestors 'self' chrome-extension:";
  // Loopback names are this machine only for a browser on it, which is what a loopback request address means.
  const loopback = isLoopbackHostname(request.hostname);
  const origin = pageUrl && framableOrigin(pageUrl, (loopback ? serverAliases : networkAliases)(settings.hostnames), projects, loopback);
  return `frame-ancestors ${["'self'", ...(origin ? [origin] : [])].join(' ')}`;
}

function framableOrigin(page: URL, aliases: ReadonlySet<string>, projects: readonly Pick<ProjectData, 'kind' | 'url' | 'hostname'>[], loopback: boolean): string | null {
  if (!CSP_HOST.test(page.hostname)) return null;
  const served = aliases.has(page.hostname)
    || projects.some(project => project.kind === 'project' && projectPageOrigins(project, { loopback }).includes(page.origin));
  return served ? page.origin : null;
}
