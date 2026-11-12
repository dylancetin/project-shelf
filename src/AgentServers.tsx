import { useEffect, useState } from 'react';
import { ArrowSquareOut, ChatCircleText, Stop, TerminalWindow } from '@phosphor-icons/react';
import type { AgentServer, AgentServerThread } from '../shared/agent-servers';
import { api, errorMessage } from './api';
import { useServerAvailable } from './connection';
import { IconButton, Spinner } from './components';
import { TunnelControls } from './Tunnel';

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
  const hint = note ? `This thread is ${thread.status}. The preview is removed at the next check (every 10 minutes).` : thread.status === 'active' ? 'Removed automatically within 10 minutes after this thread is settled.' : 'Thread state is unknown, so this preview is kept.';
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
  return <div className="agent-server">
    <div className="agent-server-top">
      <div className="agent-server-label"><strong>{server.name}</strong><small>{server.machine}:{server.port}</small>{server.thread && <AgentThread thread={server.thread} />}</div>
      <span className={`agent-status${server.ready && available ? ' is-ready' : ''}`} title={server.diagnostic}>{available ? `${server.status} / ${server.ready ? 'ready' : 'not ready'}` : 'unavailable'}</span>
    </div>
    <div className="agent-server-actions" role="group" aria-label={`Actions for ${server.name}`}>
      {server.ready && available
        ? <a className="icon-button" href={server.url} aria-label={`Visit ${server.name}`} title={`Visit ${server.url}`}><ArrowSquareOut size={16} aria-hidden="true" /></a>
        : <IconButton label={`Visit ${server.name}`} title={available ? 'Visit is available once the preview is ready' : 'Reconnect to visit this preview'} disabled><ArrowSquareOut size={16} aria-hidden="true" /></IconButton>}
      <IconButton label={`${expanded ? 'Hide' : 'Show'} logs for ${server.name}`} className={expanded ? 'selected' : ''} aria-expanded={expanded} aria-controls={`agent-logs-${server.id}`} onClick={() => setExpanded(value => !value)}><TerminalWindow size={16} aria-hidden="true" /></IconButton>
      <TunnelControls name={server.name} tunnel={server.tunnel} disabledReason={!available ? 'Reconnect to open a Cloudflare tunnel' : !server.ready ? 'Wait until the preview is ready to open a Cloudflare tunnel' : null}
        onOpen={async () => { const { tunnel } = await api.openAgentTunnel(server.id); onChanged({ tunnel }); return tunnel; }}
        onClose={async () => { await api.closeAgentTunnel(server.id); onChanged({ tunnel: null }); }} />
      <IconButton label={busy ? `Stopping ${server.name}` : `Stop ${server.name}`} title={busy ? `Stopping ${server.name}…` : `Stop ${server.name}${server.tunnel ? ' and close its Cloudflare tunnel' : ''}`} className="agent-stop" disabled={!available || busy} aria-busy={busy || undefined} onClick={() => void stop()}>{busy ? <Spinner size={14} /> : <Stop size={14} weight="fill" aria-hidden="true" />}</IconButton>
      {server.tunnel?.url && <a className="agent-tunnel-link" href={server.tunnel.url} target="_blank" rel="noreferrer" title={`Open ${server.tunnel.url} (public)`}>{new URL(server.tunnel.url).host}</a>}
    </div>
    {error && <p className="agent-message" role="alert">{error}</p>}
    {expanded && <div id={`agent-logs-${server.id}`} className="agent-log-details"><p>{server.cwd}</p><code>{server.command}</code><p>PID {server.pid ?? '—'} (diagnostic only) · {server.diagnostic}</p><pre tabIndex={0} aria-label={`Logs for ${server.name}`}>{logs}</pre></div>}
  </div>;
}
