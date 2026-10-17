import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SquaresFour, Play, Star, GlobeHemisphereWest, GearSix, Plus, MagnifyingGlass, ArrowClockwise, ArrowUpRight, ArrowsDownUp, DotsSixVertical, DotsThree, FolderOpen, X, List, Rows, ArrowRight, Stop, HardDrives, House, Eye, EyeSlash } from '@phosphor-icons/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project, ProjectKind, RunMode, Settings } from '../shared/types';
import { api, errorMessage, isActive, projectUrl, sourceLabel, urlLabel } from './api';
import { Dialog, ErrorNotice, HostnameSelect, IconButton, OpenLink, ProjectAvatar, Spinner, Status, Toast, type OpenProject } from './components';
import { AddProjectDialog } from './AddProjectDialog';
import { DetailsSheet } from './DetailsSheet';
import { SettingsDialog } from './SettingsDialog';
import { Launcher } from './Launcher';
import { ServerAvailable, useServerAvailable } from './connection';
import { useShelfData } from './useShelfData';
import { UpdateNotice } from './Pwa';
import { shelfPlatform } from './platform';
import { OrganizeDialog } from './OrganizeDialog';
import { ProjectOrderGrid } from './ProjectOrderGrid';
import { moveWithinSubset } from '../shared/ordering';
import { shelfItemId, type ShelfItemDragData } from './shelf-columns';

type View = 'all' | 'running' | 'favorites' | 'services' | 'hidden';
type Route = 'home' | View;
const viewNames: Record<View, string> = { all: 'All projects', running: 'Running', favorites: 'Favorites', services: 'Services', hidden: 'Hidden' };

function readRoute(): Route {
  const hash = window.location.hash;
  if (hash === '#manage') return 'all';
  const view = hash.replace(/^#manage\//, '');
  return ['running', 'favorites', 'services', 'hidden'].includes(view) ? view as View : 'home';
}

const viewHref = (view: View) => view === 'all' ? '#manage' : `#manage/${view}`;

function ShelfMark() {
  return <span className="shelf-mark" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="M5 23V6h4v17M12 23V4h4v19M19 23V9l4-1 3 14M3 24h23" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg></span>;
}

export default function App() {
  const { projects, setProjects, settings, setSettings, loading, unavailable, checking, savedAt, loadError, refresh } = useShelfData();
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>(readRoute);
  const management = route !== 'home';
  const view: View = management ? route : 'all';
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('shelf');
  const [organizeKind, setOrganizeKind] = useState<ProjectKind | null>(null);
  const [ordering, setOrdering] = useState(false);
  const orderPending = useRef(false);
  const manageDrag = useRef<{ projects: Project[]; visible: string[] } | null>(null);
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [searchContainer, setSearchContainer] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [launching, setLaunching] = useState<Set<string>>(new Set());
  const [launchError, setLaunchError] = useState<{ id: string; message: string } | null>(null);
  const launches = useRef(new Map<string, AbortController>());
  const sameTabLaunch = useRef<AbortController | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const currentViewRef = useRef<HTMLAnchorElement>(null);
  const dismissToast = useCallback(() => setNotice(''), []);

  const load = () => { setError(''); void refresh().catch(() => {}); };
  useEffect(() => () => { for (const controller of launches.current.values()) controller.abort(); }, []);
  useEffect(() => {
    if (management) currentViewRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [management, view, loading]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable && !selectedId && !addOpen && !settingsOpen && !navOpen && !organizeKind && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        event.preventDefault(); searchRef.current?.focus();
      }
    }
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [selectedId, addOpen, settingsOpen, navOpen, organizeKind]);
  useEffect(() => {
    const navigate = () => {
      setRoute(readRoute());
      setSource('all');
      setQuery('');
      setNavOpen(false);
      setSelectedId(null);
      setAddOpen(false);
      setSettingsOpen(false);
      setOrganizeKind(null);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  const upsert = useCallback((project: Project) => setProjects(current => current.some(item => item.id === project.id) ? current.map(item => item.id === project.id ? project : item) : [...current, project]), []);
  const openProject = useCallback<OpenProject>((project, newTab) => {
    if (unavailable) { setError('Reconnect to the server before starting a project. Saved service links can still open.'); return; }
    if (launches.current.has(project.id)) return;
    const destination = newTab ? window.open('about:blank', '_blank') : null;
    if (newTab && !destination) {
      const message = 'Allow pop-ups for Project Shelf, then try opening the project again.';
      setError(message); setLaunchError({ id: project.id, message }); return;
    }
    if (destination) {
      destination.opener = null;
      destination.document.title = `Starting ${project.name}`;
      destination.document.body.textContent = `Starting development for ${project.name}… This tab will open the project when it is ready.`;
    }
    const controller = new AbortController();
    if (!newTab) { sameTabLaunch.current?.abort(); sameTabLaunch.current = controller; }
    launches.current.set(project.id, controller);
    setLaunching(current => new Set(current).add(project.id));
    setError('');
    setLaunchError(null);
    void (async () => {
      try {
        const result = await api.launch(project.id, controller.signal);
        if (controller.signal.aborted) return;
        upsert(result.project);
        const url = projectUrl(result.project);
        if (!url) throw new Error('Configure a project address in project details before opening it.');
        if (destination) { if (!destination.closed) destination.location.replace(url); }
        else window.location.assign(url);
      } catch (err) {
        destination?.close();
        if (!controller.signal.aborted) {
          const message = `Could not open ${project.name}: ${errorMessage(err)}`;
          setError(message);
          setLaunchError({ id: project.id, message });
        }
      } finally {
        launches.current.delete(project.id);
        if (sameTabLaunch.current === controller) sameTabLaunch.current = null;
        setLaunching(current => { const next = new Set(current); next.delete(project.id); return next; });
      }
    })();
  }, [upsert, unavailable]);
  const updateProject = useCallback(async (id: string, data: Partial<Project>) => {
    setBusy(current => new Set(current).add(id));
    try {
      const result = await api.update(id, data);
      upsert(result.project);
      if (data.hidden !== undefined) setNotice(data.hidden ? `${result.project.name} hidden. You can show it again in Manage → Hidden.` : `${result.project.name} shown on the dashboard.`);
      return result.project;
    }
    finally { setBusy(current => { const next = new Set(current); next.delete(id); return next; }); }
  }, [upsert]);
  const action = useCallback(async (project: Project, mode: RunMode | 'stop') => {
    setBusy(current => new Set(current).add(project.id));
    try {
      const result = mode === 'stop' ? await api.stop(project.id) : await api.start(project.id, mode);
      upsert(result.project);
      setNotice(mode === 'stop' ? `${project.name} stopped.` : `${mode === 'build' ? 'Build' : mode === 'prod' ? 'Production' : 'Development'} started for ${project.name}.`);
    } catch (err) { setError(errorMessage(err)); throw err; }
    finally { setBusy(current => { const next = new Set(current); next.delete(project.id); return next; }); }
  }, [upsert]);
  const patchFromCard = (project: Project, data: Partial<Project>) => {
    void updateProject(project.id, data).then(() => {
      if (data.hidden === false) searchRef.current?.focus();
    }).catch(err => setError(errorMessage(err)));
  };
  const scan = async () => {
    setScanning(true);
    try {
      const result = await api.scan();
      await refresh();
      setNotice(`Scan complete. ${result.added} ${result.added === 1 ? 'project' : 'projects'} added; ${result.existing} already on your shelf.`);
      if (result.errors.length) setError(`Some folders could not be scanned: ${result.errors.join(' · ')}`);
    } catch (err) { setError(errorMessage(err)); }
    finally { setScanning(false); }
  };

  const reorderProjects = async (kind: ProjectKind, ids: string[], previousIds: string[]) => {
    if (unavailable) throw new Error('Reconnect to save the project or service order.');
    if (orderPending.current) throw new Error('Wait for the current order to save before moving another item.');
    orderPending.current = true; setOrdering(true);
    try {
      const result = await api.reorder(kind, ids, previousIds);
      setProjects(result.projects); setSort('shelf'); setNotice('Shelf order saved.');
    } catch (error) {
      setError(errorMessage(error));
      await refresh().catch(() => {});
      throw error;
    } finally { orderPending.current = false; setOrdering(false); }
  };
  const reorderManagedItem = async (activeId: string, overId: string) => {
    const snapshot = manageDrag.current;
    const active = snapshot?.projects.find(project => project.id === activeId);
    if (!snapshot || !active || snapshot.projects.find(project => project.id === overId)?.kind !== active.kind) return;
    const previousIds = snapshot.projects.filter(project => project.kind === active.kind).map(project => project.id);
    const kindIds = new Set(previousIds);
    const ids = moveWithinSubset(previousIds, snapshot.visible.filter(id => kindIds.has(id)), activeId, overId);
    if (!ids) { setError('This collection changed. Try dragging again.'); return; }
    await reorderProjects(active.kind, ids, previousIds);
  };

  const dashboardProjects = useMemo(() => projects.filter(project => !project.hidden), [projects]);
  const counts = useMemo(() => ({ all: dashboardProjects.length, running: dashboardProjects.filter(p => p.kind === 'project' && isActive(p)).length, favorites: dashboardProjects.filter(p => p.favorite).length, services: dashboardProjects.filter(p => p.kind === 'service').length, hidden: projects.length - dashboardProjects.length }), [projects, dashboardProjects]);
  const countLabel = (key: View) => loading || (key === 'running' && unavailable) ? '–' : counts[key];
  const sources = useMemo(() => [...new Set((view === 'hidden' ? projects.filter(project => project.hidden) : dashboardProjects).map(p => p.source))].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b))), [projects, dashboardProjects, view]);
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase();
    return projects.filter(project => {
      if (view === 'hidden' ? !project.hidden : project.hidden) return false;
      if (view === 'running' && (project.kind !== 'project' || !isActive(project))) return false;
      if (view === 'favorites' && !project.favorite) return false;
      if (view === 'services' && project.kind !== 'service') return false;
      if (source !== 'all' && project.source !== source) return false;
      return !words || [project.name, project.description, project.directory, project.url, project.source].some(value => value.toLowerCase().includes(words));
    }).sort((a, b) => sort === 'shelf' ? 0 : sort === 'recent' ? b.createdAt.localeCompare(a.createdAt) : sort === 'running' ? Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  }, [projects, query, view, source, sort]);
  const selected = projects.find(project => project.id === selectedId);
  const orderDisabled = unavailable || ordering || sort !== 'shelf' || Boolean(query) || source !== 'all';
  const navIcons = { all: SquaresFour, running: Play, favorites: Star, services: GlobeHemisphereWest, hidden: EyeSlash };

  return <ServerAvailable.Provider value={!unavailable}><div className="app-shell">
    {navOpen && <Dialog title="Project Shelf" className="navigation-dialog" onClose={() => setNavOpen(false)}>
      <nav id="shelf-navigation" className="main-navigation" aria-label="Main navigation">
        <a className={`nav-item ${!management ? 'active' : ''}`} href="#" aria-current={!management ? 'page' : undefined} onClick={() => setNavOpen(false)}><House size={19} weight={!management ? 'fill' : 'regular'} /><span>Home</span></a>
        <p className="sidebar-group-label">Manage</p>
        {(Object.keys(viewNames) as View[]).map(key => {
        const Icon = navIcons[key];
        const current = management && view === key;
        return <a key={key} href={viewHref(key)} className={`nav-item ${current ? 'active' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => setNavOpen(false)}><Icon size={19} weight={current ? 'fill' : 'regular'} /><span>{viewNames[key]}</span><span className="nav-count">{countLabel(key)}</span></a>;
      })}</nav>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => { setSettingsOpen(true); setNavOpen(false); }}><GearSix size={19} /><span>Settings</span></button></div>
    </Dialog>}

    <div className="workspace">
      <header className={`topbar${!management ? ' topbar-home' : ''}`}><div className="topbar-inner"><div className="topbar-start"><IconButton label="Open navigation" aria-expanded={navOpen} aria-controls={navOpen ? 'shelf-navigation' : undefined} onClick={() => setNavOpen(true)}><List size={20} weight="bold" /></IconButton><a className="brand" href="#" aria-label="Project Shelf home"><ShelfMark /><span>Project Shelf</span></a></div>{!management && <div className="topbar-search" ref={setSearchContainer} />}<div className="topbar-actions"><a className={`manage-link ${management ? 'active' : ''}`} href="#manage" aria-current={management ? 'page' : undefined}>Manage</a>{shelfPlatform().openExtensionSettings && <IconButton label="Extension connection settings" onClick={() => { void shelfPlatform().openExtensionSettings?.().catch(err => setError(errorMessage(err))); }}><HardDrives size={19} /></IconButton>}<IconButton label="Open settings" onClick={() => setSettingsOpen(true)}><GearSix size={19} /></IconButton></div></div></header>
      <main className={management ? 'main-content' : 'launcher-main'}>
        {management && <header className="page-heading"><div><h1>Manage</h1><p className="page-description">Projects, services, and running commands.</p></div><div className="page-actions"><button className="button scan-button" onClick={() => void scan()} disabled={unavailable || scanning || loading}>{scanning ? <Spinner /> : <ArrowClockwise size={16} weight="bold" />}<span>{scanning ? 'Scanning…' : 'Scan folders'}</span></button><button className="button button-primary" disabled={unavailable} onClick={() => setAddOpen(true)}><Plus size={17} weight="bold" />Add project</button></div></header>}

        {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
        <UpdateNotice />
        {unavailable && !loading && !checking && <div className="connection-notice" role="status"><strong>Server unavailable.</strong> {savedAt ? <>Showing destinations saved <time dateTime={savedAt}>{new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>. Search and service links still work. Process status is unknown; server actions are paused.</> : 'No saved destinations on this device yet. Connect once to save your shelf for offline use.'} Reconnecting automatically. <button className="text-button" onClick={load}>Retry now</button></div>}

        {!management ? <Launcher projects={projects} defaultSearchEngine={settings?.defaultSearchEngine} loading={loading} failed={Boolean(error || loadError)} searchRef={searchRef} searchContainer={searchContainer} onDetails={setSelectedId} busy={busy} launching={launching} onOpen={openProject} onOrganize={setOrganizeKind} ordering={ordering} onReorder={reorderProjects} onAction={(project, mode) => { void action(project, mode).catch(() => {}); }} /> : <>
        <nav className="management-views" aria-label="Manage collections">{(Object.keys(viewNames) as View[]).map(key => <a href={viewHref(key)} key={key} ref={view === key ? currentViewRef : undefined} className={view === key ? 'active' : ''} aria-current={view === key ? 'page' : undefined}>{viewNames[key]}<span>{countLabel(key)}</span></a>)}</nav>
        <section className="collection" aria-label={viewNames[view]}>
          {view === 'hidden' && <p className="hidden-description">Hidden entries stay off Home and other collections, even after a rescan. Running commands are not stopped.</p>}
          <div className="collection-toolbar"><div className="collection-title"><h2>{viewNames[view]}</h2><span className="count-badge">{loading ? '–' : visible.length}</span>{!loading && counts.running > 0 && <span className="running-summary"><span className="status-dot" />{counts.running} active</span>}</div><div className="toolbar-right"><div className="search"><MagnifyingGlass size={17} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a project…" aria-label="Search projects" />{query ? <IconButton label="Clear search" onClick={() => setQuery('')}><X size={14} /></IconButton> : <kbd>/</kbd>}</div><div className="view-switch" aria-label="Project layout"><IconButton label="Grid view" className={layout === 'grid' ? 'selected' : ''} aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><SquaresFour size={17} weight={layout === 'grid' ? 'fill' : 'regular'} /></IconButton><IconButton label="List view" className={layout === 'list' ? 'selected' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><Rows size={18} /></IconButton></div></div></div>
          <div className="management-order-actions"><span>Shelf order</span>{(['project', 'service'] as const).map(kind => <button key={kind} className="text-button" disabled={loading || !projects.some(project => project.kind === kind)} onClick={() => setOrganizeKind(kind)}><ArrowsDownUp size={14} />Organize {kind === 'project' ? 'projects' : 'services'}</button>)}</div>
          <div className="filter-bar"><div className="source-filters" aria-label="Filter by source"><button className={`source-filter ${source === 'all' ? 'selected' : ''}`} onClick={() => setSource('all')}>All sources</button>{sources.map(item => <button key={item} className={`source-filter ${source === item ? 'selected' : ''}`} onClick={() => setSource(item)} title={item}>{sourceLabel(item)}</button>)}</div><label className="sort-control"><span className="sr-only">Sort projects</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="shelf">Shelf order</option><option value="name">Name, A–Z</option><option value="recent">Recently added</option><option value="running">Active first</option></select></label></div>

          {loading ? <div className="project-grid loading-grid" aria-label="Loading projects" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="skeleton-card" key={index}><div className="skeleton-avatar" /><div className="skeleton-line" /><div className="skeleton-line short" /><div className="skeleton-bottom" /></div>)}</div> : visible.length ? <ProjectOrderGrid projects={visible} disabled={orderDisabled} onStart={() => { manageDrag.current = { projects, visible: visible.map(project => project.id) }; }} onMove={reorderManagedItem}><div className={`project-grid ${layout === 'list' ? 'list-layout' : ''}`}>{visible.map(project => <ProjectCard key={project.id} project={project} settings={settings} orderDisabled={orderDisabled} busy={busy.has(project.id)} launching={launching.has(project.id)} onOpen={openProject} onDetails={() => setSelectedId(project.id)} onUpdate={data => patchFromCard(project, data)} onAction={mode => { void action(project, mode).catch(() => {}); }} />)}</div></ProjectOrderGrid> : <div className="empty-state">
            <span className="empty-icon">{query || source !== 'all' ? <MagnifyingGlass size={30} /> : view === 'hidden' ? <EyeSlash size={30} /> : view === 'favorites' ? <Star size={30} /> : view === 'running' ? <Play size={30} /> : <FolderOpen size={32} weight="duotone" />}</span>
            <h3>{unavailable && view === 'running' ? 'Process status is unavailable.' : query || source !== 'all' ? 'No matching entries.' : (error || loadError) && !projects.length ? 'Your shelf is unavailable.' : view === 'hidden' ? 'No hidden entries.' : view === 'favorites' ? 'No favorites yet.' : view === 'running' ? 'No active projects.' : view === 'services' ? 'No services yet.' : 'No projects yet.'}</h3>
            <p>{unavailable && view === 'running' ? 'Reconnect to see running processes. Saved destinations are in All projects.' : query || source !== 'all' ? 'Try another name or choose a different source.' : (error || loadError) && !projects.length ? 'Check that the server is running, then try again.' : view === 'hidden' ? 'Hide an entry from its details to keep it off the dashboard without removing it.' : view === 'favorites' ? 'Star a project or service to keep it nearby.' : view === 'running' ? 'Start a development server from All projects. It will appear here while it’s active.' : view === 'services' ? 'Add a service address or import bookmarks in Settings.' : counts.hidden ? 'Your hidden entries are still available in the Hidden collection.' : 'Scan your project folders or add an existing project.'}</p>
            <div className="empty-actions">{query || source !== 'all' ? <button className="button" onClick={() => { setQuery(''); setSource('all'); }}>Clear filters</button> : (error || loadError) && !projects.length ? <button className="button" onClick={load}><ArrowClockwise size={16} />Try again</button> : view === 'running' || view === 'favorites' || view === 'hidden' ? <a className="button" href="#manage">Browse all projects<ArrowRight size={16} /></a> : view === 'all' && counts.hidden ? <a className="button" href="#manage/hidden"><EyeSlash size={16} />View hidden entries</a> : <><button className="button button-primary" disabled={unavailable} onClick={() => setAddOpen(true)}><Plus size={16} />Add {view === 'services' ? 'a service' : 'a project'}</button><button className="button" onClick={() => view === 'services' ? setSettingsOpen(true) : void scan()} disabled={unavailable || scanning}>{scanning ? <Spinner /> : view === 'services' ? <GlobeHemisphereWest size={16} /> : <ArrowClockwise size={16} />}{view === 'services' ? 'Import bookmarks' : 'Scan folders'}</button></>}</div>
          </div>}
        </section>
        <footer className="page-footer"><a className="text-button" href="#"><ArrowRight size={13} className="back-arrow" />Back to Home</a><button className="text-button" onClick={() => setSettingsOpen(true)}><HardDrives size={14} />{settings ? `${settings.roots.length} project ${settings.roots.length === 1 ? 'root' : 'roots'}` : 'Manage folders'}<ArrowUpRight size={12} /></button></footer>
        </>}
      </main>
    </div>
    {addOpen && <AddProjectDialog initialKind={view === 'services' ? 'service' : 'project'} onClose={() => setAddOpen(false)} onCreated={project => { upsert(project); setAddOpen(false); setNotice(`${project.name} added to your shelf.`); }} />}
    {selected && <DetailsSheet project={selected} settings={settings} busy={busy.has(selected.id)} launching={launching.has(selected.id)} launchError={launchError?.id === selected.id ? launchError.message : ''} onOpen={openProject} onClose={() => setSelectedId(null)} onUpdate={data => updateProject(selected.id, data)} onAction={mode => action(selected, mode)} onDuplicated={project => { upsert(project); setSelectedId(project.id); setNotice(`${project.name} added to your shelf.`); }} onRemoved={() => { setProjects(current => current.filter(p => p.id !== selected.id)); setSelectedId(null); setNotice('Project removed from your shelf.'); }} />}
    {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSaved={setSettings} onChanged={refresh} notify={setNotice} />}
    {organizeKind && <OrganizeDialog title={`Organize ${organizeKind === 'project' ? 'projects' : 'services'}`} description="This order is shared by Home, Manage, and every connected extension. Hidden entries and projects without an address are included; favorites remain in their own Home group." items={projects.filter(project => project.kind === organizeKind).map(project => ({ id: project.id, name: project.name, detail: `${project.hidden ? 'Hidden · ' : ''}${project.favorite ? 'Favorite · ' : ''}${projectUrl(project) || project.directory || 'No address configured'}`, icon: <ProjectAvatar project={project} /> }))} disabled={unavailable || ordering} onClose={() => setOrganizeKind(null)} onSave={(ids, previousIds) => reorderProjects(organizeKind, ids, previousIds)} />}
    {notice && <Toast message={notice} onDismiss={dismissToast} />}
  </div></ServerAvailable.Provider>;
}

function ProjectCard({ project, settings, orderDisabled, busy, launching, onOpen, onDetails, onUpdate, onAction }: { project: Project; settings: Settings | null; orderDisabled: boolean; busy: boolean; launching: boolean; onOpen: OpenProject; onDetails: () => void; onUpdate: (data: Partial<Project>) => void; onAction: (mode: RunMode | 'stop') => void }) {
  const unavailable = !useServerAvailable();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: shelfItemId(project.id), data: { type: 'shelf-item', group: 'manage', kind: project.kind, name: project.name } satisfies ShelfItemDragData, disabled: orderDisabled });
  const active = isActive(project);
  const url = projectUrl(project);
  const transitional = ['starting', 'stopping'].includes(project.runtime.status);
  return <article ref={setNodeRef} className={`project-card ${active ? 'is-active' : ''}${isDragging ? ' project-card-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <div className="card-top"><button ref={setActivatorNodeRef} type="button" className="icon-button card-order-handle" {...attributes} {...listeners} disabled={orderDisabled} aria-label={`Reorder ${project.name}`} title={orderDisabled ? 'Choose Shelf order, clear filters, and reconnect to reorder' : 'Drag to change saved shelf order'}><DotsSixVertical size={17} /></button><button className="avatar-button" aria-label={`View ${project.name}`} onClick={onDetails}><ProjectAvatar project={project} /></button><Status project={project} /><IconButton label={project.favorite ? `Unfavorite ${project.name}` : `Favorite ${project.name}`} className={`favorite-button ${project.favorite ? 'is-favorite' : ''}`} disabled={unavailable || busy} onClick={() => onUpdate({ favorite: !project.favorite })}><Star size={18} weight={project.favorite ? 'fill' : 'regular'} /></IconButton></div>
    <div className="card-info"><h3><button onClick={onDetails}>{project.name}</button></h3><p className={`card-description ${!project.description ? 'no-description' : ''}`}>{project.description || (project.kind === 'service' ? url ? urlLabel(project) : 'A place on your local network.' : project.directory || 'Local development project.')}</p></div>
    <div className="card-meta"><span className="source-label" title={project.source}>{project.kind === 'service' ? <GlobeHemisphereWest size={13} /> : <FolderOpen size={13} />}{sourceLabel(project.source)}</span>{project.port !== null && <span className="port-label">:{project.port}</span>}</div>
    <div className="card-address"><span className="address-label" title={url || 'No URL configured'}><span className="address-dot" />{url ? urlLabel(project) : 'No address configured'}</span><HostnameSelect project={project} settings={settings} disabled={unavailable || busy} onChange={hostname => onUpdate({ hostname })} compact /></div>
    <div className="card-actions">{project.hidden ? <button className="button card-run" disabled={unavailable || busy} aria-label={`Show ${project.name} on dashboard`} onClick={() => onUpdate({ hidden: false })}>{busy ? <Spinner size={14} /> : <Eye size={15} />}Show</button> : project.kind === 'project' ? <button className={`button card-run ${active ? 'button-stop' : ''}`} disabled={unavailable || busy || transitional || (!active && !project.devCommand)} title={unavailable ? 'Reconnect to run commands' : !active && !project.devCommand ? 'Add a development command in project details' : undefined} onClick={() => onAction(active ? 'stop' : 'dev')}>{busy || transitional ? <Spinner size={14} /> : active ? <Stop size={13} weight="fill" /> : <Play size={13} weight="fill" />}{transitional ? project.runtime.status === 'starting' ? 'Starting…' : 'Stopping…' : active ? 'Stop' : 'Start dev'}</button> : <button className="button card-run" onClick={onDetails}><GlobeHemisphereWest size={15} />Details</button>}<div className="card-actions-right"><OpenLink project={project} onOpen={onOpen} busy={launching} className="button-open" /><IconButton label={`Details for ${project.name}`} className="more-button" onClick={onDetails}><DotsThree size={22} weight="bold" /></IconButton></div></div>
  </article>;
}
