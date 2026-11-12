import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { TunnelState } from '../shared/tunnels';
import { ApiError } from './errors';
import { groupAlive, signalGroup } from './process-groups';

export interface TunnelOptions {
  /** cloudflared executable. Tests substitute a disposable fake. */
  binary?: string;
  startTimeoutMs?: number;
  stopGraceMs?: number;
  maxTunnels?: number;
}

interface Tunnel {
  state: TunnelState;
  child: ChildProcess;
  ready: Promise<TunnelState>;
  exited: Promise<void>;
  stopped: boolean;
}

// The API host (api.trycloudflare.com) appears in request errors; it is never a tunnel address.
const PUBLIC_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/;
const REGISTERED = /Registered tunnel connection/;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const projectTunnel = (id: string) => `project:${id}`;
export const agentTunnel = (id: string) => `agent:${id}`;

function tunnelEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Panel configuration and cloudflared's TUNNEL_* flag variables (for example a
  // named tunnel's token) must never turn a quick tunnel into something else.
  for (const key of Object.keys(env)) if (key.startsWith('TUNNEL_')) delete env[key];
  delete env.PORT; delete env.API_PORT; delete env.PANEL_DB_PATH;
  return env;
}

/** Cloudflare quick tunnels (https://try.cloudflare.com), each in its own process group. */
export class TunnelManager {
  private tunnels = new Map<string, Tunnel>();
  private closed = false;
  private readonly startTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly maxTunnels: number;

  constructor(private options: TunnelOptions = {}) {
    this.startTimeoutMs = options.startTimeoutMs ?? 45000;
    this.stopGraceMs = options.stopGraceMs ?? 3000;
    this.maxTunnels = options.maxTunnels ?? 10;
  }

  get(key: string): TunnelState | null {
    const tunnel = this.tunnels.get(key);
    return tunnel ? { ...tunnel.state } : null;
  }

  /**
   * Opens (or reuses) a tunnel to a loopback port. Registration is synchronous;
   * the returned promise settles once the public URL accepts traffic.
   */
  start(key: string, port: number): Promise<TunnelState> {
    if (this.closed) throw new ApiError(503, 'The server is shutting down');
    const existing = this.tunnels.get(key);
    if (existing) return existing.ready;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'A tunnel needs a local port from 1 to 65535');
    if (this.tunnels.size >= this.maxTunnels) throw new ApiError(429, `At most ${this.maxTunnels} Cloudflare tunnels can be open at once`);
    // Vite and similar dev servers only answer known hosts; present the request as
    // local. A random metrics port lets several quick tunnels run side by side.
    const child = spawn(this.options.binary ?? 'cloudflared', ['tunnel', '--no-autoupdate', '--grace-period', '1s', '--metrics', '127.0.0.1:0',
      '--http-host-header', 'localhost', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: tunnelEnvironment() });
    const recent: string[] = [];
    let url: string | null = null;
    let settle!: { resolve: (state: TunnelState) => void; reject: (error: Error) => void };
    const ready = new Promise<TunnelState>((resolve, reject) => { settle = { resolve, reject }; });
    ready.catch(() => {}); // Rejections are reported to the caller that awaits it.
    let markExited!: () => void;
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    const tunnel: Tunnel = { state: { status: 'starting', url: null, startedAt: new Date().toISOString() }, child, ready, exited, stopped: false };
    this.tunnels.set(key, tunnel);

    const lastError = () => {
      const line = [...recent].reverse().find(item => /\b(ERR|FTL)\b|error|failed/i.test(item));
      return line ? line.replace(/^\S+Z\s+(ERR|FTL|WRN|INF)\s+/, '').slice(0, 300) : '';
    };
    const fail = (error: ApiError) => {
      if (tunnel.state.status !== 'starting') return;
      settle.reject(error);
      void this.stop(key, tunnel);
    };
    const timer = setTimeout(() => fail(new ApiError(504, `Cloudflare did not open the tunnel within ${Math.round(this.startTimeoutMs / 1000)} seconds${lastError() ? `: ${lastError()}` : ''}`)), this.startTimeoutMs);
    const line = (text: string) => {
      recent.push(text); if (recent.length > 40) recent.shift();
      url ??= text.match(PUBLIC_URL)?.[0] ?? null;
      // The address is printed before the edge connection exists; it only works after registration.
      if (url && tunnel.state.status === 'starting' && !tunnel.stopped && REGISTERED.test(text)) {
        clearTimeout(timer);
        tunnel.state = { ...tunnel.state, status: 'running', url };
        settle.resolve({ ...tunnel.state });
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      stream?.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!.slice(-4000);
        for (const item of lines) line(item);
      });
    }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (this.tunnels.get(key) === tunnel) this.tunnels.delete(key);
      if (tunnel.state.status === 'starting') {
        settle.reject(tunnel.stopped ? new ApiError(409, 'The tunnel was stopped before it was ready')
          : (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? new ApiError(503, 'cloudflared is not installed on the server')
          : new ApiError(502, `cloudflared exited before the tunnel was ready${lastError() ? `: ${lastError()}` : ''}`));
      } else if (!tunnel.stopped) console.warn(`Cloudflare tunnel ${key} (${tunnel.state.url}) exited unexpectedly${lastError() ? `: ${lastError()}` : ''}`);
      child.stdout?.destroy(); child.stderr?.destroy();
      markExited();
    };
    child.once('error', finish);
    child.once('exit', () => finish());
    return ready;
  }

  /** Stops a tunnel's process group with bounded graceful termination. Repeated calls are safe. */
  async stop(key: string, only?: Tunnel): Promise<void> {
    const tunnel = this.tunnels.get(key);
    if (!tunnel || (only && tunnel !== only)) return;
    // Forget it immediately so status shows off and a new tunnel can be opened.
    this.tunnels.delete(key);
    tunnel.stopped = true;
    const pid = tunnel.child.pid ?? null;
    signalGroup(pid, 'SIGTERM');
    await Promise.race([tunnel.exited, delay(this.stopGraceMs)]);
    if (pid && groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    await tunnel.exited;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.tunnels.keys()].map(key => this.stop(key)));
  }
}
