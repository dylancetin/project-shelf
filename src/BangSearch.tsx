import { useEffect, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import catalogUrl from './data/bangs.json?url';
import { parseBang, resolveBang, type Bang, type BangCatalog, type BangQuery, type BangResult } from '../shared/bangs';
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from '../shared/search';

let cachedCatalog: Promise<BangCatalog> | null = null;
function loadCatalog(): Promise<BangCatalog> {
  if (!cachedCatalog) {
    // A separate fingerprinted, precached asset: no catalog download or JSON
    // parsing on the normal Home startup path, and no redirect/API service.
    cachedCatalog = fetch(catalogUrl).then(async response => {
      if (!response.ok) throw new Error('Search shortcuts could not load.');
      const entries = await response.json() as Bang[];
      return new Map(entries.map(entry => [entry[0], entry]));
    }).catch(error => { cachedCatalog = null; throw error; });
  }
  return cachedCatalog;
}

export function useBangSearch(query: string, defaultSearchEngine: SearchEngine = DEFAULT_SEARCH_ENGINE) {
  const bang = parseBang(query);
  const [catalog, setCatalog] = useState<BangCatalog | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const enabled = bang !== null;
  useEffect(() => {
    if (!enabled || catalog) return;
    let active = true;
    setError(false);
    void loadCatalog().then(result => { if (active) setCatalog(result); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [enabled, catalog, attempt]);
  return { bang, result: bang && catalog ? resolveBang(bang, catalog, defaultSearchEngine) : null, loading: enabled && !catalog && !error, error, retry: () => setAttempt(value => value + 1) };
}

export function BangSearch({ bang, result, loading, error, onRetry, onSelect }: { bang: BangQuery; result: BangResult | null; loading: boolean; error: boolean; onRetry: () => void; onSelect: (query: string) => void }) {
  return <section className="launcher-bang" aria-label="Bang search">
    {error ? <div role="status"><p>Search shortcuts could not load. Reconnect once to save them for offline use.</p><button className="text-button" onClick={onRetry}>Try again</button></div>
      : loading ? <p role="status">Loading search shortcuts…</p>
      : result ? <>
        <p className="launcher-bang-caption">{result.fallback ? `Unknown !${bang.trigger} — using ${result.name}` : 'Web search'}<span>Enter to {result.search ? 'search' : 'open'}</span></p>
        <a className="launcher-bang-link" href={result.url}>
          <span className="launcher-bang-token">!{result.trigger}</span>
          <span><strong>{result.search ? `Search ${result.name}` : `Open ${result.name}`}</strong><span>{result.search || new URL(result.url).hostname}</span></span>
          <ArrowUpRight size={19} aria-hidden="true" />
        </a>
      </> : <p role="status">{bang.trigger ? 'This shortcut needs a valid search or site name.' : 'Type a shortcut, then your search.'}</p>}
    <div className="launcher-bang-examples" aria-label="Example search shortcuts">{['g', 'gh', 'yt', 'w', 't3'].map(trigger => <button key={trigger} onClick={() => onSelect(`!${trigger} ${bang.search}`)}>!{trigger}</button>)}</div>
  </section>;
}
