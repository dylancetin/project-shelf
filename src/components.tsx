import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, CircleNotch, WarningCircle, Check, ArrowUpRight } from '@phosphor-icons/react';
import type { Project, Settings } from '../shared/types';
import { remoteLogoUrl } from '../shared/logos';
import { projectUrl, urlLabel } from './api';
import { serviceIcon } from './service-icons';
import { useServerAvailable } from './connection';
import { apiAsset } from './platform';

export function Spinner({ size = 16 }: { size?: number }) {
  return <CircleNotch className="spinner" size={size} weight="bold" aria-hidden="true" />;
}

export function IconButton({ label, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function projectMonogram(name: string): string {
  // Scoped package names identify the project after the slash, not its scope.
  const leaf = name.trim().split(/[\\/]+/).filter(Boolean).at(-1) || name;
  const label = leaf.replace(/^\s*\[[^\]]+\]\s*/, '') || leaf;
  const words = label.match(/[\p{L}\p{N}]+/gu) || [];
  const letters = words.length > 1
    ? words.slice(0, 2).map(word => Array.from(word)[0]).join('')
    : Array.from(words[0] || 'P').slice(0, 2).join('');
  return Array.from(letters.toUpperCase()).slice(0, 2).join('');
}

export function ProjectAvatar({ project, large = false }: { project: Pick<Project, 'id' | 'name' | 'logo' | 'kind' | 'url'>; large?: boolean }) {
  const [failedUrl, setFailedUrl] = useState('');
  const color = [...project.name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 6;
  const initials = projectMonogram(project.name);
  const logo = project.logo ? remoteLogoUrl(project.logo) || apiAsset(`/projects/${encodeURIComponent(project.id)}/logo?path=${encodeURIComponent(project.logo)}`) : serviceIcon(project);
  return <span className={`project-avatar pastel-${color}${large ? ' large' : ''}`} aria-hidden="true">
    {logo && failedUrl !== logo ? <img src={logo} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(logo)} /> : initials}
  </span>;
}

export function Status({ project }: { project: Project }) {
  const status = project.runtime.status;
  const label = project.kind === 'service' ? 'Service' : status === 'unknown' ? 'Status unknown' : status === 'running' ? (project.runtime.mode === 'build' ? 'Building' : 'Running') : status === 'starting' ? 'Starting' : status === 'stopping' ? 'Stopping' : status === 'failed' ? 'Failed' : 'Stopped';
  return <span className={`status status-${project.kind === 'service' ? 'service' : status}`}><span className="status-dot" />{label}</span>;
}

export function HostnameSelect({ project, settings, disabled, onChange, compact = false }: { project: Project; settings: Settings | null; disabled?: boolean; onChange: (hostname: string) => void; compact?: boolean }) {
  const hosts = [...new Set([...(settings?.hostnames || []), project.hostname].filter(Boolean))];
  return <div className={`hostname-select ${compact ? 'compact' : ''}`}>
    <select aria-label={`Hostname for ${project.name}`} value={project.hostname} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">Original hostname</option>
      {hosts.map(host => <option key={host} value={host}>{host}</option>)}
    </select>
  </div>;
}

export type OpenProject = (project: Project, newTab: boolean) => void;

export function ProjectLink({ project, onOpen, busy = false, children, ...props }: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'onAuxClick'> & { project: Project; onOpen: OpenProject; busy?: boolean }) {
  const available = useServerAvailable();
  const url = projectUrl(project);
  if (!url) return null;
  const managed = project.kind === 'project';
  const disabled = managed && (busy || !available);
  function open(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!managed || (event.type === 'auxclick' && event.button !== 1)) return;
    event.preventDefault();
    if (!disabled) onOpen(project, props.target === '_blank' || event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey);
  }
  return <a {...props} href={url} title={managed && !available ? 'Reconnect to the server to start and open this project' : props.title} aria-busy={managed && busy || undefined} aria-disabled={disabled || undefined} onClick={open} onAuxClick={open}>{children}</a>;
}

export function OpenLink({ project, className = '', busy = false, onOpen }: { project: Project; className?: string; busy?: boolean; onOpen: OpenProject }) {
  return <ProjectLink project={project} onOpen={onOpen} busy={busy} target="_blank" rel="noreferrer" className={`button ${className}`} title={project.kind === 'project' ? `Start development and open ${urlLabel(project)}` : `Open ${urlLabel(project)}`} aria-label={`Open ${project.name}`}>
    {busy && project.kind === 'project' ? <>Starting dev… <Spinner size={15} /></> : <>Open <ArrowUpRight size={15} weight="bold" /></>}
  </ProjectLink>;
}

export function ErrorNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="error-notice" role="alert"><WarningCircle size={19} weight="fill" /><span>{message}</span>{onDismiss && <IconButton label="Dismiss error" onClick={onDismiss}><X size={16} /></IconButton>}</div>;
}

export function Dialog({ title, children, onClose, className = '', eyebrow, footer }: { title: string; children: ReactNode; onClose: () => void; className?: string; eyebrow?: string; footer?: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const initial = ref.current?.querySelector<HTMLElement>('[data-autofocus]:enabled')
      || ref.current?.querySelector<HTMLElement>('input:enabled, button:enabled, select:enabled, textarea:enabled, a[href]');
    (initial || ref.current)?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], [tabindex="0"]') || []).filter(el => el.getClientRects().length);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      if (!ref.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className={`dialog-backdrop ${className.includes('sheet') ? 'sheet-backdrop' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`dialog ${className}`}>
      <header className="dialog-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div><IconButton label="Close dialog" onClick={onClose}><X size={21} weight="bold" /></IconButton></header>
      <div className="dialog-content">{children}</div>
      {footer && <footer className="dialog-footer">{footer}</footer>}
    </div>
  </div>;
}

export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => { const timer = window.setTimeout(onDismiss, 6500); return () => window.clearTimeout(timer); }, [message, onDismiss]);
  return <div className="toast" role="status"><span className="toast-check"><Check size={16} weight="bold" /></span><span>{message}</span><IconButton label="Dismiss notification" onClick={onDismiss}><X size={16} /></IconButton></div>;
}

export function Field({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
