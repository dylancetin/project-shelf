import { useState } from 'react';
import { ArrowSquareOut, ArrowClockwise, Hammer, Play, RocketLaunch, Stop, Trash } from '@phosphor-icons/react';
import type { AgentServer } from '../../shared/agent-servers';
import type { RuntimeTarget } from '../../shared/runtime-targets';
import { tunnelPort } from '../../shared/tunnels';
import type { Project, RunMode } from '../../shared/types';
import { api, errorMessage } from '../api';
import { ErrorNotice, Spinner } from '../components';
import { TunnelControls } from '../Tunnel';
import { alternateHostLinks, describeTarget, MODE_LABEL, uptimeLabel, type TargetKey, type TargetView } from './model';
import { useNow } from './poll';
import { hostOf, RuntimeStatus } from './parts';

export interface ControlsProps {
  target: RuntimeTarget;
  /** Other hostnames the panel is reachable by, from Settings; null until loaded. */
  hostnames: readonly string[] | null;
  /** The page being viewed, so its own hostname is left out of the alternatives. */
  pageHost: string | null;
  onChanged: (target: RuntimeTarget) => void;
  onRemoved: (key: TargetKey) => void;
}

export function Controls(props: ControlsProps) {
  return props.target.kind === 'project'
    ? <ProjectControls key={props.target.project.id} {...props} project={props.target.project} />
    : <AgentControls key={props.target.server.id} {...props} server={props.target.server} />;
}

type Action = RunMode | 'stop' | 'restart' | 'remove';
type ActionState = { kind: 'idle' } | { kind: 'busy'; action: Action } | { kind: 'failed'; message: string };
const IDLE: ActionState = { kind: 'idle' };

const ACTION_VERB: Record<Action, string> = { dev: 'start development for', prod: 'start production for', build: 'build', stop: 'stop', restart: 'restart', remove: 'remove' };

function useAction(name: string) {
  const [state, setState] = useState<ActionState>(IDLE);
  async function run(action: Action, work: () => Promise<void>) {
    setState({ kind: 'busy', action });
    try { await work(); setState(IDLE); }
    catch (error) { setState({ kind: 'failed', message: `Could not ${ACTION_VERB[action]} ${name}: ${errorMessage(error)}` }); }
  }
  return { state, run, dismiss: () => setState(IDLE), busyWith: state.kind === 'busy' ? state.action : null };
}

function ActionButton({ action, busyWith, label, name, icon, title, disabled, className = '', onClick }: {
  action: Action; busyWith: Action | null; label: string; name?: string; icon: React.ReactNode; title: string; disabled: boolean; className?: string; onClick: () => void;
}) {
  const busy = busyWith === action;
  return <button type="button" className={`button ${className}`} disabled={disabled || busyWith !== null} aria-busy={busy || undefined} aria-label={name} title={title} onClick={onClick}>
    {busy ? <Spinner size={14} /> : icon}{label}
  </button>;
}

function ProjectControls({ project, hostnames, pageHost, onChanged }: ControlsProps & { project: Project }) {
  const view = describeTarget({ kind: 'project', project });
  const { state, run, dismiss, busyWith } = useAction(project.name);
  const { status, mode } = project.runtime;
  const active = status === 'running' || status === 'starting';
  const transitional = status === 'starting' || status === 'stopping';
  const building = active && mode === 'build';
  const changed = (next: Project) => onChanged({ kind: 'project', project: next });

  const startTitle = (command: string, what: string, missing: string) => status === 'stopping' ? 'Wait for the process to stop' : active ? 'Stop it first, or use Restart' : command ? what : `Add a ${missing} command in Manage`;
  const tunnelBlocked = !tunnelPort(project) ? 'Configure a project port to open a Cloudflare tunnel'
    : building ? 'Wait for the build to finish before opening a tunnel'
    : status === 'stopping' ? `Wait for ${project.name} to stop`
    : !active && !project.devCommand ? 'Add a development command in Manage' : null;

  return <div className="embed-controls">
    {state.kind === 'failed' && <ErrorNotice message={state.message} onDismiss={dismiss} />}
    <div className="embed-actions" role="group" aria-label={`Commands for ${project.name}`}>
      <ActionButton action="dev" busyWith={busyWith} label="Start dev" icon={<Play size={13} weight="fill" aria-hidden="true" />} className="span-2"
        disabled={active || status === 'stopping' || !project.devCommand} title={startTitle(project.devCommand, 'Start the development server', 'development')} onClick={() => void run('dev', async () => changed((await api.start(project.id, 'dev')).project))} />
      <ActionButton action="prod" busyWith={busyWith} label="Production" name={`Start production for ${project.name}`} icon={<RocketLaunch size={14} aria-hidden="true" />} className="span-2"
        disabled={active || status === 'stopping' || !project.prodCommand} title={startTitle(project.prodCommand, 'Build, then start the production server', 'production')} onClick={() => void run('prod', async () => changed((await api.start(project.id, 'prod')).project))} />
      <ActionButton action="build" busyWith={busyWith} label="Build" name={`Build ${project.name}`} icon={<Hammer size={14} aria-hidden="true" />} className="span-2"
        disabled={active || status === 'stopping' || !project.buildCommand} title={startTitle(project.buildCommand, 'Build only, without starting a server', 'build')} onClick={() => void run('build', async () => changed((await api.start(project.id, 'build')).project))} />
      <ActionButton action="restart" busyWith={busyWith} label="Restart" icon={<ArrowClockwise size={14} aria-hidden="true" />} className="span-3"
        disabled={building || !(active || status === 'failed')} title={building ? 'A build is running; stop it or wait for it' : active || status === 'failed' ? `Stop and start again${mode === 'prod' ? ' in production' : ''}` : 'Not running; use Start dev'} onClick={() => void run('restart', async () => changed((await api.restartProject(project.id)).project))} />
      <ActionButton action="stop" busyWith={busyWith} label="Stop" icon={<Stop size={13} weight="fill" aria-hidden="true" />} className="span-3 button-stop"
        disabled={!active} title={active ? `Stop ${project.name} and its child processes` : 'Nothing is running'} onClick={() => void run('stop', async () => changed((await api.stop(project.id)).project))} />
    </div>
    <Facts view={view} />
    <TunnelRow view={view} blocked={tunnelBlocked}
      onOpen={async () => {
        // Same as the dashboard: start or reuse development, wait until it answers, then open the tunnel.
        if (!(status === 'running' && mode === 'prod')) changed((await api.launch(project.id)).project);
        const result = await api.openTunnel(project.id);
        changed(result.project);
        return result.tunnel;
      }}
      onClose={async () => changed((await api.closeTunnel(project.id)).project)} />
    <HostLinks view={view} active={active} hostnames={hostnames} pageHost={pageHost} />
    <a className="button embed-manage-link" href={`/#manage/project/${encodeURIComponent(project.id)}`} target="_blank" rel="noreferrer">
      <ArrowSquareOut size={15} aria-hidden="true" />Open in Manage
    </a>
    {transitional && <span className="sr-only" role="status">{status === 'starting' ? 'Starting' : 'Stopping'} {project.name}</span>}
  </div>;
}

function AgentControls({ server, hostnames, pageHost, onChanged, onRemoved }: ControlsProps & { server: AgentServer }) {
  const view = describeTarget({ kind: 'agent', server });
  const { state, run, dismiss, busyWith } = useAction(server.name);
  const [confirming, setConfirming] = useState(false);
  const active = server.status === 'running' || server.status === 'starting';
  const changed = (next: AgentServer) => onChanged({ kind: 'agent', server: next });
  const tunnelBlocked = !server.ready ? 'Wait until the preview is ready to open a Cloudflare tunnel' : null;

  return <div className="embed-controls">
    {state.kind === 'failed' && <ErrorNotice message={state.message} onDismiss={dismiss} />}
    <div className="embed-actions" role="group" aria-label={`Commands for ${server.name}`}>
      <ActionButton action="restart" busyWith={busyWith} label="Restart" icon={<ArrowClockwise size={14} aria-hidden="true" />} className="span-3"
        disabled={server.status === 'stopping'} title="Stop the preview's process group, then start the same command on the same port" onClick={() => void run('restart', async () => changed((await api.restartAgentServer(server.id)).server))} />
      <ActionButton action="remove" busyWith={busyWith} label="Stop and remove" name={`Stop and remove ${server.name}`} icon={<Trash size={14} aria-hidden="true" />} className="span-3 button-stop"
        disabled={confirming} title="Stopping an agent preview deletes its registration" onClick={() => setConfirming(true)} />
    </div>
    {confirming && <div className="embed-confirm" role="alertdialog" aria-label={`Remove ${server.name}`}>
      <p><strong>Remove {server.name}?</strong> This stops the preview{server.tunnel ? ', closes its Cloudflare tunnel,' : ''} and deletes its registration. Agents have to start a new preview to get it back.</p>
      <div>
        <button type="button" className="button button-danger" disabled={busyWith !== null} aria-busy={busyWith === 'remove' || undefined}
          onClick={() => void run('remove', async () => { await api.stopAgentServer(server.id); onRemoved(view.key); })}>
          {busyWith === 'remove' ? <Spinner size={14} /> : <Trash size={14} aria-hidden="true" />}Stop and remove
        </button>
        <button type="button" className="button" disabled={busyWith !== null} autoFocus onClick={() => setConfirming(false)}>Keep it</button>
      </div>
    </div>}
    <Facts view={view} server={server} />
    <TunnelRow view={view} blocked={tunnelBlocked}
      onOpen={async () => { const { tunnel } = await api.openAgentTunnel(server.id); changed({ ...server, tunnel }); return tunnel; }}
      onClose={async () => { await api.closeAgentTunnel(server.id); changed({ ...server, tunnel: null }); }} />
    <HostLinks view={view} active={active && server.ready} hostnames={hostnames} pageHost={pageHost} />
  </div>;
}

function Facts({ view, server }: { view: TargetView; server?: AgentServer }) {
  const running = view.phase === 'running';
  const now = useNow(running && view.startedAt !== null);
  const uptime = running && view.startedAt ? uptimeLabel(view.startedAt, now) : '';
  const rows: [string, React.ReactNode][] = [];
  if (view.mode && view.phase !== 'stopped') rows.push(['Mode', MODE_LABEL[view.mode]]);
  if (uptime) rows.push(['Uptime', uptime]);
  if (view.port !== null) rows.push(['Port', <span className="mono" key="port">{view.port}</span>]);
  if (view.pid !== null) rows.push(['Process', <span className="mono" key="pid">{view.pid}</span>]);
  if (!running && view.kind === 'project' && view.exitCode !== null) rows.push(['Last exit', <span className="mono" key="exit">code {view.exitCode}</span>]);
  if (server) {
    if (server.thread?.title) rows.push(['Thread', server.thread.title]);
    rows.push(['Folder', <span className="mono embed-clip" key="cwd" title={server.cwd}>{server.cwd}</span>]);
    rows.push(['Command', <span className="mono embed-clip" key="cmd" title={server.command}>{server.command}</span>]);
    if (server.diagnostic && !running) rows.push(['Detail', <span className="embed-clip" key="diag" title={server.diagnostic}>{server.diagnostic}</span>]);
  }
  return <dl className="embed-facts" aria-label={`${view.name} details`}>
    <div><dt>Status</dt><dd><RuntimeStatus view={view} /></dd></div>
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function TunnelRow({ view, blocked, onOpen, onClose }: { view: TargetView; blocked: string | null; onOpen: () => Promise<NonNullable<TargetView['tunnel']>>; onClose: () => Promise<void> }) {
  const url = view.tunnel?.status === 'running' ? view.tunnel.url : null;
  return <div className="embed-row">
    <div className="embed-row-text">
      <strong>Cloudflare tunnel</strong>
      {url ? <a href={url} target="_blank" rel="noreferrer" title={`Open ${url} (public)`}>{hostOf(url)}</a>
        : <span>{view.tunnel ? 'Opening…' : blocked ?? 'Share a public link to this server.'}</span>}
    </div>
    <div className="embed-row-actions"><TunnelControls name={view.name} tunnel={view.tunnel} disabledReason={blocked} onOpen={onOpen} onClose={onClose} /></div>
  </div>;
}

function HostLinks({ view, active, hostnames, pageHost }: { view: TargetView; active: boolean; hostnames: readonly string[] | null; pageHost: string | null }) {
  const links = active && hostnames ? alternateHostLinks(view.address, pageHost ?? '', hostnames) : [];
  if (!links.length) return null;
  return <div className="embed-hosts"><h3>Open on</h3>
    <ul>{links.map(link => <li key={link.host}><a className="button" href={link.href} target="_blank" rel="noreferrer" title={link.href}>{link.host}<ArrowSquareOut size={12} aria-hidden="true" /></a></li>)}</ul>
  </div>;
}
