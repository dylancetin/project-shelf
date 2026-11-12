import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, Copy } from '@phosphor-icons/react';
import type { TunnelState } from '../shared/tunnels';
import { errorMessage } from './api';
import { copyText, copyWhenReady } from './clipboard';
import { IconButton, Spinner, Toast } from './components';

type Notice = { tone: 'success' | 'error'; message: string; url?: string; copied?: boolean };

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/**
 * Cloudflare quick-tunnel switch. Opening shows a busy state until the public
 * link works, then copies it; a copy button stays available while it is on.
 */
export function TunnelControls({ name, tunnel, disabledReason, onOpen, onClose, className = '' }: {
  name: string;
  tunnel: TunnelState | null | undefined;
  /** Why a closed tunnel cannot be opened right now; an open tunnel can always be closed. */
  disabledReason: string | null;
  onOpen: () => Promise<TunnelState>;
  onClose: () => Promise<void>;
  className?: string;
}) {
  const [pending, setPending] = useState<'opening' | 'closing' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const dismiss = useCallback(() => setNotice(null), []);
  const working = pending !== null || tunnel?.status === 'starting';
  const url = tunnel?.status === 'running' ? tunnel.url : null;

  async function open() {
    setPending('opening'); setNotice(null);
    const link = onOpen().then(state => {
      if (!state.url) throw new Error('Cloudflare did not return a tunnel address.');
      return state.url;
    });
    // Begin copying inside the click so the browser still allows it once the link arrives.
    const copied = copyWhenReady(link);
    try {
      const value = await link;
      setNotice({ tone: 'success', message: (await copied) ? 'Tunnel link copied' : 'Tunnel ready', url: value, copied: await copied });
    } catch (error) {
      setNotice({ tone: 'error', message: `Could not open a Cloudflare tunnel for ${name}: ${errorMessage(error)}` });
    } finally { setPending(null); }
  }
  async function close() {
    setPending('closing'); setNotice(null);
    try { await onClose(); }
    catch (error) { setNotice({ tone: 'error', message: `Could not close the Cloudflare tunnel for ${name}: ${errorMessage(error)}` }); }
    finally { setPending(null); }
  }
  async function copy(value: string) {
    setNotice(await copyText(value)
      ? { tone: 'success', message: 'Tunnel link copied', url: value, copied: true }
      : { tone: 'error', message: 'The browser blocked copying. Select the link to copy it:', url: value, copied: true });
  }

  // Stable content: polling re-renders must not restart the notice's dismiss timer.
  const toast = useMemo(() => notice && <Toast tone={notice.tone} onDismiss={dismiss}
    message={<>{notice.message}{notice.url && <> <a className="tunnel-notice-link" href={notice.url} target="_blank" rel="noreferrer">{host(notice.url)}</a></>}</>}
    action={notice.url && !notice.copied ? <button type="button" className="button tunnel-copy-action" onClick={() => void copy(notice.url!)}><Copy size={14} />Copy link</button> : undefined} />,
  [notice, dismiss]);

  const title = pending === 'closing' ? `Closing the Cloudflare tunnel for ${name}…`
    : working ? `Opening a Cloudflare tunnel for ${name}…`
    : url ? `Cloudflare tunnel on: ${url} — click to close it`
    : tunnel ? `Cloudflare tunnel for ${name} is open — click to close it`
    : disabledReason ?? `Share ${name} through a Cloudflare tunnel; the link is copied when it is ready`;
  return <>
    <IconButton className={`tunnel-toggle ${className}${tunnel && !working ? ' is-running' : ''}${working ? ' is-working' : ''}`} label={`Cloudflare tunnel for ${name}`} title={title}
      aria-pressed={Boolean(tunnel)} aria-busy={working || undefined} disabled={working || (!tunnel && Boolean(disabledReason))} onClick={() => void (tunnel ? close() : open())}>
      {working ? <Spinner size={14} /> : <Cloud size={16} weight={tunnel ? 'fill' : 'regular'} aria-hidden="true" />}
    </IconButton>
    {url && !working && <IconButton className="tunnel-copy" label={`Copy tunnel link for ${name}`} title={`Copy ${url}`} onClick={() => void copy(url)}><Copy size={15} aria-hidden="true" /></IconButton>}
    {toast && createPortal(toast, document.body)}
  </>;
}
