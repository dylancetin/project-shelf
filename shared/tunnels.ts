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
