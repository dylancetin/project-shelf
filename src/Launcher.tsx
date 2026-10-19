import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ArrowsDownUp, DotsSixVertical, DotsThree, Hammer, MagnifyingGlass, Play, RocketLaunch, Rows, SquaresFour, Stop, X } from '@phosphor-icons/react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project, ProjectKind, RunMode } from '../shared/types';
import type { SearchEngine } from '../shared/search';
import { bookmarkUrl, searchBookmarks } from '../shared/browser-bookmarks';
import { moveWithinSubset } from '../shared/ordering';
import { isActive, projectUrl } from './api';
import { IconButton, ProjectAvatar, ProjectLink, Spinner, type OpenProject } from './components';
import './launcher.css';
import { useServerAvailable } from './connection';
import { BangSearch, useBangSearch } from './BangSearch';
import { BrowserBookmarks } from './BrowserBookmarks';
import { useBookmarks } from './useBookmarks';
import { shelfItemId, type ShelfColumn, type ShelfItemDragData } from './shelf-columns';
import { AgentServers, useAgentServers } from './AgentServers';

type Destination = { project: Project; url: string };
type Layout = 'compact' | 'grid';
const layoutKey = 'project-shelf.home-layout';

export function Launcher({ projects, loading, failed, searchRef, searchContainer, onDetails, busy, launching, onOpen, onAction, onOrganize, onReorder, ordering, defaultSearchEngine }: {
  projects: Project[];
  loading: boolean;
  failed: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  searchContainer: HTMLDivElement | null;
  onDetails: (id: string) => void;
  busy: Set<string>;
  launching: Set<string>;
  onOpen: OpenProject;
  onAction: (project: Project, mode: RunMode | 'stop') => void;
  onOrganize: (kind: ProjectKind) => void;
  onReorder: (kind: ProjectKind, ids: string[], previousIds: string[]) => Promise<void>;
  ordering: boolean;
  defaultSearchEngine?: SearchEngine;
}) {
  const bookmarks = useBookmarks();
  const agentServers = useAgentServers();
  const available = useServerAvailable();
  const dragSnapshot = useRef<{ projects: Project[]; visible: string[] } | null>(null);
  const [query, setQuery] = useState('');
  const { bang, result: bangResult, loading: bangLoading, error: bangError, retry: retryBang } = useBangSearch(query, defaultSearchEngine);
  const [submittedBang, setSubmittedBang] = useState<string | null>(null);
  const bangUrl = bangResult?.url;
  useEffect(() => {
    if (submittedBang !== null && submittedBang === query && bangUrl) window.location.assign(bangUrl);
  }, [submittedBang, query, bangUrl]);
  const changeQuery = (value: string) => { setSubmittedBang(null); setQuery(value); };
  const [layout, setLayout] = useState<Layout>(() => {
    try { return localStorage.getItem(layoutKey) === 'grid' ? 'grid' : 'compact'; }
    catch { return 'compact'; }
  });
  useEffect(() => {
    try { localStorage.setItem(layoutKey, layout); }
    catch { /* Layout switching also works when browser storage is unavailable. */ }
  }, [layout]);
  const destinations = useMemo(() => projects
    .filter(project => !project.hidden)
    .map(project => ({ project, url: projectUrl(project) }))
    .filter(destination => destination.url), [projects]);
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = destinations.filter(({ project, url }) => {
      const searchable = [project.name, project.description, project.directory, project.source, url].join(' ').toLowerCase();
      return words.every(word => searchable.includes(word));
    });
    return [
      { id: 'projects', title: 'Projects', items: matches.filter(({ project }) => !project.favorite && project.kind === 'project') },
      { id: 'services', title: 'Services', items: matches.filter(({ project }) => !project.favorite && project.kind === 'service') },
      { id: 'favorites', title: 'Favorites', items: matches.filter(({ project }) => project.favorite) },
    ].filter(group => group.items.length || group.id === 'projects');
  }, [destinations, query]);
  // Destination collections stay intact; only bookmark folders form extra columns.
  const columns = useMemo(() => groups.map(group => ({ ...group, id: `${group.id}-0` })), [groups]);
  const matches = groups.flatMap(group => group.items);
  const matchingAgents = agentServers.servers.filter(server => query.trim().toLowerCase().split(/\s+/).every(word => `${server.name} ${server.cwd} ${server.url}`.toLowerCase().includes(word)));
  const firstReadyAgent = agentServers.available && !agentServers.error ? matchingAgents.find(server => server.ready) : undefined;
  const bookmarkMatches = searchBookmarks(bookmarks.tree, query);
  const firstBookmark = bookmarkMatches.find(node => bookmarkUrl(node));
  const unconfigured = projects.some(project => !project.hidden && !projectUrl(project));
  const allHidden = projects.length > 0 && projects.every(project => project.hidden);
  function prepareDrag(group: string) {
    dragSnapshot.current = { projects, visible: groups.find(item => item.id === group)?.items.map(item => item.project.id) ?? [] };
  }
  async function reorderItem(activeId: string, overId: string) {
    const snapshot = dragSnapshot.current;
    if (!snapshot || query || ordering || !available) throw new Error('Clear search and reconnect before reordering destinations.');
    const active = snapshot.projects.find(project => project.id === activeId);
    const over = snapshot.projects.find(project => project.id === overId);
    if (!active || !over || active.kind !== over.kind) throw new Error('Projects and services have separate saved orders.');
    const previousIds = snapshot.projects.filter(project => project.kind === active.kind).map(project => project.id);
    const kindIds = new Set(previousIds);
    const visibleIds = snapshot.visible.filter(id => kindIds.has(id));
    const ids = moveWithinSubset(previousIds, visibleIds, activeId, overId);
    if (!ids) throw new Error('This collection changed. Try dragging again.');
    if (activeId !== overId) await onReorder(active.kind, ids, previousIds);
  }
  const shelfColumns: ShelfColumn[] = loading ? [] : columns.map(group => ({
    id: `shelf:${group.id}`, title: group.title,
    actions: group.title !== 'Favorites' && group.items.length > 0 ? <button className="text-button" onClick={() => onOrganize(group.title === 'Services' ? 'service' : 'project')} aria-label={`Organize ${group.title.toLowerCase()}`}><ArrowsDownUp size={12} />Organize</button> : undefined,
    content: <><SortableContext items={group.items.map(item => shelfItemId(item.project.id))} strategy={verticalListSortingStrategy}><div className="launcher-grid">{group.items.map(destination => <DestinationLink key={destination.project.id} destination={destination} group={group.id.replace(/-\d+$/, '')} orderDisabled={Boolean(query) || ordering || !available} onPrepareDrag={() => prepareDrag(group.id.replace(/-\d+$/, ''))} busy={busy.has(destination.project.id)} launching={launching.has(destination.project.id)} onOpen={onOpen} onAction={mode => onAction(destination.project, mode)} onDetails={() => onDetails(destination.project.id)} />)}</div></SortableContext>{group.id === 'projects-0' && <AgentServers state={agentServers} query={query} />}</>,
  }));

  return <div className={`launcher${layout === 'compact' ? ' launcher-compact' : ''}${bookmarks.provider ? ' launcher-with-bookmarks' : ''}`} data-layout={layout}>
    <h1 className="sr-only">Project Shelf home</h1>
    {searchContainer && createPortal(<form className="launcher-search" role="search" onSubmit={event => {
      event.preventDefault();
      if (bang) { setSubmittedBang(query); return; }
      const first = matches[0];
      if (first?.project.kind === 'project') onOpen(first.project, false);
      else if (first) window.location.assign(first.url);
      else if (firstReadyAgent) window.location.assign(firstReadyAgent.url);
      else if (firstBookmark) window.location.assign(bookmarkUrl(firstBookmark));
    }}>
      <MagnifyingGlass size={17} weight="bold" aria-hidden="true" />
      <input ref={searchRef} value={query} onChange={event => changeQuery(event.target.value)} placeholder="Search your shelf or use !bangs" aria-label="Search destinations" aria-describedby="launcher-search-help" autoComplete="off" spellCheck={false} />
      {query ? <IconButton label="Clear search" onClick={() => { changeQuery(''); searchRef.current?.focus(); }}><X size={16} /></IconButton> : <kbd aria-hidden="true">/</kbd>}
    </form>, searchContainer)}
    <p id="launcher-search-help" className="sr-only">Press slash to search. Press Enter to open the first result. Use a bang such as !g, !gh, !yt, or !w followed by a query to search the web directly.</p>
    <div className="sr-only" role="status">{bang ? bangResult ? `${bangResult.search ? 'Search' : 'Open'} ${bangResult.name}${bangResult.search ? ` for ${bangResult.search}` : ''}` : '' : loading ? 'Loading destinations' : `${matches.length} shelf destinations and ${bookmarkMatches.length} browser bookmarks${query ? ' found' : ''}`}</div>

    {bang ? <BangSearch bang={bang} result={bangResult} loading={bangLoading} error={bangError} onRetry={retryBang} onSelect={value => { changeQuery(value); searchRef.current?.focus(); }} /> : <BrowserBookmarks bookmarks={bookmarks} query={query} shelfColumns={shelfColumns} onReorderShelfItem={reorderItem}>{loading ? <div className="launcher-grid launcher-loading" aria-label="Loading destinations" aria-busy="true">{Array.from({ length: 10 }, (_, index) => <div className="launcher-placeholder" key={index}><span /><i /></div>)}</div> : matches.length || matchingAgents.length || (query && bookmarkMatches.length) ? null : <div className="launcher-empty">
      <h2>{query ? 'No matching destinations.' : failed ? 'Your shelf is unavailable.' : allHidden ? 'All destinations are hidden.' : projects.length ? 'No addresses configured.' : 'Your shelf is empty.'}</h2>
      <p>{query ? 'Try a different name or address.' : failed ? 'Check the connection and try again.' : allHidden ? 'Show destinations again from the Hidden collection in Manage.' : 'Add a project address or a service in Manage.'}</p>
      {query ? <button className="text-button" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear search <ArrowRight size={14} /></button> : !failed && <a className="button" href="#manage">Manage destinations <ArrowRight size={14} /></a>}
    </div>}</BrowserBookmarks>}

    <footer className="launcher-footer">
      <div className="launcher-layout-switch" role="group" aria-label="Home layout">
        <button type="button" aria-pressed={layout === 'compact'} onClick={() => setLayout('compact')}><Rows size={15} />Compact</button>
        <button type="button" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><SquaresFour size={15} />Grid</button>
      </div>
      {!loading && <div className="launcher-order-actions">{(['project', 'service'] as const).filter(kind => projects.some(project => project.kind === kind)).map(kind => <button key={kind} className="text-button" onClick={() => onOrganize(kind)}><ArrowsDownUp size={13} />Order {kind === 'project' ? 'projects' : 'services'}</button>)}</div>}
      {!loading && destinations.length > 0 && <a href="#manage">{unconfigured ? 'Projects without an address are in Manage' : 'Manage projects and services'}<ArrowRight size={13} /></a>}
    </footer>
  </div>;
}

function DestinationLink({ destination: { project, url }, group, orderDisabled, onPrepareDrag, onDetails, busy, launching, onOpen, onAction }: { destination: Destination; group: string; orderDisabled: boolean; onPrepareDrag: () => void; onDetails: () => void; busy: boolean; launching: boolean; onOpen: OpenProject; onAction: (mode: RunMode | 'stop') => void }) {
  const available = useServerAvailable();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: shelfItemId(project.id), data: { type: 'shelf-item', group, kind: project.kind, name: project.name } satisfies ShelfItemDragData, disabled: orderDisabled });
  const active = isActive(project);
  const running = project.runtime.status === 'running';
  const transitional = ['starting', 'stopping'].includes(project.runtime.status);
  const working = busy || launching || transitional;
  const runtimeName = project.runtime.mode === 'build' ? 'Build' : project.runtime.mode === 'prod' ? 'Production' : 'Development';
  const runTitle = working
    ? `${project.runtime.status === 'stopping' ? 'Stopping' : launching ? 'Starting development for' : 'Working on'} ${project.name}`
    : active ? `${runtimeName} is running — stop ${project.name}`
    : project.devCommand ? `Run development for ${project.name}` : 'Add a development command in project details';
  return <div ref={setNodeRef} className={`launcher-entry${project.kind === 'project' ? ' launcher-project' : ''}${isDragging ? ' launcher-entry-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button type="button" ref={setActivatorNodeRef} className="icon-button launcher-drag-handle" {...attributes} {...listeners} disabled={orderDisabled} aria-label={`Reorder ${project.name}`} title={orderDisabled ? 'Clear search and reconnect to reorder; wait if an order is saving' : 'Drag to change saved order; Space and arrow keys also work'} onPointerDownCapture={onPrepareDrag} onMouseDown={event => { onPrepareDrag(); listeners?.onMouseDown?.(event); }} onTouchStart={event => { onPrepareDrag(); listeners?.onTouchStart?.(event); }} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') onPrepareDrag(); listeners?.onKeyDown?.(event); }}><DotsSixVertical size={15} /></button>
    <ProjectLink project={project} onOpen={onOpen} busy={launching} className="launcher-link" title={`${project.name}\n${project.kind === 'project' ? 'Start development, then open ' : ''}${url}`} aria-label={project.name}>
      <ProjectAvatar project={project} />
      <span className="launcher-label"><span className="launcher-name">{project.name.replace(/^\[[^\]]+\]\s*/, '')}</span><span className={`launcher-address${launching ? ' launcher-starting' : ''}`} role={launching ? 'status' : undefined}>{launching ? <><Spinner size={11} />Starting dev…</> : new URL(url).host}</span></span>
    </ProjectLink>
    <IconButton label={`Details for ${project.name}`} className="launcher-more" onClick={onDetails}><DotsThree size={18} weight="bold" /></IconButton>
    {project.kind === 'project' && <div className="launcher-actions" role="group" aria-label={`Commands for ${project.name}`}>
      <IconButton className={`launcher-run${running ? ' is-running' : ''}${working ? ' is-working' : ''}`} disabled={!available || working || (!active && !project.devCommand)} label={`${active ? 'Stop' : 'Run development for'} ${project.name}`} aria-pressed={active} aria-busy={working || undefined} title={available ? runTitle : 'Reconnect to run commands'} onClick={() => onAction(active ? 'stop' : 'dev')}>
        {working ? <Spinner size={14} /> : active ? <Stop size={13} weight="fill" aria-hidden="true" /> : <Play size={13} weight="fill" aria-hidden="true" />}
      </IconButton>
      <IconButton disabled={!available || working || active || !project.buildCommand} label={`Build ${project.name}`} title={project.buildCommand ? `Build ${project.name}` : 'Add a build command in project details'} onClick={() => onAction('build')}><Hammer size={15} aria-hidden="true" /></IconButton>
      <IconButton disabled={!available || working || active || !project.prodCommand} label={`Run production for ${project.name}`} title={project.prodCommand ? `Build and run production for ${project.name}` : 'Add a production command in project details'} onClick={() => onAction('prod')}><RocketLaunch size={15} aria-hidden="true" /></IconButton>
    </div>}
  </div>;
}
