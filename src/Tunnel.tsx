import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowClockwise, ArrowUpRight, Cloud, CloudWarning, Copy, GlobeSimple, LockSimple, Warning } from '@phosphor-icons/react';
import { describeTunnelAccess, describeTunnelSource, tunnelAccessStale, type TunnelAccess, type TunnelState } from '../shared/tunnels';
import type { Project } from '../shared/types';
import { errorMessage } from './api';
import { copyText, copyWhenReady } from './clipboard';
import { IconButton, Spinner, Toast } from './components';

type Notice = { tone: 'success' | 'error'; message: string; url?: string; copied?: boolean };
export type TunnelPending = 'opening' | 'closing' | 'reopening' | null;

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/**
 * Effective access for a project's tunnels. Servers that predate layered access only send the
 * project's own list, so that list (or nothing, meaning anyone with the link) stands in for it.
 */
export function projectTunnelAccess(project: Pick<Project, 'kind' | 'tunnelAccess' | 'tunnelAllowedEmails'>): TunnelAccess | null {
  if (project.kind !== 'project') return null;
  if (project.tunnelAccess) return project.tunnelAccess;
  const own = project.tunnelAllowedEmails ?? [];
  return { allowedEmails: own, source: own.length ? 'own' : 'none', from: [] };
}

/** "Only you@example.com can open it" / "Anyone with the link can open it". */
function whoCanOpen(rules: readonly string[]): string {
  return rules.length ? `Only ${describeTunnelAccess(rules)} can open it` : 'Anyone with the link can open it';
}

/** Where a public effective access came from: an explicit Public says "set on …". */
export function accessSourceText(access: TunnelAccess): string {
  if (!access.allowedEmails.length && access.source === 'project') return describeTunnelSource(access).replace(/^from /, 'set on ');
  return describeTunnelSource(access);
}

/** The Manage entry where this access is decided (or can be changed), if there is one. */
export function accessProjectId(access: TunnelAccess | null | undefined, ownerId?: string | null): string | null {
  return access?.from[0]?.id ?? ownerId ?? null;
}

/** Old and new access for a tunnel opened with different rules, in words. */
export function staleWords(tunnel: Pick<TunnelState, 'allowedEmails'>, access: TunnelAccess) {
  return { was: describeTunnelAccess(tunnel.allowedEmails), now: describeTunnelAccess(access.allowedEmails), wasPublic: !tunnel.allowedEmails?.length, nowPublic: !access.allowedEmails.length };
}

/**
 * Open, close, reopen, and copy for one tunnel. A row owns exactly one of these so its
 * buttons, its stale notice, and its toast share one busy state.
 */
export function useTunnelActions({ name, tunnel, access, onOpen, onClose }: {
  name: string;
  tunnel: TunnelState | null | undefined;
  access: TunnelAccess | null | undefined;
  onOpen: () => Promise<TunnelState>;
  onClose: () => Promise<void>;
}) {
  const [pending, setPending] = useState<TunnelPending>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const dismiss = useCallback(() => setNotice(null), []);
  const busy = useRef(false);

  /** Starts copying inside the click so the browser still allows it when the link arrives. */
  async function share(kind: 'opening' | 'reopening', link: Promise<TunnelState>): Promise<boolean> {
    let rules: string[] = access?.allowedEmails ?? [];
    const url = link.then(state => {
      if (!state.url) throw new Error('Cloudflare did not return a tunnel address.');
      rules = state.allowedEmails ?? [];
      return state.url;
    });
    const copied = copyWhenReady(url);
    try {
      const value = await url;
      const ok = await copied;
      const lead = kind === 'reopening' ? (ok ? 'Access updated; link copied.' : 'Access updated.') : ok ? 'Tunnel link copied.' : 'Tunnel ready.';
      setNotice({ tone: 'success', message: `${lead} ${whoCanOpen(rules)}:`, url: value, copied: ok });
      return true;
    } catch (error) {
      setNotice({ tone: 'error', message: `Could not ${kind === 'reopening' ? 'update access for the Cloudflare tunnel of' : 'open a Cloudflare tunnel for'} ${name}: ${errorMessage(error)}` });
      return false;
    }
  }
  async function run<T>(kind: Exclude<TunnelPending, null>, work: () => Promise<T>): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true; setPending(kind); setNotice(null);
    try { return await work(); }
    finally { busy.current = false; setPending(null); }
  }

  const open = () => run('opening', () => share('opening', onOpen()));
  // Opening an open tunnel applies its current access in place; the link stays the same.
  const reopen = () => run('reopening', () => share('reopening', onOpen()));
  const close = () => run('closing', async () => {
    try { await onClose(); return true; }
    catch (error) { setNotice({ tone: 'error', message: `Could not close the Cloudflare tunnel for ${name}: ${errorMessage(error)}` }); return false; }
  });
  async function copy(value: string) {
    setNotice(await copyText(value)
      ? { tone: 'success', message: `Tunnel link copied. ${whoCanOpen(tunnel?.allowedEmails ?? [])}:`, url: value, copied: true }
      : { tone: 'error', message: 'The browser blocked copying. Select the link to copy it:', url: value, copied: true });
  }

  // Stable content: polling re-renders must not restart the notice's dismiss timer.
  const toast = useMemo(() => notice && createPortal(<Toast tone={notice.tone} onDismiss={dismiss}
    message={<>{notice.message}{notice.url && <> <a className="tunnel-notice-link" href={notice.url} target="_blank" rel="noreferrer">{host(notice.url)}</a></>}</>}
    action={notice.url && !notice.copied ? <button type="button" className="button tunnel-copy-action" onClick={() => void copy(notice.url!)}><Copy size={14} />Copy link</button> : undefined} />, document.body),
  [notice, dismiss]);

  return { pending, open, close, reopen, copy, toast };
}

export type TunnelActions = ReturnType<typeof useTunnelActions>;

/**
 * The tunnel switch and copy button, driven by a row's `useTunnelActions`. Opening shows a busy
 * state until the public link works, then copies it.
 */
export function TunnelButtons({ name, tunnel, access, disabledReason, actions, className = '' }: {
  name: string;
  tunnel: TunnelState | null | undefined;
  access: TunnelAccess | null | undefined;
  /** Why a closed tunnel cannot be opened right now; an open tunnel can always be closed. */
  disabledReason: string | null;
  actions: TunnelActions;
  className?: string;
}) {
  const { pending } = actions;
  const working = pending !== null || tunnel?.status === 'starting';
  const url = tunnel?.status === 'running' ? tunnel.url : null;
  const stale = tunnelAccessStale(tunnel, access);
  const openFor = tunnel?.allowedEmails?.length ? `Cloudflare Access one-time PIN: ${describeTunnelAccess(tunnel.allowedEmails)}` : 'anyone with the link';
  const problem = tunnel?.error ? `\nCloudflare: ${tunnel.error}` : '';
  const title = pending === 'closing' ? `Closing the Cloudflare tunnel for ${name}…`
    : pending === 'reopening' ? `Updating access for the Cloudflare tunnel of ${name}…`
    : working ? `Opening a Cloudflare tunnel for ${name}…`
    : tunnel && stale && access ? `Cloudflare tunnel ${url ? `on ${url}` : `for ${name}`} still allows ${describeTunnelAccess(tunnel.allowedEmails)}; access is now ${describeTunnelAccess(access.allowedEmails)}. Apply access to update it.${problem}`
    : url ? `Cloudflare tunnel on: ${url} (${openFor}). It stays open until you close it — click to close it${problem}`
    : tunnel ? `Cloudflare tunnel for ${name} is open — click to close it`
    : disabledReason ?? (access
      ? `Share ${name} through a Cloudflare tunnel for ${describeTunnelAccess(access.allowedEmails)} (${accessSourceText(access)}); the link is copied when it is ready`
      : `Share ${name} through a Cloudflare tunnel; the link is copied when it is ready`);
  const warn = stale || Boolean(tunnel?.error);
  return <>
    <IconButton className={`tunnel-toggle ${className}${tunnel && !working ? ' is-running' : ''}${warn && !working ? ' is-stale' : ''}${working ? ' is-working' : ''}`} label={`Cloudflare tunnel for ${name}${stale ? ', access update needed' : tunnel?.error ? ', needs attention' : ''}`} title={title}
      aria-pressed={Boolean(tunnel)} aria-busy={working || undefined} disabled={working || (!tunnel && Boolean(disabledReason))} onClick={() => void (tunnel ? actions.close() : actions.open())}>
      {working ? <Spinner size={14} /> : warn ? <CloudWarning size={16} weight="fill" aria-hidden="true" /> : <Cloud size={16} weight={tunnel ? 'fill' : 'regular'} aria-hidden="true" />}
    </IconButton>
    {url && !working && <IconButton className="tunnel-copy" label={`Copy tunnel link for ${name}`} title={`Copy ${url}`} onClick={() => void actions.copy(url)}><Copy size={15} aria-hidden="true" /></IconButton>}
  </>;
}

/** Self-contained tunnel switch for rows that never offer Apply access (Home launcher). */
export function TunnelControls({ name, tunnel, access = null, disabledReason, onOpen, onClose, className }: {
  name: string;
  tunnel: TunnelState | null | undefined;
  access?: TunnelAccess | null;
  disabledReason: string | null;
  onOpen: () => Promise<TunnelState>;
  onClose: () => Promise<void>;
  className?: string;
}) {
  const actions = useTunnelActions({ name, tunnel, access, onOpen, onClose });
  return <><TunnelButtons name={name} tunnel={tunnel} access={access} disabledReason={disabledReason} actions={actions} className={className} />{actions.toast}</>;
}

/**
 * One line saying who a tunnel opened now (or the open one) lets in, and where that comes from:
 * "🔒 you@example.com and 1 more · from Dernek Web". Words carry the meaning, not colour.
 */
export function TunnelAccessLine({ access, tunnel, ownerId, newTab = false, linkable = true, className = '' }: {
  access: TunnelAccess;
  tunnel?: TunnelState | null;
  /** Fallback Manage entry when no folder layer decided the access. */
  ownerId?: string | null;
  /** In the framed controls, Manage opens in a new tab. */
  newTab?: boolean;
  linkable?: boolean;
  className?: string;
}) {
  const rules = access.allowedEmails;
  const who = rules.length ? describeTunnelAccess(rules) : 'Anyone with the link';
  const source = accessSourceText(access);
  const id = linkable ? accessProjectId(access, ownerId) : null;
  const caution = Boolean(tunnel) && !rules.length;
  const Icon = rules.length ? LockSimple : GlobeSimple;
  const full = rules.length ? `Allowed through Cloudflare Access (one-time PIN):\n${rules.join('\n')}\n${source}` : `Anyone with the link · ${source}`;
  const href = id ? `/#manage/project/${encodeURIComponent(id)}` : null;
  return <span className={`tunnel-access-line${caution ? ' is-caution' : ''} ${className}`} title={full}>
    <Icon size={12} weight={rules.length ? 'bold' : 'regular'} aria-hidden="true" />
    <span><span className="sr-only">Tunnel access: </span>{who} · {href
      ? <a href={newTab ? href : href.slice(1)} target={newTab ? '_blank' : undefined} rel={newTab ? 'noreferrer' : undefined}>{source}{newTab && <ArrowUpRight size={10} weight="bold" aria-hidden="true" />}</a>
      : source}</span>
  </span>;
}

/**
 * Caution box shown while an open tunnel's access in Cloudflare differs from its current access
 * (the automatic update failed). The live region stays mounted so focus can rest on it after
 * Apply removes the button, and it confirms the update.
 */
export function TunnelStaleNotice({ stale, open, message, name, actions, access, buttonLabel = 'Apply access', boxClassName = 'connection-notice tunnel-stale-notice', className = '' }: {
  stale: boolean;
  /** Whether a tunnel is open; the reopen confirmation goes away once it is closed. */
  open: boolean;
  message: ReactNode;
  name: string;
  actions: TunnelActions;
  access: TunnelAccess | null | undefined;
  buttonLabel?: string;
  boxClassName?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  const reopening = actions.pending === 'reopening';
  async function reopen() {
    setDone(false);
    const ok = await actions.reopen();
    if (ok) setDone(true);
    ref.current?.focus({ preventScroll: true });
  }
  return <div ref={ref} className={`tunnel-stale-region ${className}`} role="status" tabIndex={-1}>
    {stale || reopening ? <div className={boxClassName}>
      <Warning size={15} weight="bold" aria-hidden="true" />
      <span className="tunnel-stale-text">{message}</span>
      <button type="button" className="button tunnel-reopen" disabled={actions.pending !== null} aria-busy={reopening || undefined}
        title={`Update Cloudflare Access for the ${name} tunnel. The link stays the same.`} onClick={() => void reopen()}>
        {reopening ? <Spinner size={14} /> : <ArrowClockwise size={14} aria-hidden="true" />}{reopening ? 'Applying…' : buttonLabel}
      </button>
    </div> : done && open && access ? <p className="tunnel-reopened">Access updated. {whoCanOpen(access.allowedEmails)}.</p> : null}
  </div>;
}
