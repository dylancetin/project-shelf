import { useEffect, useRef, useState } from 'react';
import { FolderOpen, GlobeHemisphereWest, UploadSimple, Plus, X, ArrowClockwise, Check, FileHtml, ArrowRight, DownloadSimple, MagnifyingGlass } from '@phosphor-icons/react';
import type { Settings } from '../shared/types';
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, type SearchEngine } from '../shared/search';
import { api, errorMessage } from './api';
import { Dialog, ErrorNotice, Field, IconButton, Spinner } from './components';
import { PwaPanel } from './Pwa';
import { useServerAvailable } from './connection';
import { apiAsset } from './platform';

type Section = 'discovery' | 'search' | 'network' | 'bookmarks' | 'offline';

export function SettingsDialog({ settings, onClose, onSaved, onChanged, notify }: { settings: Settings | null; onClose: () => void; onSaved: (settings: Settings) => void; onChanged: () => Promise<void>; notify: (message: string) => void }) {
  const available = useServerAvailable();
  const [section, setSection] = useState<Section>('discovery');
  const [roots, setRoots] = useState<string[]>(settings?.roots || []);
  const [hosts, setHosts] = useState<string[]>(settings?.hostnames || []);
  const [defaultHostname, setDefaultHostname] = useState(settings?.defaultHostname || '');
  const [defaultSearchEngine, setDefaultSearchEngine] = useState<SearchEngine>(settings?.defaultSearchEngine ?? DEFAULT_SEARCH_ENGINE);
  const browserSearchUrl = `${new URL('/search', new URL(apiAsset('/health'), window.location.href)).href}?q=%s`;
  const [newRoot, setNewRoot] = useState('');
  const [newHost, setNewHost] = useState('');
  const [lastScan, setLastScan] = useState(settings?.lastScanAt || null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(!settings);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [localOnly, setLocalOnly] = useState(true);
  const [importResult, setImportResult] = useState<{ added: number; skipped: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const working = saving || scanning || importing || loading || !available;

  useEffect(() => {
    if (settings) return;
    let cancelled = false;
    api.settings().then(({ settings: result }) => {
      if (cancelled) return;
      setRoots(result.roots); setHosts(result.hostnames); setDefaultHostname(result.defaultHostname); setDefaultSearchEngine(result.defaultSearchEngine ?? DEFAULT_SEARCH_ENGINE); setLastScan(result.lastScanAt); onSaved(result);
    }).catch(err => { if (!cancelled) setError(errorMessage(err)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save(): Promise<boolean> {
    if (!available) return false;
    setSaving(true); setError(''); setSaved(false);
    try {
      const cleanRoots = [...new Set([...roots, ...(newRoot.trim() ? [newRoot] : [])].map(value => value.trim()).filter(Boolean))];
      const cleanHosts = [...new Set([...hosts, ...(newHost.trim() ? [newHost] : [])].map(value => value.trim()).filter(Boolean))];
      if (cleanRoots.some(root => !root.startsWith('/'))) throw new Error('Use absolute directory paths, starting with /.');
      if (cleanHosts.some(host => !/^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9._-]+)$/.test(host))) throw new Error('Enter hostnames or IP addresses only, without a protocol, port, or path.');
      const result = await api.saveSettings({ roots: cleanRoots, hostnames: cleanHosts, defaultHostname: cleanHosts.includes(defaultHostname) ? defaultHostname : '', defaultSearchEngine });
      setRoots(result.settings.roots); setHosts(result.settings.hostnames); setDefaultHostname(result.settings.defaultHostname); setNewRoot(''); setNewHost('');
      setDefaultSearchEngine(result.settings.defaultSearchEngine);
      onSaved(result.settings); setSaved(true);
      return true;
    } catch (err) { setError(errorMessage(err)); return false; }
    finally { setSaving(false); }
  }

  async function scan() {
    setScanning(true); setError('');
    try {
      if (!await save()) return;
      const result = await api.scan();
      await onChanged();
      const data = await api.settings(); setLastScan(data.settings.lastScanAt); onSaved(data.settings);
      notify(`Scan complete. ${result.added} ${result.added === 1 ? 'project' : 'projects'} added, ${result.existing} already registered.`);
      if (result.errors.length) setError(`Some directories could not be scanned: ${result.errors.join(' · ')}`);
    } catch (err) { setError(errorMessage(err)); }
    finally { setScanning(false); }
  }

  async function importBookmarks() {
    if (!file) return;
    setImporting(true); setError(''); setImportResult(null);
    try {
      const result = await api.importBookmarks(await file.text(), localOnly);
      setImportResult(result); await onChanged();
      notify(`${result.added} ${result.added === 1 ? 'service' : 'services'} added from your bookmarks.`);
    } catch (err) { setError(errorMessage(err)); }
    finally { setImporting(false); }
  }
  function addRoot() { if (newRoot.trim()) { setRoots(current => [...new Set([...current, newRoot.trim()])]); setNewRoot(''); setSaved(false); } }
  function addHost() { if (newHost.trim()) { setHosts(current => [...new Set([...current, newHost.trim()])]); setNewHost(''); setSaved(false); } }

  return <Dialog title="A workspace that fits." eyebrow="SETTINGS" className="settings-dialog" onClose={onClose} footer={<><span className="footer-hint">{section === 'offline' ? 'Saved in this browser.' : saved ? <span className="saved-label"><Check size={15} />Settings saved</span> : 'Stored locally, on this machine.'}</span><button className="button" onClick={onClose}>Done</button>{section !== 'offline' && <button className="button button-primary" onClick={() => void save()} disabled={working}>{saving ? <Spinner /> : <Check size={16} weight="bold" />}Save settings</button>}</>}>
    <div className="settings-tabs">{([{ id: 'discovery', label: 'Project folders', icon: FolderOpen }, { id: 'search', label: 'Search', icon: MagnifyingGlass }, { id: 'network', label: 'Hostnames', icon: GlobeHemisphereWest }, { id: 'bookmarks', label: 'Bookmarks', icon: UploadSimple }, { id: 'offline', label: 'Offline app', icon: DownloadSimple }] as const).map(item => <button key={item.id} className={section === item.id ? 'selected' : ''} onClick={event => { setSection(item.id); setError(''); event.currentTarget.closest('.dialog-content')?.scrollTo({ top: 0 }); }} aria-pressed={section === item.id}><item.icon size={17} />{item.label}</button>)}</div>
    {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
    {section === 'offline' ? <PwaPanel /> : loading ? <div className="settings-loading"><Spinner size={24} /><p>Opening your workspace settings…</p></div> : <>
      {section === 'search' && <section className="settings-section">
        <div className="section-heading"><h3>Choose your search engine</h3></div>
        <p className="section-description">Use your preferred engine when searching from the browser address bar. DuckDuckGo is the default.</p>
        <Field label="Default search engine" hint="Used for plain browser searches and unknown bangs, including on Home. Known bangs keep their own destination.">
          <select aria-label="Default search engine" value={defaultSearchEngine} disabled={working} onChange={event => { setDefaultSearchEngine(event.target.value as SearchEngine); setSaved(false); }}>
            {Object.entries(SEARCH_ENGINES).map(([value, [, name]]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </Field>
        <div className="form-section">
          <Field label="Browser search URL" hint="Add this URL in your browser’s search engine settings, then make it default. No extension is required; Shelf must be reachable.">
            <input className="mono" aria-label="Browser search URL" readOnly value={browserSearchUrl} onFocus={event => event.target.select()} />
          </Field>
          <div className="form-note"><MagnifyingGlass size={17} aria-hidden="true" /><span>Use <code>!g</code> for Google, <code>!ddg</code> for DuckDuckGo, or <code>!gh</code> for GitHub. Home search without a bang still finds your local destinations.</span></div>
        </div>
      </section>}
      {section === 'discovery' && <section className="settings-section"><div className="section-heading"><h3>Where your projects live</h3><span>{roots.length} {roots.length === 1 ? 'folder' : 'folders'}</span></div><p className="section-description">Scan these root directories to find local projects. Existing entries and your edits are kept as they are.</p><div className="editable-list">{roots.map((root, index) => <div className="editable-row" key={index}><FolderOpen size={18} /><input className="mono" value={root} aria-label={`Root directory ${index + 1}`} onChange={event => { setRoots(current => current.map((item, i) => i === index ? event.target.value : item)); setSaved(false); }} /><IconButton label={`Remove root ${root}`} onClick={() => { setRoots(current => current.filter((_, i) => i !== index)); setSaved(false); }}><X size={16} /></IconButton></div>)}</div><div className="add-setting-row"><input className="mono" aria-label="New root directory" value={newRoot} onChange={event => setNewRoot(event.target.value)} placeholder="/home/you/projects" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addRoot(); } }} /><button className="button" disabled={!newRoot.trim()} onClick={addRoot}><Plus size={16} />Add folder</button></div><div className="scan-settings"><div><strong>A little housekeeping.</strong><p>{lastScan ? `Last scanned ${new Date(lastScan).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : 'No folders have been scanned yet.'}</p></div><button className="button" onClick={() => void scan()} disabled={working}>{scanning ? <Spinner /> : <ArrowClockwise size={16} />}Scan now</button></div><p className="field-hint">Scan now saves your folder list first. It registers projects; it never starts them.</p></section>}
      {section === 'network' && <section className="settings-section"><div className="section-heading"><h3>One project. A few ways in.</h3></div><p className="section-description">Keep the hostnames you use nearby. Switch each project’s address from its card without changing its port or path.</p><div className="original-host-row"><GlobeHemisphereWest size={18} /><span><strong>Original hostname</strong><small>Always available. Uses the address saved on the entry.</small></span><span className="subtle-tag">DEFAULT OPTION</span></div><div className="editable-list">{hosts.map((host, index) => <div className="editable-row" key={index}><GlobeHemisphereWest size={18} /><input className="mono" value={host} aria-label={`Hostname ${index + 1}`} onChange={event => { const value = event.target.value; setHosts(current => current.map((item, i) => i === index ? value : item)); if (defaultHostname === host) setDefaultHostname(value); setSaved(false); }} /><IconButton label={`Remove hostname ${host}`} onClick={() => { setHosts(current => current.filter((_, i) => i !== index)); if (defaultHostname === host) setDefaultHostname(''); setSaved(false); }}><X size={16} /></IconButton></div>)}</div><div className="add-setting-row"><input className="mono" aria-label="New hostname" value={newHost} onChange={event => setNewHost(event.target.value)} placeholder="machine.local" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addHost(); } }} /><button className="button" disabled={!newHost.trim()} onClick={addHost}><Plus size={16} />Add hostname</button></div><div className="form-section"><Field label="Default for new entries" hint="Existing projects keep their current hostname preference."><select value={defaultHostname} onChange={event => { setDefaultHostname(event.target.value); setSaved(false); }}><option value="">Original hostname</option>{[...new Set(hosts.filter(Boolean))].map(host => <option key={host} value={host}>{host}</option>)}</select></Field></div><div className="form-note"><ArrowRight size={16} />Hostnames need to resolve on your network. Project Shelf changes links, not DNS or server bindings.</div></section>}
      {section === 'bookmarks' && <section className="settings-section"><div className="section-heading"><h3>Your local tools, collected.</h3></div><p className="section-description">Import a browser bookmarks HTML export. Local addresses become service cards, with duplicates skipped automatically.</p><input ref={fileRef} className="sr-only" type="file" accept=".html,.htm,text/html" aria-label="Bookmarks HTML file" disabled={importing} onChange={event => { setFile(event.target.files?.[0] || null); setImportResult(null); setError(''); }} /><button className={`file-dropzone ${file ? 'has-file' : ''}`} onClick={() => fileRef.current?.click()} disabled={importing}>{file ? <FileHtml size={32} weight="duotone" /> : <UploadSimple size={31} weight="duotone" />}<strong>{file ? file.name : 'Choose a bookmarks file'}</strong><span>{file ? `${(file.size / 1024).toFixed(1)} KB · Click to choose a different file` : 'HTML exports from Chrome, Firefox, Safari, and other browsers'}</span><span className="button">Browse files</span></button><label className="checkbox-row"><input type="checkbox" checked={localOnly} onChange={event => setLocalOnly(event.target.checked)} disabled={importing} /><span><strong>Local addresses only</strong><small>Keep localhost, private network addresses, and local hostnames. Skip public websites.</small></span></label><button className="button button-primary" onClick={() => void importBookmarks()} disabled={!file || working}>{importing ? <Spinner /> : <UploadSimple size={16} />}Import bookmarks</button>{importResult && <div className="import-result" role="status"><Check size={19} weight="bold" /><div><strong>{importResult.added} {importResult.added === 1 ? 'service' : 'services'} added to your shelf.</strong><p>{importResult.skipped} {importResult.skipped === 1 ? 'bookmark' : 'bookmarks'} skipped. Existing entries are unchanged.</p></div></div>}</section>}
    </>}
  </Dialog>;
}
