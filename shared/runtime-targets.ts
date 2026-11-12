import type { AgentServer } from './agent-servers';
import { isLoopbackHostname, networkAliases, serverAliases } from './hostnames';
import type { Project } from './types';

export type RuntimeTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'agent'; server: AgentServer };

export interface RuntimeTargetsResponse { targets: RuntimeTarget[] }

export interface RuntimeTargetInput {
  projects: Project[];
  agentServers: AgentServer[];
  /** The Network hostnames from Settings; the built-in aliases are always added, and loopback ones per `panel.loopback`. */
  hostnames: string[];
  /**
   * The panel itself. A page on it never resolves, even when a project is registered on the panel's own port.
   * `loopback` is whether the panel was reached on a loopback name, which means the browser runs on the
   * server's machine and `localhost` there is the server. From any other browser it is a different machine,
   * so a loopback page is not one of this server's.
   */
  panel: { port: number | null; origins: readonly string[]; loopback: boolean };
}

const ACTIVE = new Set(['running', 'starting']);
const isHttp = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:';
/** The port a browser connects to, including the scheme's default. */
export const effectivePort = (url: URL): number => url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return isHttp(url) ? url.origin : null;
  } catch { return null; }
}

/**
 * Origins, other than the server aliases, where a project's own pages are served: its stored address
 * (a reverse-proxy URL has no port to match) and that address on its hostname override, which is
 * what the panel's Open link navigates to. A loopback origin is only listed when `loopback` says
 * the browser shares the server's machine.
 */
export function projectPageOrigins(project: Pick<Project, 'url' | 'hostname'>, { loopback }: { loopback: boolean }): string[] {
  const stored = originOf(project.url);
  if (!stored) return [];
  const origins = [stored];
  if (project.hostname) {
    const url = new URL(project.url);
    url.hostname = project.hostname;
    origins.push(url.origin);
  }
  return loopback ? origins : origins.filter(origin => !isLoopbackHostname(new URL(origin).hostname));
}

/**
 * The scheme a project's server answers with on its port. A stored address on this machine (not a
 * reverse proxy's, whose scheme belongs to the proxy) says so; with only a port it is plain http.
 */
function directProtocol(project: Pick<Project, 'url'>, hostnames: readonly string[]): string {
  try {
    const stored = new URL(project.url);
    return stored.protocol === 'https:' && serverAliases(hostnames).has(stored.hostname) ? 'https:' : 'http:';
  } catch { return 'http:'; }
}

const protocolOf = (value: string): string | null => {
  try { return new URL(value).protocol; } catch { return null; }
};

/** Which registered runtimes serve this browser URL: active ones first, then in registration order. */
export function resolveRuntimeTargets(url: URL, input: RuntimeTargetInput): RuntimeTarget[] {
  if (!isHttp(url)) return [];
  const port = effectivePort(url);
  const { loopback } = input.panel;
  const alias = (loopback ? serverAliases : networkAliases)(input.hostnames).has(url.hostname);
  if (input.panel.origins.includes(url.origin) || (alias && port === input.panel.port)) return [];
  const targets: RuntimeTarget[] = [
    ...input.projects
      .filter(project => project.kind === 'project'
        && ((alias && project.port === port && directProtocol(project, input.hostnames) === url.protocol)
          || projectPageOrigins(project, { loopback }).includes(url.origin)))
      .map((project): RuntimeTarget => ({ kind: 'project', project })),
    ...input.agentServers
      .filter(server => (alias && server.port === port && protocolOf(server.url) === url.protocol) || originOf(server.url) === url.origin)
      .map((server): RuntimeTarget => ({ kind: 'agent', server })),
  ];
  const active = (target: RuntimeTarget) => ACTIVE.has(target.kind === 'project' ? target.project.runtime.status : target.server.status);
  return [...targets.filter(active), ...targets.filter(target => !active(target))];
}
