import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';

export interface Poll<T> {
  /** Null until the first answer for the current key. A failed refresh keeps the last answer. */
  data: T | null;
  error: string | null;
  /** Fetches now, abandoning any request still in flight so an older answer cannot land after it. */
  refresh: () => void;
  /** Replaces the current answer, e.g. with the project an action just returned. */
  patch: (update: (current: T) => T) => void;
}

interface Snapshot<T> { key: string; data: T | null; error: string | null }

/** Wait `ms` between fetches instead of the usual interval for as long as the latest answer is `idle`. */
export interface PollBackoff<T> { idle: (data: T) => boolean; ms: number }

/** The wait before the next fetch: the interval, stretched to the backoff while the latest answer is idle. */
export function nextDelay<T>(intervalMs: number, latest: T | null, backoff?: PollBackoff<T>): number {
  return backoff && latest !== null && backoff.idle(latest) ? Math.max(intervalMs, backoff.ms) : intervalMs;
}

/**
 * Loads once, then every `intervalMs` (null: once only). Ticks are skipped while the document is
 * hidden and a fetch runs as soon as it is visible again. `key` identifies what is being loaded;
 * a new key forgets the old answer instead of showing it for the new subject.
 */
export function usePoll<T>(
  key: string, load: (signal: AbortSignal) => Promise<T>, intervalMs: number | null, enabled = true, backoff?: PollBackoff<T>,
): Poll<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ key, data: null, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  const backoffRef = useRef(backoff);
  backoffRef.current = backoff;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let loaded = false;
    let latest: T | null = null;
    let inFlight: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (alive && intervalMs !== null) timer = setTimeout(tick, nextDelay(intervalMs, latest, backoffRef.current));
    };
    async function fetchNow() {
      clearTimeout(timer);
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        loaded = true;
        latest = data;
        setSnapshot({ key, data, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setSnapshot(current => ({ key, data: current.key === key ? current.data : null, error: errorMessage(error) }));
      }
      if (inFlight === controller) { inFlight = null; schedule(); }
    }
    function tick() {
      if (document.hidden) schedule(); else void fetchNow();
    }
    const visibility = () => { if (!document.hidden && (!loaded || intervalMs !== null)) void fetchNow(); };

    refreshRef.current = () => void fetchNow();
    document.addEventListener('visibilitychange', visibility);
    if (document.hidden) schedule(); else void fetchNow();
    return () => {
      alive = false;
      inFlight?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      refreshRef.current = () => {};
    };
  }, [key, intervalMs, enabled]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const patch = useCallback((update: (current: T) => T) => {
    setSnapshot(current => current.data === null || current.key !== key ? current : { ...current, data: update(current.data) });
  }, [key]);
  const fresh = snapshot.key === key;
  return { data: fresh ? snapshot.data : null, error: fresh ? snapshot.error : null, refresh, patch };
}

/** Re-renders every second while `active`, for uptime. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
