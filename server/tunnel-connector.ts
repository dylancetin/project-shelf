import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './agent-supervisor';

/**
 * Runs `cloudflared tunnel run` for the panel's named tunnel. It must outlive the panel process:
 * restarting Project Shelf never interrupts open tunnels.
 */
export interface TunnelConnector {
  /** Starts the connector with this tunnel token unless it is already running with it. */
  ensure(token: string): Promise<void>;
  /** Stops the connector (when no tunnel is open). Repeated calls are safe. */
  stop(): Promise<void>;
}

/** The connector unit for a named tunnel: `project-shelf-cloudflared.service` for the default name. */
export function connectorUnit(tunnelName = 'project-shelf') {
  return tunnelName === 'project-shelf' ? 'project-shelf-cloudflared.service' : `project-shelf-cloudflared-${tunnelName.replace(/[^\w.-]/g, '_')}.service`;
}

/**
 * A transient systemd user unit with its own control group, so it survives panel restarts
 * (the panel's own unit only stops its cgroup). `Restart=always` brings it back after a crash or
 * network loss; the panel starts it again after a reboot. The token is read from a 0600 file
 * rather than argv, and the environment is an allowlist so no TUNNEL_* variable leaks in.
 */
export class SystemdTunnelConnector implements TunnelConnector {
  private readonly description: string;
  constructor(private tokenFile: string, private unit = connectorUnit(), private binary = 'cloudflared') {
    this.description = `Project Shelf Cloudflare tunnel connector (${unit})`;
  }

  private async state(): Promise<{ active: boolean; loaded: boolean }> {
    const output = await run(['systemctl', '--user', 'show', this.unit, '--property=LoadState,ActiveState,Description'], true);
    const values = Object.fromEntries(output.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    if (!values.LoadState) throw new Error('User systemd manager is unavailable');
    if (values.LoadState === 'not-found') return { active: false, loaded: false };
    if (values.Description !== this.description) throw new Error(`${this.unit} is not owned by Project Shelf; refusing to manage it`);
    return { active: ['active', 'activating', 'reloading'].includes(values.ActiveState!), loaded: true };
  }

  async ensure(token: string) {
    if (!/^[A-Za-z0-9+/=_-]{20,4096}$/.test(token)) throw new Error('Cloudflare returned an unexpected tunnel token');
    let current = '';
    try { current = readFileSync(this.tokenFile, 'utf8'); } catch { /* first start */ }
    const changed = current !== token;
    if (changed) {
      mkdirSync(path.dirname(this.tokenFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.tokenFile, token, { mode: 0o600 });
      chmodSync(this.tokenFile, 0o600);
    }
    const state = await this.state();
    if (state.active && !changed) return;
    if (state.loaded) {
      await run(['systemctl', '--user', 'stop', this.unit], true);
      await run(['systemctl', '--user', 'reset-failed', this.unit], true);
    }
    const env = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'].flatMap(key => process.env[key] ? [`${key}=${process.env[key]}`] : []);
    await run(['systemd-run', '--user', '--quiet', `--unit=${this.unit}`, `--description=${this.description}`, '--service-type=exec',
      '--property=Restart=always', '--property=RestartSec=5s', '--property=KillMode=control-group', '--property=TimeoutStopSec=10s',
      '/usr/bin/env', '-i', ...env, this.binary, '--no-autoupdate', 'tunnel', '--metrics', '127.0.0.1:0', 'run', '--token-file', this.tokenFile]);
  }

  async stop() {
    const state = await this.state();
    if (!state.loaded) return;
    await run(['systemctl', '--user', 'stop', this.unit], true);
    await run(['systemctl', '--user', 'reset-failed', this.unit], true);
  }
}
