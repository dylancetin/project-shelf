import { useEffect, useState } from 'react';
import { ArrowSquareOut, ChatCircleText, Stop, TerminalWindow, Warning } from '@phosphor-icons/react';
import type { AgentServer, AgentServerThread } from '../shared/agent-servers';
import { api, errorMessage } from './api';
import { useServerAvailable } from './connection';
import { IconButton, Spinner } from './components';
import { tunnelAccessStale } from '../shared/tunnels';
import { staleWords, TunnelAccessLine, TunnelButtons, useTunnelActions, type TunnelActions } from './Tunnel';

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
  const matches = state.servers.filter(server => matchesAgentServer(server, query));
  return <section className="agent-servers" aria-label="Agent Servers">
    <h3>Agent Servers <span>{matches.length}</span></h3>
    {(!state.available || state.error) && <p className="agent-message" role="status">{state.available ? state.error : 'Reconnect to view live previews.'}</p>}
    {matches.map(server => <AgentServerRow key={server.id} server={server} available={state.available && !state.error} onRemoved={() => state.remove(server.id)} onChanged={patch => state.update(server.id, patch)} />)}
    {!matches.length && !state.error && state.available && <p className="agent-message">{query ? 'No matching agent previews.' : 'Previews started by agents appear here. They stay until you stop them or settle their T3 thread.'}</p>}
  </section>;
}

const REMOVING = new Set<AgentServerThread['status']>(['settled', 'archived', 'deleted']);

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

function AgentServerRow({ server, available, onRemoved, onChanged }: { server: AgentServer; available: boolean; onRemoved: () => void; onChanged: (patch: Partial<AgentServer>) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState('Loading logs…');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded || !available) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const result = await api.agentLogs(server.id, controller.signal); if (!controller.signal.aborted) setLogs(result.logs || 'No journal output yet.'); }
      catch (error) { if (!controller.signal.aborted) setLogs(errorMessage(error)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 4000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [expanded, available, server.id]);
  async function stop() {
    setBusy(true); setError('');
    try { await api.stopAgentServer(server.id); onRemoved(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const access = server.tunnelAccess ?? null;
  const tunnel = useTunnelActions({ name: server.name, tunnel: server.tunnel, access,
    onOpen: async () => { const { tunnel } = await api.openAgentTunnel(server.id); onChanged({ tunnel }); return tunnel; },
    onClose: async () => { await api.closeAgentTunnel(server.id); onChanged({ tunnel: null }); } });
  const stale = tunnelAccessStale(server.tunnel, access);
  const protectedLink = Boolean(server.tunnel?.allowedEmails?.length);
  return <div className="agent-server">
    <div className="agent-server-top">
      <div className="agent-server-label"><strong>{server.name}</strong><small>{server.machine}:{server.port}</small>{server.thread && <AgentThread thread={server.thread} />}{access && (stale || tunnel.pending === 'reopening'
        ? <AgentTunnelStale server={server} actions={tunnel} available={available} />
        : <TunnelAccessLine access={access} tunnel={server.tunnel} ownerId={server.owner?.id} />)}</div>
      <span className={`agent-status${server.ready && available ? ' is-ready' : ''}`} title={server.diagnostic}>{available ? `${server.status} / ${server.ready ? 'ready' : 'not ready'}` : 'unavailable'}</span>
    </div>
    <div className="agent-server-actions" role="group" aria-label={`Actions for ${server.name}`}>
      {server.ready && available
        ? <a className="icon-button" href={server.url} aria-label={`Visit ${server.name}`} title={`Visit ${server.url}`}><ArrowSquareOut size={16} aria-hidden="true" /></a>
        : <IconButton label={`Visit ${server.name}`} title={available ? 'Visit is available once the preview is ready' : 'Reconnect to visit this preview'} disabled><ArrowSquareOut size={16} aria-hidden="true" /></IconButton>}
      <IconButton label={`${expanded ? 'Hide' : 'Show'} logs for ${server.name}`} className={expanded ? 'selected' : ''} aria-expanded={expanded} aria-controls={`agent-logs-${server.id}`} onClick={() => setExpanded(value => !value)}><TerminalWindow size={16} aria-hidden="true" /></IconButton>
      <TunnelButtons name={server.name} tunnel={server.tunnel} access={access} actions={tunnel} disabledReason={!available ? 'Reconnect to open a Cloudflare tunnel' : !server.ready ? 'Wait until the preview is ready to open a Cloudflare tunnel' : null} />
      <IconButton label={busy ? `Stopping ${server.name}` : `Stop ${server.name}`} title={busy ? `Stopping ${server.name}…` : `Stop and remove ${server.name}${server.tunnel ? ', closing its Cloudflare tunnel' : ''}`} className="agent-stop" disabled={!available || busy} aria-busy={busy || undefined} onClick={() => void stop()}>{busy ? <Spinner size={14} /> : <Stop size={14} weight="fill" aria-hidden="true" />}</IconButton>
      {server.tunnel?.url && <a className="agent-tunnel-link" href={server.tunnel.url} target="_blank" rel="noreferrer" title={`Open ${server.tunnel.url} (${protectedLink ? 'one-time PIN' : 'public'})`}>{new URL(server.tunnel.url).host}</a>}
    </div>
    {tunnel.toast}
    {error && <p className="agent-message" role="alert">{error}</p>}
    {expanded && <div id={`agent-logs-${server.id}`} className="agent-log-details"><p>{server.cwd}</p><code>{server.command}</code><p>PID {server.pid ?? '—'} (diagnostic only) · {server.diagnostic}</p><pre tabIndex={0} aria-label={`Logs for ${server.name}`}>{logs}</pre></div>}
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
