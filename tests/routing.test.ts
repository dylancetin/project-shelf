import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
import { cleanup, files, fixture, project, request, until } from './helpers';

describe('HTTP routing safeguards', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    root = await fixture();
    await files(root, { 'dist/index.html': '<html>Routing fixture</html>' });
    app = await createApp({
      dbPath: ':memory:', bootstrap: false, staticDir: path.join(root, 'dist'),
      initialSettings: { roots: [] },
    });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  test('keeps API misses and unsupported methods out of the SPA fallback', async () => {
    const item = project(root);
    app.store.insert(item);
    for (const [route, method, status, error] of [
      ['/api', 'GET', 404, 'API route not found'],
      ['/api/missing', 'GET', 404, 'API route not found'],
      ['/api/projects', 'PUT', 404, 'API route not found'],
      ['/api/health', 'HEAD', 404, 'API route not found'],
      ['/api/settings', 'OPTIONS', 404, 'API route not found'],
      [`/api/projects/${item.id}`, 'GET', 404, 'API route not found'],
      [`/api/projects/${item.id}/launch`, 'GET', 404, 'API route not found'],
      [`/api/projects/${item.id}/logs`, 'POST', 405, 'Method not allowed'],
      [`/api/projects/${item.id}/unknown`, 'POST', 404, 'API route not found'],
      ['/api/projects/missing/logs', 'GET', 404, 'Project not found'],
      ['/api/projects/missing/start', 'POST', 404, 'Project not found'],
      ['/search', 'POST', 405, 'Method not allowed'],
      ['/opensearch.xml', 'OPTIONS', 405, 'Method not allowed'],
      ['/client/route', 'POST', 405, 'Method not allowed'],
    ] as const) {
      const response = await app.fetch(request(route, method));
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      // HEAD responses are bodyless when dispatched by an HTTP framework/server.
      if (method !== 'HEAD') expect(await response.json()).toEqual({ error });
    }
    const head = await app.fetch(request('/client/route', 'HEAD'));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await app.fetch(request('/api/health/'))).status).toBe(200);
    expect((await app.fetch(request('/%61pi/health'))).headers.get('content-type')).toContain('text/html');
    expect((await app.fetch(request('/api//health'))).status).toBe(404);
  });

  test('decodes project IDs exactly once and rejects malformed encodings', async () => {
    for (const id of ['literal%2Ffixture', 'slash/fixture', 'café 日本語', 'query?fixture', 'plus+fixture']) {
      const item = project(root, { id });
      app.store.insert(item);
      const route = `/api/projects/${encodeURIComponent(id)}`;
      expect(await (await app.fetch(request(`${route}/logs/`))).json()).toEqual({ logs: [] });
      const changed = await app.fetch(request(`${route}/`, 'PATCH', { favorite: true }));
      expect(changed.status).toBe(200);
      expect((await changed.json()).project).toMatchObject({ id, favorite: true });
    }
    for (const id of ['%', '%GG', '%E0%A4%A']) {
      const response = await app.fetch(request(`/api/projects/${id}/logs`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid project ID' });
    }
  });

  test('enforces JSON content type, shape and size even for streamed or misdeclared bodies', async () => {
    const limit = 5 * 1024 * 1024;
    const payload = new TextEncoder().encode(`{"padding":"${'x'.repeat(limit)}"}`);
    for (const declared of [undefined, '1', String(payload.byteLength)]) {
      let offset = 0;
      const response = await app.fetch(new Request('http://shelf.test/api/settings', {
        method: 'PATCH', headers: {
          'Content-Type': 'application/json',
          ...(declared === undefined ? {} : { 'Content-Length': declared }),
        },
        body: new ReadableStream({
          pull(controller) {
            if (offset === payload.byteLength) { controller.close(); return; }
            const end = Math.min(offset + 64 * 1024, payload.byteLength);
            controller.enqueue(payload.subarray(offset, end));
            offset = end;
          },
        }),
      }));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Request body exceeds 5 MB' });
    }
    for (const body of ['{bad', 'null', '[]', '"string"']) {
      const response = await app.fetch(new Request('http://shelf.test/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      }));
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe('string');
    }
    const missing = await app.fetch(request('/api/settings', 'PATCH', undefined, { 'Content-Type': 'application/json' }));
    expect(missing.status).toBe(400);
    const form = await app.fetch(request('/api/settings', 'PATCH', {}, { 'Content-Type': 'text/plain' }));
    expect(form.status).toBe(415);
    expect(app.store.settings().roots).toEqual([]);
  });

  test('origin middleware runs before routing, body parsing and mutations', async () => {
    for (const route of ['/api/scan', '/api/projects/missing/start', '/missing', '/search']) {
      const response = await app.fetch(new Request(`http://shelf.test${route}`, {
        method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{bad',
      }));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain('same origin');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(app.store.list()).toEqual([]);
  });

  test('unexpected handler failures stay JSON and do not leak internal errors', async () => {
    const listing = spyOn(app.store, 'list').mockImplementation(() => { throw new Error('private database detail'); });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.fetch(request('/api/projects'));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(log).toHaveBeenCalled();
    } finally {
      listing.mockRestore();
      log.mockRestore();
    }
  });

  test('project middleware serializes edits and releases the lock after validation errors', async () => {
    const item = project(root);
    app.store.insert(item);
    const route = `/api/projects/${item.id}`;
    let reading = false;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const first = app.fetch(new Request(`http://shelf.test${route}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        async pull(controller) {
          reading = true;
          await ready;
          controller.enqueue(new TextEncoder().encode('{"name":"Serialized edit"}'));
          controller.close();
        },
      }, { highWaterMark: 0 }),
    }));
    let second: Promise<Response> | undefined;
    try {
      await until(() => reading);
      let updated = false;
      second = app.fetch(request(route, 'PATCH', { favorite: true })).then(response => { updated = true; return response; });
      await Bun.sleep(20);
      expect(updated).toBe(false);
    } finally {
      finish();
    }
    expect((await first).status).toBe(200);
    expect((await second)?.status).toBe(200);
    expect(app.store.get(item.id)).toMatchObject({ name: 'Serialized edit', favorite: true });

    const [invalid, recovered] = await Promise.all([
      app.fetch(request(route, 'PATCH', { favorite: 'not a boolean' })),
      app.fetch(request(route, 'PATCH', { description: 'Recovered edit' })),
    ]);
    expect(invalid.status).toBe(400);
    expect(recovered.status).toBe(200);
    expect(app.store.get(item.id)).toMatchObject({ name: 'Serialized edit', favorite: true, description: 'Recovered edit' });
  });

  test('shutdown drains an in-flight mutation and rejects later requests', async () => {
    let reading = false;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const pending = app.fetch(new Request('http://shelf.test/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        async pull(controller) {
          reading = true;
          await ready;
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      }, { highWaterMark: 0 }),
    }));
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await until(() => reading);
      closing = app.close().then(() => { closed = true; });
      await Bun.sleep(20);
      expect(closed).toBe(false);
      const rejected = await app.fetch(request('/api/health'));
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toEqual({ error: 'The server is shutting down' });
    } finally {
      finish();
      await closing;
    }
    expect((await pending).status).toBe(200);
    expect(closed).toBe(true);
  });
});
