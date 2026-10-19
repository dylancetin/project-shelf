import { readdir, readFile, readlink } from 'node:fs/promises';
import type { AgentServerRecord, AgentServer } from '../shared/agent-servers';

export interface UnitState {
  status: AgentServer['status'];
  pid: number | null;
  diagnostic: string;
  controlGroup: string;
}
export interface AgentSupervisor {
  start(record: AgentServerRecord): Promise<void>;
  state(record: AgentServerRecord): Promise<UnitState>;
  stop(record: AgentServerRecord): Promise<void>;
  logs(record: AgentServerRecord): Promise<string>;
  ready(record: AgentServerRecord, state: UnitState): Promise<boolean>;
}

async function run(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code && !allowFailure) throw new Error(`${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
    return stdout;
  } finally { clearTimeout(timeout); }
}

// An allowlist, not a secret-name denylist. env -i also clears the user manager's
// environment (which systemd-run otherwise inherits independently of the panel).
export function agentEnvironment(port: number): string[] {
  return ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']
    .flatMap(key => process.env[key] ? [`${key}=${process.env[key]}`] : [])
    .concat(`PORT=${port}`);
}

export class SystemdAgentSupervisor implements AgentSupervisor {
  private description(record: AgentServerRecord) { return `Project Shelf agent ${record.id} on ${record.machineId}`; }

  async start(record: AgentServerRecord) {
    await run(['systemd-run', '--user', '--quiet', `--unit=${record.unit}`,
      `--description=${this.description(record)}`, '--service-type=exec',
      '--property=KillMode=control-group', '--property=TimeoutStopSec=8s',
      '--property=SendSIGKILL=yes', '--property=Restart=no', '--property=RemainAfterExit=yes',
      '--property=StandardOutput=journal', '--property=StandardError=journal',
      '--property=LogRateLimitIntervalSec=30s', '--property=LogRateLimitBurst=200',
      `--working-directory=${record.cwd}`, '/usr/bin/env', '-i', ...agentEnvironment(record.port),
      '/usr/bin/systemd-cat', `--identifier=${record.unit}`, '--priority=info', '--stderr-priority=err', '--level-prefix=no',
      '/bin/sh', '-c', record.command.replaceAll('{port}', String(record.port))]);
  }

  async state(record: AgentServerRecord): Promise<UnitState> {
    const output = await run(['systemctl', '--user', 'show', record.unit,
      '--property=LoadState,ActiveState,SubState,MainPID,Description,ControlGroup,Result'], true);
    const values = Object.fromEntries(output.trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!values.LoadState) throw new Error('User systemd manager is unavailable');
    if (values.LoadState === 'not-found') return { status: 'stopped', pid: null, diagnostic: 'Unit is no longer loaded (for example after reboot).', controlGroup: '' };
    if (values.Description !== this.description(record)) throw new Error('Unit ownership mismatch; refusing to access this unit');
    const status: UnitState['status'] = values.ActiveState === 'activating' ? 'starting'
      : values.ActiveState === 'deactivating' ? 'stopping'
      : values.ActiveState === 'failed' ? 'failed'
      : values.ActiveState === 'active' && Number(values.MainPID) > 0 ? 'running' : 'stopped';
    return { status, pid: Number(values.MainPID) || null, diagnostic: `${values.SubState}; ${values.Result}`, controlGroup: values.ControlGroup || '' };
  }

  async stop(record: AgentServerRecord) {
    const state = await this.state(record); // Verify ownership before addressing systemd.
    if (state.diagnostic.startsWith('Unit is no longer loaded')) return;
    await run(['systemctl', '--user', 'stop', record.unit]);
    const after = await this.state(record);
    if (after.pid || ['running', 'starting', 'stopping'].includes(after.status)) throw new Error('Unit has not stopped; registration retained');
    // stop waits for the whole control group, including descendants. A remaining
    // cgroup with any processes must not be hidden by deleting the registration.
    if (after.controlGroup && (await groupPids(after.controlGroup)).length) throw new Error('Unit still contains processes; registration retained');
    await run(['systemctl', '--user', 'reset-failed', record.unit], true);
  }

  async logs(record: AgentServerRecord) {
    await this.state(record);
    // Journal storage is bounded by journald's global quotas, not an unbounded
    // per-preview file. Output retains journal timestamps and stream priority.
    // Some distributions store user-unit messages only in the system journal;
    // `journalctl --user` then returns nothing. Match explicit trusted fields.
    const output = await run(['journalctl', `_SYSTEMD_USER_UNIT=${record.unit}`, `_UID=${process.getuid!()}`, '--no-pager', '--output=json', '--lines=150']);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const entry = JSON.parse(line);
      const message = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString('utf8') : String(entry.MESSAGE ?? '');
      const time = new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString();
      // systemd-cat assigns distinct stream priorities with level-prefix parsing
      // disabled, so command output cannot accidentally change this mapping.
      return `${time} [${Number(entry.PRIORITY) <= 3 ? 'stderr' : 'stdout'}] ${message}`;
    }).join('\n').slice(-65536);
  }

  async ready(record: AgentServerRecord, state: UnitState) {
    if (state.status !== 'running' || !state.controlGroup) return false;
    // HTTP alone could be another program that stole the reserved port. Require
    // the LISTEN socket to belong to this unit's cgroup, before AND after HTTP.
    if (!await ownsListener(record.port, state.controlGroup)) return false;
    try {
      await fetch(`http://127.0.0.1:${record.port}/`, { signal: AbortSignal.timeout(700), redirect: 'manual' });
      return await ownsListener(record.port, state.controlGroup);
    } catch { return false; }
  }
}

async function groupPids(group: string): Promise<string[]> {
  if (!group.startsWith('/') || group.split('/').includes('..')) throw new Error('Invalid cgroup');
  async function visit(directory: string): Promise<string[]> {
    try {
      const own = (await readFile(`${directory}/cgroup.procs`, 'utf8')).trim().split('\n').filter(Boolean);
      const children = await readdir(directory, { withFileTypes: true });
      return own.concat((await Promise.all(children.filter(item => item.isDirectory()).map(item => visit(`${directory}/${item.name}`)))).flat());
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  return visit(`/sys/fs/cgroup${group}`);
}

async function ownsListener(port: number, group: string): Promise<boolean> {
  const inodes = new Set<string>();
  // The HTTP probe uses IPv4. An owned IPv6-only wildcard socket can coexist
  // with a foreign IPv4 listener on the same port; it is not ownership proof.
  for (const table of ['tcp']) {
    const data = await readFile(`/proc/net/${table}`, 'utf8');
    for (const line of data.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // A loopback-only server cannot back the LAN URL we hand to the user.
      // Require an all-interface socket as documented by the preview workflow.
      const [address, hexPort] = fields[1]!.split(':');
      if (fields[3] === '0A' && /^0+$/.test(address!) && parseInt(hexPort!, 16) === port) inodes.add(`socket:[${fields[9]}]`);
    }
  }
  for (const pid of await groupPids(group)) {
    try {
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { if (inodes.has(await readlink(`/proc/${pid}/fd/${fd}`))) return true; } catch { /* exited fd */ }
      }
    } catch { /* exited process */ }
  }
  return false;
}
