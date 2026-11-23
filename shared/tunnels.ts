/** A Cloudflare quick tunnel (https://try.cloudflare.com) exposing a running project or agent preview. */
export interface TunnelState {
  /** `starting` until cloudflared has a public URL and a registered edge connection. */
  status: 'starting' | 'running';
  /** Public `https://*.trycloudflare.com` address; null while starting. */
  url: string | null;
  startedAt: string;
  /**
   * Emails and `*@domain` rules allowed through Cloudflare Access (one-time PIN).
   * Empty means anyone with the link can open it. Fixed for the tunnel's lifetime.
   */
  allowedEmails: string[];
}

/**
 * How a project decides who may open its tunnels (and those of agent previews in its folder):
 * `inherit` takes the nearest folder layer above (or beside) it that sets one, then the
 * Settings default; `custom` uses the project's own list; `public` explicitly allows anyone
 * and stops inheritance for this folder and everything below it.
 */
export type TunnelAccessMode = 'inherit' | 'custom' | 'public';
export const TUNNEL_ACCESS_MODES: readonly TunnelAccessMode[] = ['inherit', 'custom', 'public'];

/** An entry that decided an effective access list. */
export interface TunnelAccessRef { id: string; name: string }

/** Effective (resolved) tunnel access, computed by the server. */
export interface TunnelAccess {
  /** Effective rules; empty means anyone with the link. */
  allowedEmails: string[];
  /**
   * `own`: the project's own custom list or explicit public. `project`: a folder layer
   * (`from` names its deciding entries; several when same-folder lists were combined, or the
   * entry that set public). `default`: the Settings default. `none`: nothing set anywhere.
   */
  source: 'own' | 'project' | 'default' | 'none';
  from: TunnelAccessRef[];
}

/** True when an open tunnel was started with different rules than the current effective access. */
export function tunnelAccessStale(tunnel: Pick<TunnelState, 'allowedEmails'> | null | undefined, access: TunnelAccess | null | undefined): boolean {
  if (!tunnel || !access) return false;
  const now = new Set(access.allowedEmails), was = new Set(tunnel.allowedEmails ?? []);
  return now.size !== was.size || [...now].some(rule => !was.has(rule));
}

/** Where effective access comes from, for lines such as "from Dernek Web". */
export function describeTunnelSource(access: TunnelAccess): string {
  if (access.source === 'own') return 'set on this project';
  if (access.source === 'default') return 'from Settings';
  if (access.source === 'none') return 'no list set';
  const names = access.from.map(entry => entry.name);
  if (names.length <= 1) return names.length ? `from ${names[0]}` : 'from a parent folder';
  return names.length === 2 ? `from ${names[0]} and ${names[1]}` : `from ${names[0]} and ${names.length - 1} more`;
}

/** Most access rules one tunnel accepts; Settings stores at most this many. */
export const MAX_TUNNEL_ALLOWED_EMAILS = 50;

/**
 * Normalizes one `--allowed-mail` rule: an email address or `*@domain`, lowercased.
 * Returns null for anything cloudflared would reject (`@domain`, `domain`, `*.domain`).
 */
export function tunnelAccessRule(value: string): string | null {
  const rule = value.trim().toLowerCase();
  if (rule.length > 254) return null;
  const at = rule.lastIndexOf('@');
  if (at < 1 || rule.indexOf('@') !== at) return null;
  const local = rule.slice(0, at), domain = rule.slice(at + 1);
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(labels.at(-1)!)) return null;
  if (local === '*') return rule;
  return local.length <= 64 && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ? rule : null;
}

/** Splits text on commas, semicolons, and whitespace into rules, reporting the entries that are not valid. */
export function parseTunnelAccess(text: string): { rules: string[]; invalid: string[] } {
  const rules: string[] = [], invalid: string[] = [];
  for (const entry of text.split(/[\s,;]+/).filter(Boolean)) {
    const rule = tunnelAccessRule(entry);
    if (!rule) invalid.push(entry);
    else if (!rules.includes(rule)) rules.push(rule);
  }
  return { rules, invalid };
}

/** Short description of who may open a tunnel, for titles and notices. */
export function describeTunnelAccess(allowedEmails: readonly string[] | undefined): string {
  if (!allowedEmails?.length) return 'anyone with the link';
  return allowedEmails.length === 1 ? allowedEmails[0]! : `${allowedEmails[0]} and ${allowedEmails.length - 1} more`;
}

/** Local port a project tunnel connects to: the configured port, else an explicit port in its address. */
export function tunnelPort(project: { port: number | null; url: string }): number | null {
  if (project.port !== null) return project.port;
  try {
    const url = new URL(project.url);
    return ['http:', 'https:'].includes(url.protocol) && url.port ? Number(url.port) : null;
  } catch { return null; }
}
