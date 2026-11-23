import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, ChatCircleText, Copy, Play, Stop, TerminalWindow, Trash, Warning } from '@phosphor-icons/react';
import type { AgentServer, AgentServerThread } from '../shared/agent-servers';
import { api, errorMessage } from './api';
import { useServerAvailable } from './connection';
import { IconButton, Spinner } from './components';
import { tunnelAccessStale } from '../shared/tunnels';
import { staleWords, TunnelAccessLine, TunnelButtons, useTunnelActions, type TunnelActions } from './Tunnel';
import { agentEntries } from './embed/model';

export function useAgentServers() {
  const available = useServerAvailable();
  const [servers, setServers] = useState<AgentServer[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const result = await api.agentServers(controller.signal); if (!controller.signal.aborted) { setServers(result.servers); setError(''); } }
      catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 4000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [available]);
  return { servers, error, available,
    remove: (id: string) => setServers(items => items.filter(item => item.id !== id)),
    update: (id: string, patch: Partial<AgentServer>) => setServers(items => items.map(item => item.id === id ? { ...item, ...patch } : item)) };
}

export function matchesAgentServer(server: AgentServer, query: string) {
  const text = `${server.name} ${server.cwd} ${server.url} ${server.thread?.title ?? ''}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

export function AgentServers({ state, query }: { state: ReturnType<typeof useAgentServers>; query: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const matches = state.servers.filter(server => matchesAgentServer(server, query));
  return <section className="agent-servers" aria-labelledby="agent-servers-heading">
    <h3 id="agent-servers-heading" ref={heading} tabIndex={-1}>Agent previews <span>{matches.length}</span></h3>
    {(!state.available || state.error) && <p className="agent-message" role="status">{state.available ? state.error : 'Reconnect to view live previews.'}</p>}
    {matches.length > 0 && <div className="agent-server-list">
      {matches.map(server => <AgentServerRow key={server.id} server={server} available={state.available && !state.error}
        onRemoved={() => { state.remove(server.id); heading.current?.focus(); }} onChanged={patch => state.update(server.id, patch)} />)}
    </div>}
    {!matches.length && !state.error && state.available && <p className="agent-message">{query ? 'No matching agent previews.' : 'Previews started by agents appear here. They stay until you remove them or settle their T3 thread.'}</p>}
  </section>;
}

const REMOVING = new Set<AgentServerThread['status']>(['settled', 'archived', 'deleted']);
/** A process may be up (or its state unknown), so Stop and Restart apply. */
const ACTIVE = new Set<AgentServer['status']>(['starting', 'running', 'stopping', 'unknown']);
const LOG_LINES = 150;

/** Status words and tone, reusing the dashboard's status classes. */
function agentStatus(server: AgentServer, available: boolean): { label: string; tone: string } {
  if (!available) return { label: 'Unavailable', tone: '' };
  switch (server.status) {
    case 'starting': return { label: 'Starting', tone: 'status-starting' };
    case 'running': return server.ready ? { label: 'Running', tone: 'status-running' } : { label: 'Not ready', tone: 'status-starting' };
    case 'stopping': return { label: 'Stopping', tone: 'status-stopping' };
    case 'stopped': return { label: 'Stopped', tone: '' };
    case 'failed': return { label: 'Failed', tone: 'status-failed' };
    default: return { label: 'Unknown', tone: '' };
  }
}

// The owning T3 Code thread; its settled state removes the preview.
function AgentThread({ thread }: { thread: AgentServerThread }) {
  const title = thread.title ?? (thread.status === 'unavailable' ? 'T3 thread unavailable' : 'T3 thread not found');
  const note = REMOVING.has(thread.status) ? `${thread.status}, removing soon` : '';
  const hint = note ? `This thread is ${thread.status}. The preview is removed at the next check (every 10 minutes).` : thread.status === 'active' ? 'Removed automatically within 10 minutes after this thread is settled.' : thread.status === 'snoozed' ? 'This thread is snoozed, so this preview is kept until it wakes.' : 'Thread state is unknown, so this preview is kept.';
  const content = <><ChatCircleText size={13} aria-hidden="true" /><span>{title}</span>{note && <em>{note}</em>}</>;
  return thread.link
    ? <a className="agent-thread" href={thread.link} title={`Open in T3 Code. ${hint}`} aria-label={`Open T3 thread ${title}${note ? `, ${note}` : ''}`}>{content}</a>
    : <span className="agent-thread" title={hint}>{content}</span>;
}

type Busy = 'stop' | 'restart' | 'remove' | null;

function AgentServerRow({ server, available, onRemoved, onChanged }: { server: AgentServer; available: boolean; onRemoved: () => void; onChanged: (patch: Partial<AgentServer>) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Which control takes focus once the row re-renders after an action swaps its buttons.
  const [focusNext, setFocusNext] = useState<'primary' | 'stop' | 'trash' | 'keep' | null>(null);
  const primary = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const trash = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const active = ACTIVE.has(server.status);
  const canStart = server.status === 'stopped' || server.status === 'failed';

  useEffect(() => {
    if (!focusNext || busy !== null) return;
    const target = { primary, stop: stopButton, trash, keep }[focusNext].current;
    // A disabled primary (Open while starting) cannot take focus; Stop sits right after it.
    (target && !target.hasAttribute('disabled') ? target : stopButton.current)?.focus();
    setFocusNext(null);
  }, [focusNext, busy, server.status]);

  async function act(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    setBusy(kind); setError('');
    try { await work(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  const stop = () => act('stop', async () => { onChanged((await api.stopAgentServer(server.id)).server); setFocusNext('primary'); });
  const restart = (from: 'primary' | 'restart') => act('restart', async () => { onChanged((await api.restartAgentServer(server.id)).server); if (from === 'primary') setFocusNext('stop'); });
  const remove = () => act('remove', async () => { await api.removeAgentServer(server.id); onRemoved(); });
  function cancelRemove() { setConfirming(false); setFocusNext('trash'); }

  const access = server.tunnelAccess ?? null;
  const tunnel = useTunnelActions({ name: server.name, tunnel: server.tunnel, access,
    onOpen: async () => { const { tunnel } = await api.openAgentTunnel(server.id); onChanged({ tunnel }); return tunnel; },
    onClose: async () => { await api.closeAgentTunnel(server.id); onChanged({ tunnel: null }); } });
  const stale = tunnelAccessStale(server.tunnel, access);
  const tunnelUrl = server.tunnel?.url ?? null;
  const protectedLink = Boolean(server.tunnel?.allowedEmails?.length);
  const status = agentStatus(server, available);
  const locked = !available || busy !== null;

  let primaryControl;
  if (available && server.ready) {
    primaryControl = <a ref={primary} className="button agent-primary" href={server.url} aria-label={`Open ${server.name}`} title={`Open ${server.url}`}>Open<ArrowSquareOut size={13} aria-hidden="true" /></a>;
  } else if (available && canStart) {
    primaryControl = <button ref={primary} type="button" className="button agent-primary" aria-label={busy === 'restart' ? `Starting ${server.name}` : `Start ${server.name}`} title="Run the same command on the same port"
      disabled={locked} aria-busy={busy === 'restart' || undefined} onClick={() => void restart('primary')}>
      {busy === 'restart' ? <Spinner size={12} /> : <Play size={12} weight="fill" aria-hidden="true" />}Start
    </button>;
  } else {
    primaryControl = <button ref={primary} type="button" className="button agent-primary" aria-label={`Open ${server.name}`} disabled
      title={available ? 'Open is available once the preview is ready' : 'Reconnect to open this preview'}>Open<ArrowSquareOut size={13} aria-hidden="true" /></button>;
  }

  return <div className={`agent-server${server.status === 'stopped' ? ' is-stopped' : ''}${expanded ? ' is-expanded' : ''}`}>
    <strong className="agent-server-name" title={server.name}>{server.name}</strong>
    <div className="agent-server-meta">
      <span className={`status ${status.tone}`} title={server.diagnostic}><span className="status-dot" />{status.label}</span>
      <span className="agent-server-address">{server.machine}:{server.port}</span>
    </div>
    {server.thread && <AgentThread thread={server.thread} />}
    {tunnelUrl && <div className="agent-tunnel-row">
      <a className="agent-tunnel-link" href={tunnelUrl} target="_blank" rel="noreferrer" title={`Open ${tunnelUrl} (${protectedLink ? 'one-time PIN' : 'public'})`}>{new URL(tunnelUrl).host}</a>
      <IconButton label={`Copy tunnel link for ${server.name}`} title={`Copy ${tunnelUrl}`} onClick={() => void tunnel.copy(tunnelUrl)}><Copy size={14} aria-hidden="true" /></IconButton>
    </div>}
    {access && (stale || tunnel.pending === 'reopening'
      ? <AgentTunnelStale server={server} actions={tunnel} available={available} />
      : <TunnelAccessLine access={access} tunnel={server.tunnel} ownerId={server.owner?.id} compact />)}
    <div className="agent-server-actions" role="group" aria-label={`Actions for ${server.name}`}>
      {primaryControl}
      {active && <>
        <IconButton ref={stopButton} className="agent-stop" label={busy === 'stop' ? `Stopping ${server.name}` : `Stop ${server.name}`}
          title={server.status === 'stopping' ? `${server.name} is stopping…` : `Stop ${server.name}. It stays listed${server.tunnel ? ' and its Cloudflare tunnel stays open' : ''}.`}
          disabled={locked || server.status === 'stopping'} aria-busy={busy === 'stop' || undefined} onClick={() => void stop()}>
          {busy === 'stop' ? <Spinner size={14} /> : <Stop size={16} aria-hidden="true" />}
        </IconButton>
        <IconButton label={busy === 'restart' ? `Restarting ${server.name}` : `Restart ${server.name}`} title="Stop, then run the same command on the same port"
          disabled={locked || server.status === 'stopping'} aria-busy={busy === 'restart' || undefined} onClick={() => void restart('restart')}>
          {busy === 'restart' ? <Spinner size={14} /> : <ArrowClockwise size={16} aria-hidden="true" />}
        </IconButton>
      </>}
      <IconButton label={`Details and logs for ${server.name}`} title={`${expanded ? 'Hide' : 'Show'} details and logs`} className={expanded ? 'selected' : ''} aria-expanded={expanded} aria-controls={`agent-logs-${server.id}`} onClick={() => setExpanded(value => !value)}><TerminalWindow size={16} aria-hidden="true" /></IconButton>
      <TunnelButtons name={server.name} tunnel={server.tunnel} access={access} actions={tunnel} copy={false}
        disabledReason={!available ? 'Reconnect to open a Cloudflare tunnel' : canStart ? 'Start the preview to open a Cloudflare tunnel' : !server.ready ? 'Wait until the preview is ready to open a Cloudflare tunnel' : null} />
      <IconButton ref={trash} className="agent-remove" label={busy === 'remove' ? `Removing ${server.name}` : `Remove ${server.name}`}
        title={`Remove ${server.name} from the shelf${server.tunnel ? ' and close its Cloudflare tunnel' : ''}`}
        disabled={locked || confirming} aria-expanded={confirming} aria-controls={confirming ? `agent-confirm-${server.id}` : undefined} onClick={() => { setConfirming(true); setFocusNext('keep'); }}>
        {busy === 'remove' ? <Spinner size={14} /> : <Trash size={16} aria-hidden="true" />}
      </IconButton>
    </div>
    {confirming && <div id={`agent-confirm-${server.id}`} className="agent-confirm" role="group" aria-label={`Remove ${server.name}`}
      onKeyDown={event => { if (event.key === 'Escape' && busy !== 'remove') { event.stopPropagation(); cancelRemove(); } }}>
      <p><strong>Remove {server.name}?</strong> This stops the preview{server.tunnel ? ', closes its Cloudflare tunnel,' : ''} and deletes it from the shelf. Agents have to start a new preview to get it back.</p>
      <div>
        <button type="button" className="button button-danger" disabled={locked} aria-busy={busy === 'remove' || undefined} onClick={() => void remove()}>
          {busy === 'remove' ? <Spinner size={14} /> : <Trash size={14} aria-hidden="true" />}Remove
        </button>
        <button ref={keep} type="button" className="button" disabled={busy === 'remove'} onClick={cancelRemove}>Keep it</button>
      </div>
    </div>}
    {tunnel.toast}
    {error && <p className="agent-message" role="alert">{error}</p>}
    {expanded && <AgentDetails server={server} available={available} />}
  </div>;
}

function AgentDetails({ server, available }: { server: AgentServer; available: boolean }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [logError, setLogError] = useState('');
  const [wrap, setWrap] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const result = await api.agentLogs(server.id, controller.signal); if (!controller.signal.aborted) { setLogs(result.logs); setLogError(''); } }
      catch (error) { if (!controller.signal.aborted) setLogError(errorMessage(error)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 4000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [available, server.id]);
  // Follow new output unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = body.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [logs, logError, wrap]);

  const entries = logs ? agentEntries(logs) : [];
  // Not ready yet is a wait, not a failure: say what it waits for and keep the raw diagnostic as a tooltip.
  const waiting = server.status === 'running' && !server.ready && !server.launchError;
  const reason = waiting ? `Waiting for the server to answer on port ${server.port}. It must listen on 0.0.0.0.` : (server.status === 'failed' || server.launchError) ? server.diagnostic : '';
  return <div id={`agent-logs-${server.id}`} className="agent-details">
    {reason && <p className={`agent-reason${waiting ? ' is-waiting' : ''}`} title={server.diagnostic}>{waiting ? <Spinner size={11} /> : <Warning size={12} weight="bold" aria-hidden="true" />}<span>{reason}</span></p>}
    <dl className="agent-facts">
      <div><dt>Folder</dt><dd>{server.cwd}</dd></div>
      <div><dt>Command</dt><dd className="agent-command" tabIndex={0}>{server.command}</dd></div>
      <div><dt>Process</dt><dd title="Diagnostic only; the preview runs as a systemd user unit">{server.pid ? `PID ${server.pid}` : 'Not running'}</dd></div>
    </dl>
    <div className="agent-log-head">
      <span>Logs</span>
      <span className="agent-log-meta">last {LOG_LINES} lines{available ? ' · live' : ''}
        <button type="button" className="text-button" aria-pressed={wrap} title="Wrap long lines" onClick={() => setWrap(value => !value)}>Wrap</button>
      </span>
    </div>
    <div ref={body} className={`agent-log${wrap ? '' : ' is-nowrap'}`} role="log" aria-live="off" tabIndex={0} aria-label={`Logs for ${server.name}`}
      onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
      {logError ? <div className="agent-log-line is-stderr"><span>{logError}</span></div>
        : logs === null ? <div className="agent-log-line"><span>Loading logs…</span></div>
        : !entries.length ? <div className="agent-log-line"><span>No journal output yet.</span></div>
        : entries.map(entry => {
          const iso = entry.time ? entry.raw.slice(0, entry.raw.indexOf(' ')) : '';
          const stderr = entry.stream === 'stderr';
          return <div key={entry.key} className={`agent-log-line${stderr ? ' is-stderr' : ''}`}>
            {entry.time && <time dateTime={iso} title={iso}>{entry.time}</time>}
            {stderr && <span className="agent-log-err">err</span>}
            <span>{entry.text}</span>
          </div>;
        })}
    </div>
  </div>;
}

/** Replaces the access line while Cloudflare still has the tunnel's previous access (the update failed). */
function AgentTunnelStale({ server, actions, available }: { server: AgentServer; actions: TunnelActions; available: boolean }) {
  const reopening = actions.pending === 'reopening';
  const words = server.tunnel ? staleWords(server.tunnel, server.tunnelAccess) : null;
  return <span className="agent-tunnel-stale" role="status">
    <Warning size={12} weight="bold" aria-hidden="true" />
    <span title={server.tunnel?.error}>{reopening || !words ? 'Updating tunnel access…' : <>{words.wasPublic ? 'Open to anyone with the link' : `Open to ${words.was}`} · now {words.nowPublic ? 'anyone with the link' : words.now}</>}</span>
    <button type="button" className="text-button" disabled={!available || actions.pending !== null} aria-busy={reopening || undefined}
      aria-label={`Apply current access to the Cloudflare tunnel for ${server.name}`} title="Updates Cloudflare Access for this tunnel. The link stays the same." onClick={() => void actions.reopen()}>
      {reopening ? <Spinner size={11} /> : null}Apply
    </button>
  </span>;
}
