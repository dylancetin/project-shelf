import { useCallback, useEffect, useRef, useState } from 'react';
import type { BookmarkNode } from '../shared/browser-bookmarks';
import { errorMessage } from './api';
import { shelfPlatform } from './platform';

export function useBookmarks() {
  const provider = shelfPlatform().bookmarks;
  const [tree, setTree] = useState<BookmarkNode[]>([]);
  const [granted, setGranted] = useState(false);
  const [loading, setLoading] = useState(Boolean(provider));
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!provider) return;
    const request = ++generation.current;
    try {
      const access = await provider.hasAccess();
      const nodes = access ? await provider.getTree() : [];
      if (request !== generation.current) return;
      setGranted(access); setTree(nodes); setError('');
    } catch (error) {
      if (request === generation.current) { setError(errorMessage(error)); setTree([]); }
    } finally { if (request === generation.current) setLoading(false); }
  }, [provider]);
  useEffect(() => {
    if (!provider) return;
    const unsubscribe = provider.subscribe(() => { void refresh(); });
    void refresh();
    return () => { ++generation.current; unsubscribe(); };
  }, [provider, granted, refresh]);
  async function connect() {
    if (!provider) return;
    setLoading(true); setError('');
    try {
      if (!await provider.requestAccess()) { setError('Bookmark access was not granted. You can try again whenever you’re ready.'); return; }
      await refresh();
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }
  return { provider, tree, granted, loading, error, refresh, connect };
}
