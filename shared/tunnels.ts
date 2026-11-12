/** A Cloudflare quick tunnel (https://try.cloudflare.com) exposing a running project or agent preview. */
export interface TunnelState {
  /** `starting` until cloudflared has a public URL and a registered edge connection. */
  status: 'starting' | 'running';
  /** Public `https://*.trycloudflare.com` address; null while starting. */
  url: string | null;
  startedAt: string;
}

/** Local port a project tunnel connects to: the configured port, else an explicit port in its address. */
export function tunnelPort(project: { port: number | null; url: string }): number | null {
  if (project.port !== null) return project.port;
  try {
    const url = new URL(project.url);
    return ['http:', 'https:'].includes(url.protocol) && url.port ? Number(url.port) : null;
  } catch { return null; }
}
