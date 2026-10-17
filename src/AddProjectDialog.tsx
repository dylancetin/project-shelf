import { useState, type FormEvent } from 'react';
import { FolderOpen, GlobeHemisphereWest, Plus, CaretDown, ArrowRight } from '@phosphor-icons/react';
import type { Project, ProjectKind } from '../shared/types';
import { api, errorMessage } from './api';
import { Dialog, ErrorNotice, Field, Spinner } from './components';
import { useServerAvailable } from './connection';

export function AddProjectDialog({ initialKind, onClose, onCreated }: { initialKind: ProjectKind; onClose: () => void; onCreated: (project: Project) => void }) {
  const available = useServerAvailable();
  const [kind, setKind] = useState<ProjectKind>(initialKind);
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [devCommand, setDevCommand] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [prodCommand, setProdCommand] = useState('');
  const [port, setPort] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!available) { setError('Reconnect to the server before adding an entry.'); return; }
    if (!name.trim()) { setError('Give this entry a name.'); return; }
    if (kind === 'project' && !directory.trim()) { setError('Enter the absolute path to your project directory.'); return; }
    if (kind === 'service') {
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
      catch { setError('Enter a complete HTTP or HTTPS service address.'); return; }
    }
    setSubmitting(true); setError('');
    try {
      const data: Partial<Project> = { name: name.trim(), kind, description: description.trim(), ...(url.trim() ? { url: url.trim() } : {}) };
      if (kind === 'project') {
        data.directory = directory.trim();
        if (devCommand.trim()) data.devCommand = devCommand.trim();
        if (buildCommand.trim()) data.buildCommand = buildCommand.trim();
        if (prodCommand.trim()) data.prodCommand = prodCommand.trim();
        if (port) data.port = Number(port);
      }
      const result = await api.create(data);
      onCreated(result.project);
    } catch (err) { setError(errorMessage(err)); }
    finally { setSubmitting(false); }
  }

  return <Dialog title="A new place on the shelf." eyebrow="ADD TO YOUR WORKSPACE" onClose={onClose} className="add-dialog" footer={<><span className="footer-hint">{available ? 'Nothing starts until you’re ready.' : 'Reconnect to save this entry.'}</span><button className="button" onClick={onClose} disabled={submitting}>Cancel</button><button className="button button-primary" type="submit" form="add-project-form" disabled={!available || submitting}>{submitting ? <Spinner /> : <Plus size={16} weight="bold" />}Add {kind}</button></>}>
    <form id="add-project-form" onSubmit={event => void submit(event)}>
      <div className="kind-picker" aria-label="Entry type"><button type="button" className={kind === 'project' ? 'selected' : ''} onClick={() => setKind('project')} aria-pressed={kind === 'project'}><FolderOpen size={22} weight="duotone" /><span><strong>Local project</strong><small>Run, build, and work on it.</small></span></button><button type="button" className={kind === 'service' ? 'selected' : ''} onClick={() => setKind('service')} aria-pressed={kind === 'service'}><GlobeHemisphereWest size={22} weight="duotone" /><span><strong>Service or bookmark</strong><small>A useful local destination.</small></span></button></div>
      {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
      <Field label="Name"><input data-autofocus value={name} onChange={event => setName(event.target.value)} placeholder={kind === 'project' ? 'My next project' : 'Service name'} required maxLength={160} /></Field>
      {kind === 'project' ? <Field label="Project directory" hint="An existing folder on this machine. Your files stay where they are."><div className="input-with-icon"><FolderOpen size={17} /><input value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/home/you/projects/your-project" required className="mono" /></div></Field> : <Field label="Service address" hint="Include the protocol and port, if needed."><input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:8080" required className="mono" /></Field>}
      <Field label="A short description" hint="Optional. A note to remember what this is for."><input value={description} onChange={event => setDescription(event.target.value)} placeholder={kind === 'project' ? 'What are you making?' : 'What does this service do?'} maxLength={500} /></Field>
      {kind === 'project' && <><button className="advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><span>Commands & connection</span><CaretDown className={advanced ? 'rotate' : ''} size={16} /></button>{advanced && <div className="advanced-fields"><p className="section-description">Set the commands for this project, or leave them blank to configure later. Folder scans detect scripts automatically.</p><Field label="Development command"><input className="mono" value={devCommand} onChange={event => setDevCommand(event.target.value)} placeholder="npm run dev" /></Field><div className="form-columns"><Field label="Build command"><input className="mono" value={buildCommand} onChange={event => setBuildCommand(event.target.value)} placeholder="npm run build" /></Field><Field label="Production command"><input className="mono" value={prodCommand} onChange={event => setProdCommand(event.target.value)} placeholder="npm run start" /></Field></div><div className="form-columns address-columns"><Field label="Project URL"><input className="mono" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" /></Field><Field label="Port"><input inputMode="numeric" type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} placeholder="3000" /></Field></div></div>}</>}
      <div className="form-note"><ArrowRight size={16} /><span>{kind === 'project' ? 'Register an existing project. No new files or folders are created.' : 'Services are links, not managed processes. Import more from Settings.'}</span></div>
    </form>
  </Dialog>;
}
