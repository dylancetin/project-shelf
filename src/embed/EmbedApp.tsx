import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentServer } from '../../shared/agent-servers';
import type { EmbedSurface, EmbedTab } from '../../shared/embed';
import type { RuntimeTarget } from '../../shared/runtime-targets';
import { api, errorMessage } from '../api';
import { Spinner } from '../components';
import { Bubble } from './Bubble';
import { useEmbedHost, useFrameSettled } from './host';
import {
  agentEntries, chooseScreen, describeTarget, lastLogId, layoutFor, projectEntries, targetKey, unseenStderr,
  type ClearMark, type EmbedScreen, type PanelView, type TargetKey,
} from './model';
import { Panel } from './Panel';
import { usePoll } from './poll';
import { RuntimeList } from './RuntimeList';
import { SettingsMenu } from './SettingsMenu';

export interface EmbedParams { surface: EmbedSurface; pageUrl: URL | null }

// Quick while someone is looking at the panel, slow while it is only a bubble waiting to be needed.
const WATCHING_MS = 2000;
const IDLE_MS = 6000;
const PROJECT_LOGS_MS = 1600;
const AGENT_LOGS_MS = 2500;
const CLOSE_GRACE_MS = 1500;

interface Catalog { targets: RuntimeTarget[]; agentsError: string | null }

async function loadCatalog(signal: AbortSignal): Promise<Catalog> {
  const [projects, agents] = await Promise.all([
    api.projects(signal),
    // Agent previews come from systemd; their failure must not hide the projects.
    api.agentServers(signal).then(
      (result): { servers: AgentServer[]; error: string | null } => ({ servers: result.servers, error: null }),
      (error: unknown) => { if (signal.aborted) throw error; return { servers: [], error: errorMessage(error) }; },
    ),
  ]);
  return {
    targets: [
      ...projects.projects.filter(project => project.kind === 'project').map((project): RuntimeTarget => ({ kind: 'project', project })),
      ...agents.servers.map((server): RuntimeTarget => ({ kind: 'agent', server })),
    ],
    agentsError: agents.error,
  };
}

const replaceTarget = (next: RuntimeTarget) => (list: RuntimeTarget[]) => list.map(item => targetKey(item) === targetKey(next) ? next : item);
const withoutTarget = (key: TargetKey) => (list: RuntimeTarget[]) => list.filter(item => targetKey(item) !== key);

export function EmbedApp({ surface, pageUrl }: EmbedParams) {
  const host = useEmbedHost();
  const { settings } = host;
  const origin = pageUrl?.origin ?? null;
  const hiddenHere = origin !== null && settings.hiddenOrigins.includes(origin);
  // Hiding is for the bubble on a page; the popup is how the user gets it back, so it is never suppressed.
  const suppressed = surface === 'bubble' && hiddenHere;

  const [view, setView] = useState<PanelView>({ kind: 'bubble' });
  const [tabChoice, setTabChoice] = useState<EmbedTab | null>(null);
  const [selectedKey, setSelectedKey] = useState<TargetKey | null>(null);
  const [pickedKey, setPickedKey] = useState<TargetKey | null>(null);
  const [marks, setMarks] = useState<Record<TargetKey, ClearMark | null>>({});
  const bubbleButton = useRef<HTMLButtonElement>(null);
  const panelCard = useRef<HTMLDivElement>(null);
  const restoreBubbleFocus = useRef(false);

  const watching = surface === 'popup' || view.kind === 'panel';
  const tab = tabChoice ?? settings.defaultTab;

  // The page's runtimes. A popup with no web page has nothing to resolve, which is an answer, not a wait.
  const page = usePoll(`page:${origin}`, signal => api.runtimeTargets(origin ?? '', signal).then(result => result.targets),
    watching ? WATCHING_MS : IDLE_MS, origin !== null && !suppressed);
  const pageTargets = origin === null && surface === 'popup' ? [] : page.data;

  const needsCatalog = surface === 'popup' && pageTargets !== null && pageTargets.length === 0;
  const catalog = usePoll('catalog', loadCatalog, WATCHING_MS, needsCatalog);

  const screen = chooseScreen({ surface, hiddenHere, pageTargets, catalog: catalog.data?.targets ?? null, selectedKey, pickedKey });
  const controls = screen.kind === 'controls' ? screen : null;
  const layout = layoutFor(surface, screen, view);
  const settled = useFrameSettled(layout);
  const selected = controls?.selected ?? null;
  const selectedKeyNow = selected ? targetKey(selected) : '';

  useEffect(() => host.setLayout(layout), [host.setLayout, layout]);
  useEffect(() => { if (screen.kind !== 'controls' && view.kind !== 'bubble') setView({ kind: 'bubble' }); }, [screen.kind, view.kind]);

  // Output. Projects report line ids and streams, so only they can count errors for the badge.
  const project = selected?.kind === 'project' ? selected.project : null;
  const agent = selected?.kind === 'agent' ? selected.server : null;
  const logsOpen = watching && tab === 'logs';
  const badgeWanted = settings.showLogBadge;
  const projectLogs = usePoll(`logs:${project?.id ?? ''}`, () => api.logs(project?.id ?? '').then(result => result.logs),
    logsOpen ? PROJECT_LOGS_MS : watching ? WATCHING_MS : IDLE_MS, project !== null && (logsOpen || badgeWanted));
  const agentLogs = usePoll(`agent-logs:${agent?.id ?? ''}`, signal => api.agentLogs(agent?.id ?? '', signal).then(result => result.logs),
    AGENT_LOGS_MS, agent !== null && logsOpen);
  const logFeed = project ? projectLogs : agentLogs;
  const entries = useMemo(
    () => project ? (projectLogs.data ? projectEntries(projectLogs.data) : null) : (agentLogs.data !== null ? agentEntries(agentLogs.data) : null),
    [project, projectLogs.data, agentLogs.data],
  );

  // Lines are "new" relative to the last time the panel was open. The first answer sets the baseline: errors a
  // server printed before this page loaded are not news, and counting them would badge every page view.
  const seen = useRef(new Map<TargetKey, number>());
  const closedAt = useRef<number | null>(null);
  const lines = projectLogs.data;
  useEffect(() => { closedAt.current = watching ? null : Date.now(); }, [watching]);
  useEffect(() => {
    if (!project || !lines) return;
    // Output that lands in the fetch made as the panel closes was effectively on screen, so it is not news either.
    const justClosed = closedAt.current !== null && Date.now() - closedAt.current < CLOSE_GRACE_MS;
    if (watching || justClosed || !seen.current.has(selectedKeyNow)) seen.current.set(selectedKeyNow, lastLogId(lines));
  }, [project, lines, watching, selectedKeyNow]);
  const unseenErrors = project && lines && !watching && badgeWanted ? unseenStderr(lines, seen.current.get(selectedKeyNow) ?? lastLogId(lines)) : 0;

  const hostnames = usePoll('hostnames', signal => api.settings(signal).then(result => result.settings.hostnames), null, controls !== null && watching);

  function openPanel() { setTabChoice(null); setView({ kind: 'panel' }); }
  function closePanel() { restoreBubbleFocus.current = true; setView({ kind: 'bubble' }); }

  const changed = useCallback((next: RuntimeTarget) => {
    page.patch(replaceTarget(next));
    catalog.patch(current => ({ ...current, targets: replaceTarget(next)(current.targets) }));
    page.refresh(); catalog.refresh();
  }, [page.patch, page.refresh, catalog.patch, catalog.refresh]);
  const removed = useCallback((key: TargetKey) => {
    page.patch(withoutTarget(key));
    catalog.patch(current => ({ ...current, targets: withoutTarget(key)(current.targets) }));
    setPickedKey(current => current === key ? null : current);
    page.refresh(); catalog.refresh();
  }, [page.patch, page.refresh, catalog.patch, catalog.refresh]);

  // Focus follows the layout: into the panel when it opens, back to the bubble when it closes. The frame is
  // invisible until the host has resized it, and an invisible element cannot take focus.
  useEffect(() => {
    if (!settled) return;
    if (layout === 'bubble' && restoreBubbleFocus.current) { restoreBubbleFocus.current = false; bubbleButton.current?.focus(); }
    if (layout === 'panel' && surface === 'bubble') panelCard.current?.focus();
  }, [layout, settled, surface]);

  const offline = controls ? (controls.origin === 'page' ? page.error !== null : catalog.error !== null) : false;

  let content: React.ReactNode = null;
  if (screen.kind === 'loading') {
    content = surface === 'popup' ? <p className="embed-loading" role="status"><Spinner size={16} />Looking for your servers…</p> : null;
  } else if (screen.kind === 'list') {
    content = <div className="embed-card">
      <header className="embed-header">
        <div className="embed-title"><h2>Running now</h2><div className="embed-meta"><span>{screen.runtimes.length} active</span></div></div>
        <SettingsMenu host={host} surface={surface} pageUrl={pageUrl} />
      </header>
      {catalog.error !== null && <p className="embed-offline" role="status">Can’t reach Project Shelf: {catalog.error}</p>}
      <div className="embed-scroll">
        <RuntimeList runtimes={screen.runtimes} pageHost={pageUrl?.host ?? null} agentsError={catalog.data?.agentsError ?? null} onPick={setPickedKey} />
      </div>
    </div>;
  } else if (controls && surface === 'bubble' && view.kind === 'bubble') {
    content = <Bubble view={describeTarget(controls.selected)} size={settings.size} unseenErrors={unseenErrors} onOpen={openPanel} buttonRef={bubbleButton} />;
  } else if (controls) {
    const exit = surface === 'bubble' ? { label: 'Close controls', icon: 'close' as const, run: closePanel }
      : controls.origin === 'list' ? { label: 'Back to running projects', icon: 'back' as const, run: () => setPickedKey(null) } : null;
    content = <Panel surface={surface} pageUrl={pageUrl} host={host} targets={controls.targets} selected={controls.selected} tab={tab} offline={offline}
      hostnames={hostnames.data} exit={exit} panelRef={panelCard}
      logs={{ entries, error: logFeed.error, mark: marks[selectedKeyNow] ?? null, onMark: mark => setMarks(current => ({ ...current, [selectedKeyNow]: mark })), onRefresh: logFeed.refresh }}
      onTab={setTabChoice} onSelect={setSelectedKey} onChanged={changed} onRemoved={removed} />;
  }

  if (layout === 'hidden') return null;
  return <div className={`embed-stage embed-surface-${surface}`} data-settled={settled}>{content}</div>;
}
