import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwise, DiscordLogo, GithubLogo, GitlabLogo, GoogleLogo, RedditLogo, Trash, YoutubeLogo, type Icon } from '@phosphor-icons/react';
import { bookmarkUrl, searchBookmarks, type BookmarkNode, type BrowserFavicons } from '../shared/browser-bookmarks';
import { errorMessage } from './api';
import { Spinner } from './components';
import { serviceIcon } from './service-icons';
import './bookmark-icons.css';

interface IconContext {
  provider?: BrowserFavicons;
  revision: number;
  allowed: boolean;
  busy: 'refresh' | 'clear' | null;
  status: string;
  error: string;
  refresh(): Promise<void>;
  clear(): Promise<void>;
}
const Icons = createContext<IconContext | null>(null);

export function BookmarkIconProvider({ provider, tree, children }: { provider?: BrowserFavicons; tree: BookmarkNode[]; children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'clear' | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const working = useRef(false);
  useEffect(() => {
    let active = true;
    setAllowed(false); setError(''); setStatus('');
    const check = () => void provider?.hasAccess().then(value => { if (active) setAllowed(value); }).catch(() => { if (active) setAllowed(false); });
    check();
    window.addEventListener('focus', check);
    return () => { active = false; window.removeEventListener('focus', check); };
  }, [provider]);
  async function refresh() {
    if (!provider || working.current) return;
    working.current = true;
    setBusy('refresh'); setError(''); setStatus('');
    try {
      // Call before any await, including hasAccess(): Chrome requires the
      // optional host request to stay inside the original button gesture.
      if (!await provider.requestAccess()) throw new Error('Online icon access was not granted. Saved icons and offline logos still work.');
      setAllowed(true);
      let total = 0;
      const updated = await provider.refresh(searchBookmarks(tree, '').map(node => node.url ?? ''), (done, count) => {
        total = count;
        setStatus(`Updating public site icons ${done}/${count}…`);
      });
      setStatus(!total
        ? 'No public website icons to update. Local and private bookmarks use Chrome’s local icons, bundled logos or initials.'
        : `${updated}/${total} public site icons updated locally.${updated < total ? ' Unavailable icons kept their saved version or offline fallback.' : ''}`);
    } catch (error) { setError(errorMessage(error)); setStatus(''); }
    finally {
      // Even a persistence error may have downloaded usable in-memory icons.
      setRevision(value => value + 1);
      working.current = false; setBusy(null);
    }
  }
  async function clear() {
    if (!provider?.clear || working.current) return;
    working.current = true;
    setBusy('clear'); setError(''); setStatus('');
    try {
      await provider.clear();
      setStatus('Saved icon cache cleared. Chrome’s local icons, bundled logos and initials still work. Online icons are only downloaded when you refresh.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setRevision(value => value + 1); working.current = false; setBusy(null); }
  }
  return <Icons.Provider value={{ provider, revision, allowed, busy, status, error, refresh, clear }}>{children}</Icons.Provider>;
}

export function BookmarkIconTools() {
  const icons = useContext(Icons);
  const privacyId = useId();
  if (!icons?.provider) return null;
  return <div className="bookmark-icon-tools">
    <div className="bookmark-icon-actions">
      <button className="text-button" disabled={Boolean(icons.busy)} aria-describedby={privacyId} onClick={() => void icons.refresh()}>
        {icons.busy === 'refresh' ? <Spinner size={13} /> : <ArrowClockwise size={13} />}
        {icons.allowed ? 'Refresh online icons' : 'Enable online icons'}
      </button>
      {icons.provider.clear && <button className="text-button" disabled={Boolean(icons.busy)} onClick={() => void icons.clear()}>
        {icons.busy === 'clear' ? <Spinner size={13} /> : <Trash size={13} />}Clear saved icons
      </button>}
    </div>
    <p id={privacyId} className="bookmark-icon-privacy">Enable or refresh sends public website hostnames to DuckDuckGo. Never paths, queries, or local/private addresses. Icons stay saved in this browser; opening a new tab makes no icon-provider requests. Chrome’s local favicon cache is also used when allowed.</p>
    {icons.status && <p className="bookmark-icon-feedback" role="status">{icons.status}</p>}
    {icons.error && <p className="bookmark-icon-feedback bookmark-icon-error" role="alert">{icons.error}</p>}
  </div>;
}

const brands: { host: string; icon: Icon; color: string }[] = [
  { host: 'github.com', icon: GithubLogo, color: '#292d32' },
  { host: 'gitlab.com', icon: GitlabLogo, color: '#b54a30' },
  { host: 'google.com', icon: GoogleLogo, color: '#3971b6' },
  { host: 'youtube.com', icon: YoutubeLogo, color: '#bd3737' },
  { host: 'youtu.be', icon: YoutubeLogo, color: '#bd3737' },
  { host: 'reddit.com', icon: RedditLogo, color: '#b64a2d' },
  { host: 'discord.com', icon: DiscordLogo, color: '#5865b5' },
];

function siteKey(node: BookmarkNode): string {
  try { return new URL(node.url ?? '').hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return node.title.trim() || 'Bookmark'; }
}

export function bookmarkMonogram(node: BookmarkNode): string {
  const site = siteKey(node).split('.')[0]!.replace(/^\[|\]$/g, '');
  const letters = (site || node.title || 'B').replace(/[^\p{L}\p{N}]/gu, '');
  return [...letters.toUpperCase()].slice(0, 2).join('') || 'B';
}

export function bookmarkIconTone(node: BookmarkNode): number {
  let hash = 0;
  for (const character of siteKey(node)) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  return (hash >>> 0) % 6;
}

export function BookmarkIcon({ node }: { node: BookmarkNode }) {
  const context = useContext(Icons);
  const provider = context?.provider;
  const revision = context?.revision ?? 0;
  const url = bookmarkUrl(node);
  const [saved, setSaved] = useState<{ page: string; icon: string | null }>({ page: '', icon: null });
  const [failedService, setFailedService] = useState('');
  const local = serviceIcon({ kind: 'service', name: node.title, url: node.url ?? '' });
  const host = siteKey(node);
  const brand = brands.find(brand => host === brand.host || host.endsWith(`.${brand.host}`));
  const Brand = brand?.icon;
  useEffect(() => {
    let active = true;
    setSaved({ page: url, icon: null });
    // Permission gates acquisition, not already-saved local blobs.
    if (url && provider) void provider.read(url).then(icon => {
      if (active) setSaved({ page: url, icon: icon?.startsWith('blob:') ? icon : null });
    }).catch(() => { /* A useful offline fallback is already visible. */ });
    return () => { active = false; };
  }, [provider, url, revision]);
  const icon = saved.page === url ? saved.icon : null;
  const localAvailable = local && failedService !== local;
  return <span className={`bookmark-favicon${!icon && !localAvailable && !Brand ? ` bookmark-monogram bookmark-monogram-${bookmarkIconTone(node)}` : ''}`} aria-hidden="true">
    {icon ? <img src={icon} alt="" onError={() => setSaved({ page: url, icon: null })} />
      : localAvailable ? <img src={local} alt="" onError={() => setFailedService(local)} />
        : Brand ? <Brand size={16} weight="fill" color={brand.color} />
          : bookmarkMonogram(node)}
  </span>;
}
