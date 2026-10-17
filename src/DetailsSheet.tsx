import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Play, Stop, Hammer, RocketLaunch, Star, Copy, Trash, FolderOpen, Image, Check, TerminalWindow, ArrowClockwise, DownloadSimple, ArrowDown, CaretRight, Eye, EyeSlash } from '@phosphor-icons/react';
import type { Project, Settings, RunMode, LogoFile, LogLine } from '../shared/types';
import { api, errorMessage, isActive } from './api';
import { Dialog, ErrorNotice, Field, HostnameSelect, IconButton, OpenLink, ProjectAvatar, Spinner, Status, type OpenProject } from './components';
import { useServerAvailable } from './connection';

type Tab = 'overview' | 'commands' | 'logs' | 'duplicate' | 'remove';
type Draft = Pick<Project, 'name' | 'description' | 'directory' | 'url' | 'hostname' | 'devCommand' | 'buildCommand' | 'prodCommand' | 'logo'> & { port: string };
function draftFor(project: Project): Draft {
  return { name: project.name, description: project.description, directory: project.directory, url: project.url, hostname: project.hostname, devCommand: project.devCommand, buildCommand: project.buildCommand, prodCommand: project.prodCommand, logo: project.logo, port: project.port === null ? '' : String(project.port) };
}

export function DetailsSheet({ project, settings, busy, launching, launchError, onOpen, onClose, onUpdate, onAction, onDuplicated, onRemoved }: { project: Project; settings: Settings | null; busy: boolean; launching: boolean; launchError: string; onOpen: OpenProject; onClose: () => void; onUpdate: (data: Partial<Project>) => Promise<Project>; onAction: (mode: RunMode | 'stop') => Promise<void>; onDuplicated: (project: Project) => void; onRemoved: () => void }) {
  const available = useServerAvailable();
  const disabled = busy || !available;
  const [tab, setTab] = useState<Tab>('overview');
  const [draft, setDraft] = useState<Draft>(() => draftFor(project));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [logos, setLogos] = useState<LogoFile[]>([]);
  const [logoLoading, setLogoLoading] = useState(false);
  const [duplicateName, setDuplicateName] = useState(`${project.name} copy`);
  const [duplicateDirectory, setDuplicateDirectory] = useState('');
  const [copyFiles, setCopyFiles] = useState(false);
  const [working, setWorking] = useState(false);
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const active = isActive(project);
  const transitional = ['starting', 'stopping'].includes(project.runtime.status);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFor(project));

  useEffect(() => {
    setDraft(draftFor(project)); setTab('overview'); setError(''); setSaved(false); setLogoOpen(false);
    setDuplicateName(`${project.name} copy`); setDuplicateDirectory(''); setCopyFiles(false); setRemoveConfirmed(false);
  }, [project.id]);

  async function save(event?: FormEvent) {
    event?.preventDefault(); setError(''); setSaved(false);
    if (!available) { setError('Reconnect to save changes. Your draft is still here.'); return; }
    if (!draft.name.trim()) { setError('A project name is required.'); return; }
    if (draft.port && (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535)) { setError('Port must be a whole number between 1 and 65535.'); return; }
    if (draft.url) {
      try { const url = new URL(draft.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { setError('Use a complete HTTP or HTTPS address.'); return; }
    }
    try {
      const updated = await onUpdate({ ...draft, name: draft.name.trim(), directory: draft.directory.trim(), port: draft.port ? Number(draft.port) : null });
      setDraft(draftFor(updated)); setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
  }

  async function loadLogos() {
    setLogoOpen(value => !value);
    if (logoOpen) return;
    setLogoLoading(true); setError('');
    try { const result = await api.logos(project.id); setLogos(result.logos); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLogoLoading(false); }
  }
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => ({ ...current, [key]: value })); setSaved(false); }
  async function run(mode: RunMode | 'stop') {
    setError('');
    try { await onAction(mode); if (mode !== 'stop') setTab('logs'); }
    catch (err) { setError(errorMessage(err)); }
  }
  async function duplicate(event: FormEvent) {
    event.preventDefault(); setWorking(true); setError('');
    try {
      const result = await api.duplicate(project.id, { name: duplicateName.trim(), ...(duplicateDirectory.trim() ? { directory: duplicateDirectory.trim() } : {}), copyFiles });
      onDuplicated(result.project);
    } catch (err) { setError(errorMessage(err)); }
    finally { setWorking(false); }
  }
  async function remove() {
    setWorking(true); setError('');
    try { await api.remove(project.id); onRemoved(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setWorking(false); }
  }

  return <Dialog title={project.name} eyebrow={project.kind === 'service' ? 'SERVICE DETAILS' : 'PROJECT DETAILS'} className="sheet details-sheet" onClose={onClose} footer={<><div className="sheet-footer-status">{saved ? <span className="saved-label"><Check size={15} />Changes saved</span> : dirty ? <span className="unsaved-label">Unsaved changes</span> : <Status project={project} />}</div>{(tab === 'overview' || tab === 'commands') && <><button className="button" onClick={() => { setDraft(draftFor(project)); setSaved(false); }} disabled={!dirty || busy}>Reset</button><button className="button button-primary" onClick={() => void save()} disabled={disabled || !dirty}>{busy ? <Spinner /> : <Check size={16} weight="bold" />}Save changes</button></>}{tab === 'logs' && <OpenLink project={project} onOpen={onOpen} busy={launching} />}{(tab === 'duplicate' || tab === 'remove') && <button className="button" onClick={() => { setTab('overview'); setError(''); }}>Back to project</button>}</>}>
    {!available && <div className="connection-notice" role="status">Saved details. Reconnect to run commands or save edits. Your draft stays open.</div>}
    <div className="detail-profile"><ProjectAvatar project={{ ...project, logo: draft.logo, name: draft.name }} large /><div><Status project={project} /><p className="detail-directory" title={project.directory || project.url}>{project.directory ? <FolderOpen size={14} /> : null}{project.directory || project.url || 'No address configured'}</p></div><IconButton label={project.favorite ? 'Remove from favorites' : 'Add to favorites'} disabled={disabled} className={project.favorite ? 'is-favorite' : ''} onClick={() => void onUpdate({ favorite: !project.favorite }).catch(err => setError(errorMessage(err)))}><Star size={21} weight={project.favorite ? 'fill' : 'regular'} /></IconButton></div>
    <div className="detail-quick-actions">{project.kind === 'project' && <><button className={`button ${active ? 'button-stop' : 'button-primary'}`} disabled={disabled || transitional || (!active && (!project.devCommand || dirty))} onClick={() => void run(active ? 'stop' : 'dev')}>{busy || transitional ? <Spinner size={15} /> : active ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}{active ? 'Stop process' : 'Start development'}</button><button className="button" disabled={disabled || active || dirty || !project.prodCommand} onClick={() => void run('prod')} title="Build, then start the production server"><RocketLaunch size={16} />Production</button></>}<OpenLink project={project} onOpen={onOpen} busy={launching} className={project.kind === 'service' ? 'button-primary' : ''} /></div>
    <div className="detail-tabs" aria-label="Project detail sections">{(['overview', ...(project.kind === 'project' ? ['commands', 'logs'] : [])] as Tab[]).map(item => <button type="button" key={item} className={tab === item ? 'selected' : ''} aria-pressed={tab === item} onClick={() => { setTab(item); setError(''); }}>{item === 'overview' ? 'Overview' : item === 'commands' ? 'Commands' : <><TerminalWindow size={15} />Live logs{active && <span className="live-dot" />}</>}</button>)}</div>
    {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
    {launchError && <ErrorNotice message={launchError} />}
    <fieldset className="connection-fields" disabled={!available}>
    {tab === 'overview' && <form className="detail-form" onSubmit={event => void save(event)}>
      <div className="section-heading"><h3>The essentials</h3><span>{project.kind === 'service' ? 'Service' : 'Local project'}</span></div>
      <Field label="Name"><input data-autofocus required value={draft.name} onChange={event => edit('name', event.target.value)} maxLength={160} /></Field>
      <Field label="Description"><textarea rows={2} value={draft.description} onChange={event => edit('description', event.target.value)} placeholder="A short note about this project." maxLength={1000} /></Field>
      {project.kind === 'project' && <Field label="Project directory" hint="Commands run in this directory. Changing this does not move files."><input className="mono" value={draft.directory} onChange={event => edit('directory', event.target.value)} /></Field>}
      <div className="form-section"><div className="section-heading"><h3>Connection</h3></div><div className={`form-columns ${project.kind === 'project' ? 'address-columns' : 'single-column'}`}><Field label="Original URL"><input className="mono" type="url" value={draft.url} onChange={event => edit('url', event.target.value)} placeholder="http://localhost:3000" /></Field>{project.kind === 'project' && <Field label="Port"><input type="number" min="1" max="65535" value={draft.port} onChange={event => edit('port', event.target.value)} placeholder="Auto" /></Field>}</div><div className="field"><span className="field-label">Preferred hostname</span><HostnameSelect project={{ ...project, hostname: draft.hostname }} settings={settings} onChange={hostname => edit('hostname', hostname)} /><span className="field-hint">Only the hostname changes. The port, protocol, and path stay intact.</span></div></div>
      {project.kind === 'project' && <div className="form-section">
        <div className="section-heading"><h3>Project identity</h3><span>Make it easy to find.</span></div>
        <div className="logo-settings"><ProjectAvatar project={{ ...project, logo: draft.logo, name: draft.name }} /><div><strong>{draft.logo ? 'Project image' : 'A simple monogram'}</strong><p>{draft.logo || 'A little personality, made from the name.'}</p></div><button className="button" type="button" disabled={!available} aria-expanded={logoOpen} onClick={() => void loadLogos()}><Image size={16} />Choose logo</button></div>
        {logoOpen && <div className="logo-browser">
          <Field label="Image URL or relative path" hint="Use an HTTP/HTTPS image URL or a path inside this project. Remote images load directly from their host."><input className="mono" value={draft.logo} onChange={event => edit('logo', event.target.value)} placeholder="https://example.com/logo.png or public/logo.svg" maxLength={4096} spellCheck={false} /></Field>
          <div className="logo-browser-heading"><span>Images in this project</span>{logoLoading && <Spinner />}</div>
          {!logoLoading && <><div className="logo-options"><button className={`logo-option monogram-option ${!draft.logo ? 'selected' : ''}`} type="button" onClick={() => edit('logo', '')}><ProjectAvatar project={{ ...project, name: draft.name, logo: '' }} /><span>Monogram</span></button>{logos.map(logo => <button className={`logo-option ${draft.logo === logo.path ? 'selected' : ''}`} type="button" key={logo.path} title={logo.path} onClick={() => edit('logo', logo.path)}><ProjectAvatar project={{ ...project, name: draft.name, logo: logo.path }} /><span>{logo.path.split('/').pop()}</span></button>)}</div>{!logos.length && <p className="field-hint">No image files found. Use an image URL above, or add a logo inside the project directory and reopen this picker.</p>}</>}
        </div>}
      </div>}
      <div className="form-section management-section"><div className="section-heading"><h3>Manage this entry</h3></div>
        <button type="button" className="management-row" disabled={disabled} onClick={() => void onUpdate({ hidden: !project.hidden }).catch(err => setError(errorMessage(err)))}>{project.hidden ? <Eye size={18} /> : <EyeSlash size={18} />}<span><strong>{project.hidden ? 'Show on dashboard' : 'Hide from dashboard'}</strong><small>{project.hidden ? 'Return to Home and your other collections.' : 'Keep in Hidden, even after rescanning. Files and running commands stay untouched.'}</small></span>{busy ? <Spinner /> : <CaretRight size={16} />}</button>
        <button type="button" className="management-row" onClick={() => { setTab('duplicate'); setError(''); }}><Copy size={18} /><span><strong>Duplicate {project.kind}</strong><small>{project.kind === 'project' ? 'Copy the configuration, or the project files too.' : 'Create another entry from this service.'}</small></span><CaretRight size={16} /></button><button type="button" className="management-row danger-text" onClick={() => { setTab('remove'); setError(''); }}><Trash size={18} /><span><strong>Remove from shelf</strong><small>Your files will not be deleted.</small></span><CaretRight size={16} /></button></div>
      <div className="project-timestamps"><span>Added {formatDate(project.createdAt)}</span><span>Updated {formatDate(project.updatedAt)}</span></div>
    </form>}
    {tab === 'commands' && <div className="commands-panel"><div className="section-heading"><h3>How this project runs</h3></div><p className="section-description">Commands run in your project directory with your machine’s environment. Save changes before starting.</p><div className="command-block"><div className="command-label"><Play size={17} /><strong>Development</strong><span>Local server</span></div><Field label="Development command"><input className="mono" value={draft.devCommand} onChange={event => edit('devCommand', event.target.value)} placeholder="npm run dev" /></Field><button className="button" disabled={busy || active || dirty || !project.devCommand} onClick={() => void run('dev')}><Play size={13} weight="fill" />Start development</button></div><div className="command-block"><div className="command-label"><Hammer size={17} /><strong>Build</strong><span>Compile only</span></div><Field label="Build command"><input className="mono" value={draft.buildCommand} onChange={event => edit('buildCommand', event.target.value)} placeholder="npm run build" /></Field><button className="button" disabled={busy || active || dirty || !project.buildCommand} onClick={() => void run('build')}><Hammer size={14} />Run build</button></div><div className="command-block"><div className="command-label"><RocketLaunch size={17} /><strong>Production</strong><span>Build, then serve</span></div><Field label="Production command"><input className="mono" value={draft.prodCommand} onChange={event => edit('prodCommand', event.target.value)} placeholder="npm run start" /></Field><button className="button" disabled={busy || active || dirty || !project.prodCommand} onClick={() => void run('prod')}><RocketLaunch size={14} />Start production</button></div><RuntimeInfo project={project} /></div>}
    {tab === 'logs' && <LogsPanel key={project.id} project={project} />}
    {tab === 'duplicate' && <div className="subpanel"><span className="subpanel-icon"><Copy size={27} weight="duotone" /></span><h3>A fresh starting point.</h3><p>Keep the original and make a separate entry on your shelf.</p><form onSubmit={event => void duplicate(event)}><Field label="Name for the copy"><input value={duplicateName} onChange={event => setDuplicateName(event.target.value)} required maxLength={160} /></Field>{project.kind === 'project' && <><label className="checkbox-row"><input type="checkbox" checked={copyFiles} onChange={event => setCopyFiles(event.target.checked)} /><span><strong>Copy project files</strong><small>Leave unchecked to duplicate the configuration only.</small></span></label><Field label={copyFiles ? 'New directory' : 'Project directory (optional)'} hint={copyFiles ? 'A new absolute path. Existing directories are never overwritten.' : 'Leave empty to keep pointing to the original directory.'}><input className="mono" value={duplicateDirectory} onChange={event => setDuplicateDirectory(event.target.value)} required={copyFiles} placeholder={copyFiles ? `${project.directory}-copy` : project.directory} /></Field>{copyFiles && <div className="form-note">Dependencies, Git history, and generated files are excluded. Install dependencies in the new folder before running it.</div>}</>}<button type="submit" className="button button-primary" disabled={working || !duplicateName.trim()}>{working ? <Spinner /> : <Copy size={16} />}Duplicate {project.kind}</button></form></div>}
    {tab === 'remove' && <div className="subpanel remove-panel"><span className="subpanel-icon"><Trash size={28} weight="duotone" /></span><h3>Take it off the shelf?</h3><p>This removes <strong>{project.name}</strong> from Project Shelf{active ? ' and stops its managed process' : ''}. Your project files are never deleted.</p><label className="checkbox-row"><input type="checkbox" checked={removeConfirmed} onChange={event => setRemoveConfirmed(event.target.checked)} /><span>Remove this entry from my workspace.</span></label><button className="button button-danger" disabled={working || !removeConfirmed} onClick={() => void remove()}>{working ? <Spinner /> : <Trash size={16} />}Remove {project.kind}</button></div>}
    </fieldset>
  </Dialog>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function RuntimeInfo({ project }: { project: Project }) {
  return <div className="runtime-info"><span className="eyebrow">PROCESS INFORMATION</span><dl><div><dt>Status</dt><dd><Status project={project} /></dd></div>{project.runtime.mode && <div><dt>Mode</dt><dd>{project.runtime.mode === 'prod' ? 'Production' : project.runtime.mode === 'dev' ? 'Development' : 'Build'}</dd></div>}{project.runtime.pid !== null && <div><dt>Process ID</dt><dd className="mono">{project.runtime.pid}</dd></div>}{project.runtime.startedAt && <div><dt>Started</dt><dd>{new Date(project.runtime.startedAt).toLocaleString()}</dd></div>}{project.runtime.exitCode !== null && <div><dt>Exit code</dt><dd className="mono">{project.runtime.exitCode}</dd></div>}</dl></div>;
}

function LogsPanel({ project }: { project: Project }) {
  const available = useServerAvailable();
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('all');
  const [copied, setCopied] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const fetching = useRef(false);
  const refresh = useCallback(async () => {
    if (!available) { setLoading(false); return; }
    if (fetching.current) return;
    fetching.current = true;
    try { const result = await api.logs(project.id); if (mounted.current) { setLogs(result.logs); setError(''); } }
    catch (err) { if (mounted.current) setError(errorMessage(err)); }
    finally { fetching.current = false; if (mounted.current) setLoading(false); }
  }, [project.id, available]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const interval = window.setInterval(() => { if (available && !document.hidden) void refresh(); }, 1600);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [refresh]);
  useEffect(() => { if (follow && terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight; }, [logs, follow, filter]);
  const shown = filter === 'errors' ? logs.filter(line => line.stream === 'stderr') : logs;
  async function copyLogs() {
    try { await navigator.clipboard.writeText(shown.map(line => line.text).join('\n')); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setError('Clipboard is unavailable in this browser. Use Download to save the output.'); }
  }
  function download() {
    const blob = new Blob([shown.map(line => `[${line.timestamp}] [${line.stream}] ${line.text}`).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${project.name.replace(/[^a-z0-9_-]/gi, '-')}.log`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="logs-panel"><div className="logs-toolbar"><label><span className="sr-only">Filter log output</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All output</option><option value="errors">Errors only</option></select></label><div><IconButton label="Refresh logs" onClick={() => void refresh()}><ArrowClockwise size={16} /></IconButton><IconButton label={copied ? 'Logs copied' : 'Copy logs'} disabled={!shown.length} onClick={() => void copyLogs()}>{copied ? <Check size={16} /> : <Copy size={16} />}</IconButton><IconButton label="Download logs" disabled={!shown.length} onClick={download}><DownloadSimple size={16} /></IconButton></div></div>{error && <ErrorNotice message={error} />}
    <div className="terminal" ref={terminalRef} tabIndex={0} aria-label={`Log output for ${project.name}`} role="region">{loading ? <div className="terminal-empty"><Spinner size={23} /><p>Reading output…</p></div> : shown.length ? shown.map(line => <div className={`log-line log-${line.stream}`} key={line.id}><time title={line.timestamp}>{logTime(line.timestamp)}</time><span>{stripAnsi(line.text)}</span></div>) : <div className="terminal-empty"><TerminalWindow size={30} weight="duotone" /><h4>{filter === 'errors' ? 'No error output.' : 'Waiting for the first line.'}</h4><p>{filter === 'errors' ? 'Standard error output will appear here.' : 'Start development, production, or a build to see its output here.'}</p></div>}</div>
    <div className="logs-footer"><span>{shown.length} {shown.length === 1 ? 'line' : 'lines'}<span className="logs-live">{available ? <><span className="live-dot" />Polling live</> : 'Offline — live logs paused'}</span></span><button className={`text-button ${follow ? 'selected' : ''}`} onClick={() => setFollow(value => !value)} aria-pressed={follow}><ArrowDown size={13} />{follow ? 'Following output' : 'Follow output'}</button></div><RuntimeInfo project={project} />
  </div>;
}
function logTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour12: false }); }
function stripAnsi(value: string) { return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); }
