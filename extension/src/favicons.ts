import type { BrowserFavicons } from '../../shared/browser-bookmarks';
import type { ChromeApi } from './browser';
import { FAVICON_PROVIDER_ORIGIN, faviconLocation, faviconProviderUrl, publicFaviconHostname } from './favicon-policy';
import { boundedFaviconResponse, checkedFavicon, faviconDigest, MAX_FAVICON_BYTES, rasterizeFavicon, type FaviconRasterizer } from './favicon-raster';

export { faviconLocation, publicFaviconHostname, FAVICON_PROVIDER_ORIGIN } from './favicon-policy';

export interface FaviconStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, icon: Blob): Promise<void>;
  clear?(): Promise<void>;
}

const MAX_ICONS = 1000;
const NEGATIVE_TTL = 30_000;
// DuckDuckGo's unbranded globe (normally a 404); don't count it if served as 200.
const PROVIDER_PLACEHOLDER = 'e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17';

export function faviconStore(): FaviconStore {
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    return database ??= new Promise<IDBDatabase>((resolve, reject) => {
      // Keep the original database/schema and origin-keyed entries intact.
      // New page:/online: keys coexist with old origins; no reset or data loss.
      const request = indexedDB.open('project-shelf-favicons', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('icons', { keyPath: 'origin' }).createIndex('savedAt', 'savedAt');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { database = undefined; reject(new Error('Could not open the local favicon cache.')); };
    });
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('icons').objectStore('icons').get(key);
        request.onsuccess = () => resolve(request.result?.icon instanceof Blob ? request.result.icon : null);
        request.onerror = () => reject(new Error('Could not read saved favicons.'));
      });
    },
    async put(key, icon) {
      if (icon.size > MAX_FAVICON_BYTES) throw new Error('The favicon is too large to save.');
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('icons', 'readwrite');
        const store = transaction.objectStore('icons');
        store.put({ origin: key, icon, savedAt: Date.now() });
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - MAX_ICONS;
          if (excess <= 0) return;
          const cursor = store.index('savedAt').openCursor();
          cursor.onsuccess = () => {
            if (cursor.result && excess-- > 0) { cursor.result.delete(); cursor.result.continue(); }
          };
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(new Error('Could not save favicons locally.'));
      });
    },
    async clear() {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('icons', 'readwrite');
        transaction.objectStore('icons').clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(new Error('Could not clear saved favicons.'));
      });
    },
  };
}

export function chromeFavicons(api: ChromeApi, store: FaviconStore = faviconStore(), fetcher: typeof fetch = fetch, rasterize: FaviconRasterizer = rasterizeFavicon): BrowserFavicons {
  const objects = new Map<string, string>();
  const missing = new Map<string, number>();
  const pending = new Map<string, Promise<string | null>>();
  let generation = 0;
  let refreshing = false;
  let defaultIcon: Promise<string | null> | undefined;
  let defaultAttempt = 0;
  const hasAccess = () => api.permissions.contains({ origins: [FAVICON_PROVIDER_ORIGIN] });
  const nativeAccess = () => api.permissions.contains({ permissions: ['favicon'] });

  function remember(key: string, icon: Blob): string {
    const previous = objects.get(key);
    if (previous) URL.revokeObjectURL(previous);
    objects.delete(key);
    const url = URL.createObjectURL(icon);
    objects.set(key, url);
    missing.delete(key);
    while (objects.size > MAX_ICONS) {
      const oldest = objects.keys().next().value!;
      URL.revokeObjectURL(objects.get(oldest)!);
      objects.delete(oldest);
    }
    return url;
  }
  function markMissing(key: string) {
    missing.set(key, Date.now());
    while (missing.size > MAX_ICONS) missing.delete(missing.keys().next().value!);
  }
  async function nativeIcon(page: string): Promise<Blob> {
    const endpoint = new URL(api.runtime.getURL('_favicon/'));
    endpoint.searchParams.set('pageUrl', page);
    endpoint.searchParams.set('size', '16');
    const response = await fetcher(endpoint.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return rasterize(await boundedFaviconResponse(response));
  }
  async function nativeDefault(): Promise<string | null> {
    // This goes ONLY to Chrome's local database, never to DNS or a website.
    if (!defaultIcon || Date.now() - defaultAttempt > NEGATIVE_TTL) {
      defaultAttempt = Date.now();
      defaultIcon = nativeIcon('https://project-shelf-favicon.invalid/').then(faviconDigest).catch(() => null);
    }
    return defaultIcon;
  }
  async function branded(icon: Blob, nativeAllowed: boolean): Promise<Blob | null> {
    const checked = await checkedFavicon(icon);
    if (await faviconDigest(checked) === PROVIDER_PLACEHOLDER) return null;
    const normalized = await rasterize(checked);
    if (nativeAllowed && await faviconDigest(normalized) === await nativeDefault()) return null;
    return normalized;
  }
  async function cached(key: string, nativeAllowed = false): Promise<string | null> {
    if (objects.has(key)) return objects.get(key)!;
    let icon: Blob | null;
    try { icon = await store.get(key); }
    catch { return null; } // Storage failure must not stop native/online reads.
    if (!icon) return null;
    try {
      const validated = await branded(icon, nativeAllowed);
      return validated ? remember(key, validated) : null;
    } catch { return null; } // An invalid legacy entry is never a branded icon.
  }
  async function read(value: string): Promise<string | null> {
    const location = faviconLocation(value);
    if (!location) return null;
    const pageKey = `page:${location.page}`;
    if (pending.has(pageKey)) return pending.get(pageKey)!;
    const epoch = generation;
    const task = (async () => {
      const nativeAllowed = await nativeAccess().catch(() => false);
      // Page-specific entries must not collapse to whichever origin was first.
      const page = await cached(pageKey, nativeAllowed);
      if (page) return page;
      const host = publicFaviconHostname(value);
      const online = host ? await cached(`online:${host}`) : null;
      if (online) return online;
      if (nativeAllowed && Date.now() - (missing.get(pageKey) ?? 0) > NEGATIVE_TTL) {
        try {
          const icon = await nativeIcon(location.page);
          const placeholder = await nativeDefault();
          // If the reference cannot be read, don't guess that Chrome's generic
          // globe is a branded icon. Online acquisition remains independent.
          if (placeholder && await faviconDigest(icon) !== placeholder && epoch === generation) {
            const url = remember(pageKey, icon);
            // The in-memory icon remains usable even if storage is unavailable.
            await store.put(pageKey, icon).catch(() => {});
            return url;
          }
        } catch { /* A local miss falls through to legacy cache or monogram. */ }
        markMissing(pageKey);
      }
      // Existing releases saved origin-keyed blobs. Read them without needing a
      // current grant, but don't let them suppress explicit online acquisition.
      return epoch === generation ? cached(location.origin, nativeAllowed) : null;
    })();
    pending.set(pageKey, task);
    try { return await task; }
    finally { pending.delete(pageKey); }
  }
  return {
    hasAccess,
    // Must be invoked directly from the button's click, before any awaits.
    // Optional native access supplies page-specific icons without network I/O.
    requestAccess: () => api.permissions.request({ origins: [FAVICON_PROVIDER_ORIGIN], permissions: ['favicon'] }),
    read: value => read(value).catch(() => null),
    async refresh(urls, progress) {
      if (refreshing) throw new Error('An icon refresh is already running.');
      refreshing = true;
      try {
        if (!await hasAccess()) throw new Error('Enable online icons to allow access to icons.duckduckgo.com.');
        const hosts = [...new Set(urls.map(publicFaviconHostname).filter((host): host is string => Boolean(host)))];
        let done = 0, updated = 0, storageFailures = 0;
        const failures: string[] = [];
        const epoch = generation;
        progress(0, hosts.length);
        const queue = [...hosts];
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && epoch === generation) {
            const host = queue.shift()!;
            try {
              const response = await fetcher(faviconProviderUrl(host), { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(8000) });
              const raw = await boundedFaviconResponse(response);
              if (await faviconDigest(raw) === PROVIDER_PLACEHOLDER) throw new Error('No branded icon is available.');
              const icon = await rasterize(raw);
              if (epoch !== generation) return;
              // Replace old Chrome placeholder caches for every page at this
              // host. Online refresh always fetches; a cached globe cannot win.
              remember(`online:${host}`, icon);
              updated++;
              try { await store.put(`online:${host}`, icon); }
              catch { storageFailures++; }
            } catch (error) {
              if (failures.length < 3) failures.push(`${host}: ${error instanceof Error ? error.message : 'download failed'}`);
            } finally { progress(++done, hosts.length); }
          }
        }));
        if (storageFailures) throw new Error(`${updated} site icon${updated === 1 ? ' is' : 's are'} available in this tab, but ${storageFailures} could not be saved locally. Free browser storage and refresh again.`);
        if (hosts.length && !updated) throw new Error(`No online icons could be updated. Saved icons were kept. ${failures.join(' ')} Try refreshing again when online.`);
        return updated;
      } finally { refreshing = false; }
    },
    ...(store.clear ? { async clear() {
      generation++;
      // Drain bounded local reads before clearing so none can repopulate cache.
      await Promise.allSettled([...pending.values()]);
      await store.clear!();
      for (const url of objects.values()) URL.revokeObjectURL(url);
      objects.clear(); missing.clear();
    } } : {}),
  };
}
