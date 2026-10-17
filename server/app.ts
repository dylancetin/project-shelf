import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RunMode, Settings } from '../shared/types';
import { importBookmarks } from './bookmarks';
import { ApiError, errorMessage } from './errors';
import { findLogos, serveLogo } from './logos';
import { waitForDevelopment, type LaunchOptions } from './launch';
import { confinedFile, copyProject } from './paths';
import { ProcessManager, type ProcessOptions } from './processes';
import { scanRoots } from './scanner';
import { openSearchDescription, searchRedirect } from './search';
import { Store, type ProjectData } from './store';
import { object, projectInput, settingsInput, text } from './validation';

const MAX_BODY = 5 * 1024 * 1024;
const JSON_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export interface AppOptions {
  dbPath: string;
  staticDir?: string;
  bookmarksPath?: string;
  initialSettings?: Partial<Settings>;
  bootstrap?: boolean;
  processOptions?: ProcessOptions;
  launchOptions?: LaunchOptions;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

const TRUSTED_PANEL_ORIGIN = 'https://panel.tail750ac6.ts.net';

export function validateMutationOrigin(request: Request, hostnames: readonly string[] = [], panelPort?: number): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const crossOrigin = fetchSite === 'cross-site' || fetchSite === 'same-site';
  if (origin) {
    try {
      const source = new URL(origin);
      const target = new URL(request.url);
      if (['http:', 'https:'].includes(source.protocol) && !source.username && !source.password
        && source.pathname === '/' && !source.search && !source.hash) {
        if (!crossOrigin && source.origin === target.origin) return;
        if (source.origin === TRUSTED_PANEL_ORIGIN) return;
        const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
        // Network aliases share the panel's port; standard HTTPS also supports
        // TLS-terminating proxies without trusting spoofable forwarded headers.
        const expectedPort = panelPort === undefined ? port(target) : String(panelPort);
        if (hostnames.includes(source.hostname) && (port(source) === expectedPort
          || (source.protocol === 'https:' && !source.port))) return;
      }
    }
    catch { /* Invalid origins are never accepted. */ }
    throw new ApiError(403, 'Mutating requests must come from the same origin or a trusted panel address');
  }
  if (crossOrigin) throw new ApiError(403, 'Mutating requests must come from the same origin or a trusted panel address');
  // Requests without browser Origin/Fetch Metadata headers remain usable from local CLIs.
  // No CORS headers are emitted. JSON bodies still require a non-simple content type;
  // linked service URLs and arbitrary ports do not grant mutation access.
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'Content-Type must be application/json');
  }
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY) throw new ApiError(413, 'Request body exceeds 5 MB');
  if (!request.body) throw new ApiError(400, 'A JSON body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel();
        throw new ApiError(413, 'Request body exceeds 5 MB');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON body'); }
  return object(parsed);
}

export async function createApp(options: AppOptions) {
  const store = new Store(options.dbPath, options.initialSettings);
  const processes = new ProcessManager(options.processOptions);
  let scanning: ReturnType<typeof scanRoots> | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const requests = new Set<Promise<Response>>();
  const locks = new Map<string, Promise<unknown>>();

  function requireProject(id: string): ProjectData {
    const project = store.get(id);
    if (!project) throw new ApiError(404, 'Project not found');
    return project;
  }

  function scan() {
    if (!scanning) scanning = scanRoots(store).finally(() => { scanning = null; });
    return scanning;
  }

  async function locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    locks.set(id, pending);
    try { return await pending; }
    finally { if (locks.get(id) === pending) locks.delete(id); }
  }

  if (options.bootstrap !== false && !store.getValue('bootstrapComplete')) {
    try {
      await scan();
      if (options.bookmarksPath) {
        try {
          const info = await stat(options.bookmarksPath);
          if (info.isFile() && info.size <= MAX_BODY) {
            importBookmarks(store, await readFile(options.bookmarksPath, 'utf8'));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Bookmark seed skipped: ${errorMessage(error)}`);
        }
      }
      store.setValue('bootstrapComplete', new Date().toISOString());
    } catch (error) {
      store.close();
      throw error;
    }
  }

  async function duplicate(id: string, input: Record<string, unknown>): Promise<Response> {
    for (const key of Object.keys(input)) {
      if (!['name', 'directory', 'copyFiles'].includes(key)) throw new ApiError(400, `Unknown duplicate field: ${key}`);
    }
    const source = requireProject(id);
    const name = text(input.name, 'name', 200, false);
    if (typeof input.copyFiles !== 'boolean') throw new ApiError(400, 'copyFiles must be a boolean');
    let directory = source.directory;
    if (input.copyFiles) {
      if (source.kind !== 'project') throw new ApiError(400, 'Services do not have project files to copy');
      const slug = name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'project-copy';
      const destination = input.directory === undefined || input.directory === ''
        ? path.join(path.dirname(source.directory), slug) : text(input.directory, 'directory', 4096, false);
      directory = await copyProject(source.directory, destination);
    } else if (input.directory !== undefined) {
      directory = text(input.directory, 'directory', 4096);
    }
    const result = await projectInput({ name, directory }, store.settings(), source);
    const now = new Date().toISOString();
    result.id = crypto.randomUUID();
    result.createdAt = now;
    result.updatedAt = now;
    if (directory !== source.directory && !input.copyFiles) result.logo = '';
    store.insert(result);
    return json({ project: processes.project(result) }, 201);
  }

  async function handle(request: Request, panelPort?: number): Promise<Response> {
    validateMutationOrigin(request, store.settings().hostnames, panelPort);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method;
    if (pathname === '/search' || pathname === '/opensearch.xml') {
      if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'Method not allowed');
      const engine = store.settings().defaultSearchEngine;
      return pathname === '/search' ? searchRedirect(url, engine) : openSearchDescription(request, engine);
    }
    if (pathname === '/api/health' && method === 'GET') return json({ ok: true });
    if (pathname === '/api/extension/bridge' && method === 'GET') {
      // Inert same-origin document. Only the user's host-authorized extension
      // injects its isolated content script; this page exposes no message API.
      return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="project-shelf-extension-bridge" content="1"><title>Project Shelf extension connection</title></head><body></body></html>', {
        headers: { ...JSON_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors chrome-extension:; base-uri 'none'; form-action 'none'" },
      });
    }
    if (pathname === '/api/projects') {
      if (method === 'GET') return json({ projects: store.list().map((project) => processes.project(project)) });
      if (method === 'POST') {
        const project = await projectInput(await body(request), store.settings());
        store.insert(project);
        return json({ project: processes.project(project) }, 201);
      }
    }
    if (pathname === '/api/projects/reorder' && method === 'POST') {
      const input = await body(request);
      if (Object.keys(input).some(key => !['kind', 'ids', 'previousIds'].includes(key))) throw new ApiError(400, 'Unknown reorder field');
      if (input.kind !== 'project' && input.kind !== 'service') throw new ApiError(400, 'kind must be project or service');
      for (const key of ['ids', 'previousIds'] as const) {
        if (!Array.isArray(input[key]) || input[key].length > 20000 || input[key].some(id => typeof id !== 'string' || !id || id.length > 200)) {
          throw new ApiError(400, `${key} must be an array of registration IDs`);
        }
      }
      store.reorder(input.kind, input.ids as string[], input.previousIds as string[]);
      return json({ projects: store.list().map(project => processes.project(project)) });
    }
    if (pathname === '/api/settings') {
      if (method === 'GET') return json({ settings: store.settings() });
      if (method === 'PATCH') {
        const settings = settingsInput(await body(request), store.settings());
        store.setValue('settings', settings);
        return json({ settings });
      }
    }
    if (pathname === '/api/scan' && method === 'POST') return json(await scan());
    if (pathname === '/api/bookmarks/import' && method === 'POST') {
      const input = await body(request);
      const html = text(input.html, 'html', MAX_BODY);
      if (input.localOnly !== undefined && typeof input.localOnly !== 'boolean') throw new ApiError(400, 'localOnly must be a boolean');
      return json(importBookmarks(store, html, input.localOnly !== false));
    }
    const match = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(start|launch|stop|logs|duplicate|logos|logo))?$/);
    if (match) {
      let id: string;
      try { id = decodeURIComponent(match[1]!); }
      catch { throw new ApiError(400, 'Invalid project ID'); }
      const action = match[2];
      if (action === 'launch' && method === 'POST') {
        const input = await body(request);
        if (Object.keys(input).length) throw new ApiError(400, 'Launch does not accept any fields');
        const launched = await locked(id, async () => {
          if (closing) throw new ApiError(503, 'The server is shutting down');
          if (request.signal.aborted) throw new ApiError(408, 'Opening the project was cancelled');
          const project = requireProject(id);
          if (project.kind !== 'project') throw new ApiError(400, 'Services are links and cannot be started');
          if (!project.url && !project.port) throw new ApiError(400, 'Configure a project address or port in project details before opening it');
          const runtime = processes.runtime(id);
          if (processes.active(id)) {
            if (runtime.mode !== 'dev' || runtime.status === 'stopping') {
              throw new ApiError(409, 'Stop the current command in project details before opening development');
            }
            return processes.project(project);
          }
          return processes.start(project, 'dev');
        });
        // Release the mutation lock while waiting, so Stop/Delete can still cancel
        // a slow launch and concurrent opens reuse the same development process.
        await waitForDevelopment(launched, processes, request.signal, () => closing, options.launchOptions);
        return json({ project: processes.project(requireProject(id)) });
      }
      if (method === 'GET') {
        const project = requireProject(id);
        if (action === 'logs') return json({ logs: processes.logs(id) });
        if (action === 'logos') return json({ logos: await findLogos(project.directory, id) });
        if (action === 'logo') return serveLogo(project.directory, url.searchParams.get('path') || project.logo);
      }
      if (['POST', 'PATCH', 'DELETE'].includes(method)) {
        return locked(id, async () => {
          const project = requireProject(id);
          if (!action && method === 'PATCH') {
            const input = await body(request);
            const changed = await projectInput(input, store.settings(), project);
            if (processes.active(id) && (changed.directory !== project.directory || changed.kind !== project.kind)) {
              throw new ApiError(409, 'Stop the project before changing its directory or kind');
            }
            store.update(changed);
            return json({ project: processes.project(changed) });
          }
          if (!action && method === 'DELETE') {
            await processes.stop(id);
            store.remove(id);
            processes.forget(id);
            return json({ ok: true });
          }
          if (action === 'start' && method === 'POST') {
            const input = await body(request);
            if (!['dev', 'prod', 'build'].includes(input.mode as string)) throw new ApiError(400, 'mode must be dev, prod, or build');
            return json({ project: await processes.start(project, input.mode as RunMode) });
          }
          if (action === 'stop' && method === 'POST') {
            await processes.stop(id);
            return json({ project: processes.project(project) });
          }
          if (action === 'duplicate' && method === 'POST') return duplicate(id, await body(request));
          throw new ApiError(405, 'Method not allowed');
        });
      }
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) throw new ApiError(404, 'API route not found');
    if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'Method not allowed');
    return serveStatic(request, options.staticDir);
  }

  async function fetch(request: Request, server?: { readonly port: number | undefined }): Promise<Response> {
    if (closing) return json({ error: 'The server is shutting down' }, 503);
    // Bun supplies the listener here. A proxy's Host header may omit its port;
    // use the actual listener rather than that header for trusted alias origins.
    const pending = handle(request, server?.port).catch((error) => {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error('Request failed:', error);
      return json({ error: 'Internal server error' }, 500);
    });
    requests.add(pending);
    try { return await pending; }
    finally { requests.delete(pending); }
  }

  function close(): Promise<void> {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled([...requests]);
        await processes.close();
        store.close();
      })();
    }
    return closePromise;
  }

  return { fetch, close, store, processes };
}

async function serveStatic(request: Request, staticDir?: string): Promise<Response> {
  if (!staticDir) throw new ApiError(404, 'Page not found');
  let requested: string;
  try { requested = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, ''); }
  catch { throw new ApiError(400, 'Invalid URL path'); }
  if (!requested) requested = 'index.html';
  let filename: string;
  try {
    filename = await confinedFile(staticDir, requested);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    if (path.extname(requested)) throw new ApiError(404, 'File not found');
    try { filename = await confinedFile(staticDir, 'index.html'); }
    catch { return new Response('Project Shelf frontend is not built. Run bun run build, or use bun run dev.', { status: 503 }); }
  }
  const file = Bun.file(filename);
  const relative = path.relative(staticDir, filename).split(path.sep).join('/');
  // Installed apps use Workbox's versioned precache. These headers also make
  // repeat visits fast before a worker takes control (including plain HTTP).
  // Keep the worker/manifest revalidated so a cached shell can discover updates.
  const cacheControl = relative === 'index.html'
    ? 'private, max-age=0, stale-while-revalidate=86400, stale-if-error=604800'
    : /^(?:sw\.js|manifest\.webmanifest)$/.test(relative) ? 'no-cache'
    : /^assets\/.+-[\w-]{8,}\.[\w.]+$/.test(relative) ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600, stale-while-revalidate=86400';
  return new Response(request.method === 'HEAD' ? null : file, { headers: {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Cache-Control': cacheControl,
  } });
}
