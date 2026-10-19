import { useEffect, useState } from 'react';
import type { AgentServer } from '../shared/agent-servers';
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

export function AgentServers({ state, query }: { state: ReturnType<typeof useAgentServers>; query: string }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = state.servers.filter(server => words.every(word => `${server.name} ${server.cwd} ${server.url}`.toLowerCase().includes(word)));
  return <section className="agent-servers" aria-label="Agent Servers">
    <h3>Agent Servers <span>{matches.length}</span></h3>
    {(!state.available || state.error) && <p className="agent-message" role="status">{state.available ? state.error : 'Reconnect to view live previews.'}</p>}
    {matches.map(server => <AgentServerRow key={server.id} server={server} available={state.available && !state.error} onRemoved={() => state.remove(server.id)} />)}
    {!matches.length && !state.error && state.available && <p className="agent-message">{query ? 'No matching agent previews.' : 'Previews started by agents appear here. They stay until you stop them.'}</p>}
  </section>;
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
      <div className="agent-server-label"><strong>{server.name}</strong><small>{server.machine}:{server.port}</small></div>
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
