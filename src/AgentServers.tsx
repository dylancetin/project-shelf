import { useEffect, useState } from 'react';
import { ChatCircleText } from '@phosphor-icons/react';
import type { AgentServer, AgentServerThread } from '../shared/agent-servers';
import { api, errorMessage } from './api';
import { useServerAvailable } from './connection';

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
  return { servers, error, available, remove: (id: string) => setServers(items => items.filter(item => item.id !== id)) };
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
    {matches.map(server => <AgentServerRow key={server.id} server={server} available={state.available && !state.error} onRemoved={() => state.remove(server.id)} />)}
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

function AgentServerRow({ server, available, onRemoved }: { server: AgentServer; available: boolean; onRemoved: () => void }) {
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
    <div className="agent-server-actions">
      {server.ready && available ? <a className="text-button" href={server.url}>Visit</a> : <span className="agent-unavailable">Visit</span>}
      <button className="text-button" aria-expanded={expanded} aria-controls={`agent-logs-${server.id}`} onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide logs' : 'Logs'}</button>
      <button className="text-button" disabled={!available || busy} onClick={() => void stop()} aria-label={`Stop ${server.name}`}>{busy ? 'Stopping…' : 'Stop'}</button>
    </div>
    {error && <p className="agent-message" role="alert">{error}</p>}
    {expanded && <div id={`agent-logs-${server.id}`} className="agent-log-details"><p>{server.cwd}</p><code>{server.command}</code><p>PID {server.pid ?? '—'} (diagnostic only) · {server.diagnostic}</p><pre tabIndex={0} aria-label={`Logs for ${server.name}`}>{logs}</pre></div>}
  </div>;
}
