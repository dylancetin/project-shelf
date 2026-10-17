import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import { cleanup, files, fixture, project, request, shellCommand, until } from './helpers';

describe('start development before navigation', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;

  beforeEach(async () => {
    root = await fixture();
    const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('reserved') });
    port = reservation.port!;
    await reservation.stop(true);
    await files(root, {
      'dev.ts': `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(root, 'starts'))}, 'dev\\n');
await Bun.sleep(250);
let requests = 0;
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT || process.argv[2]), fetch(request) {
  appendFileSync(${JSON.stringify(path.join(root, 'requests'))}, request.url + '\\n');
  return new Response('Development fixture', { status: ++requests === 1 ? 503 : 200 });
} });
`,
    });
    app = await createApp({ dbPath: ':memory:', bootstrap: false, processOptions: { stopGraceMs: 100 }, launchOptions: { timeoutMs: 2000 } });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  function add(overrides: Parameters<typeof project>[1] = {}) {
    const item = project(root, {
      port, url: `http://localhost:${port}/preview?launch=1#section`, hostname: 'beelinkk',
      devCommand: `${shellCommand(path.join(root, 'dev.ts'))} ${port}`, ...overrides,
    });
    app.store.insert(item);
    return item;
  }
  const launch = (id: string, headers: Record<string, string> = {}) => app.fetch(request(`/api/projects/${id}/launch`, 'POST', {}, headers));

  test('waits for delayed HTTP readiness, retries 503, and preserves the full destination', async () => {
    const item = add();
    const response = await launch(item.id);
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ ...item, runtime: { status: 'running', mode: 'dev' } });
    expect((await readFile(path.join(root, 'requests'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await readFile(path.join(root, 'requests'), 'utf8')).toContain(`/preview?launch=1`);
  });

  test('concurrent and repeated opens reuse one development process', async () => {
    const item = add();
    const responses = await Promise.all([launch(item.id), launch(item.id)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const pid = app.processes.runtime(item.id).pid;
    expect((await launch(item.id)).status).toBe(200);
    expect(app.processes.runtime(item.id).pid).toBe(pid);
    expect(await readFile(path.join(root, 'starts'), 'utf8')).toBe('dev\n');
  });

  test('probes the local dev port even when the destination is a separate HTTPS reverse proxy', async () => {
    const item = add({ url: 'https://project.example.test/preview?launch=1#section', hostname: '' });
    expect((await launch(item.id)).status).toBe(200);
    expect(app.store.get(item.id)?.url).toBe(item.url);
  });

  test('supports an explicit address port without a separately configured port', async () => {
    const item = add({ port: null });
    expect((await launch(item.id)).status).toBe(200);
  });

  test('rejects missing configuration, services, and cross-origin requests without starting commands', async () => {
    for (const overrides of [{ port: null, url: '' }, { devCommand: '' }, { kind: 'service' as const }]) {
      const item = add(overrides);
      expect((await launch(item.id)).status).toBe(400);
      expect(app.processes.active(item.id)).toBe(false);
    }
    const item = add();
    expect((await launch(item.id, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.fetch(request(`/api/projects/${item.id}/launch`))).status).toBe(404);
    expect((await app.fetch(request(`/api/projects/${item.id}/launch`, 'POST', { mode: 'prod' }))).status).toBe(400);
    expect(app.processes.active(item.id)).toBe(false);
  });

  test('reports a failed dev command instead of declaring it ready', async () => {
    const item = add({ devCommand: 'echo startup-failed >&2; exit 7' });
    const response = await launch(item.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Live logs');
    expect(app.processes.runtime(item.id)).toMatchObject({ status: 'failed', exitCode: 7 });
  });

  test('a readiness timeout leaves the explicitly started process available for inspection and stop', async () => {
    await app.close();
    app = await createApp({ dbPath: ':memory:', bootstrap: false, processOptions: { stopGraceMs: 100 }, launchOptions: { timeoutMs: 400 } });
    const item = add({ devCommand: 'sleep 60' });
    const response = await launch(item.id);
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain('port');
    expect(app.processes.runtime(item.id).status).toBe('running');
  });

  test('Stop and deletion can interrupt readiness without waiting for the launch timeout', async () => {
    for (const method of ['POST', 'DELETE']) {
      const item = add({ devCommand: 'sleep 60' });
      const pending = launch(item.id);
      await until(() => app.processes.runtime(item.id).status === 'running');
      const stopped = await Promise.race([
        app.fetch(request(`/api/projects/${item.id}${method === 'POST' ? '/stop' : ''}`, method)),
        Bun.sleep(1000).then(() => { throw new Error('Launch must not hold the mutation lock while waiting'); }),
      ]);
      expect(stopped.status).toBe(200);
      expect((await pending).status).toBe(409);
      expect(app.processes.active(item.id)).toBe(false);
    }
  });

  test('does not stop or replace an active build or production command', async () => {
    for (const mode of ['build', 'prod'] as const) {
      const item = add({ buildCommand: mode === 'build' ? 'sleep 60' : '', prodCommand: 'sleep 60' });
      await app.processes.start(item, mode);
      await until(() => app.processes.runtime(item.id).status === 'running');
      const pid = app.processes.runtime(item.id).pid;
      expect((await launch(item.id)).status).toBe(409);
      expect(app.processes.runtime(item.id)).toMatchObject({ status: 'running', mode, pid });
    }
  });

  test('shutdown interrupts pending readiness and cleans up its development process', async () => {
    const item = add({ devCommand: 'sleep 60' });
    const pending = launch(item.id);
    await until(() => app.processes.runtime(item.id).status === 'running');
    await app.close();
    expect((await pending).status).toBe(503);
    expect(app.processes.active(item.id)).toBe(false);
  });

  test('cancelling navigation ends the readiness request without stopping the dev process', async () => {
    const item = add({ devCommand: 'sleep 60' });
    const controller = new AbortController();
    const pending = app.fetch(new Request(`http://shelf.test/api/projects/${item.id}/launch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
    }));
    await until(() => app.processes.runtime(item.id).status === 'running');
    controller.abort();
    expect((await pending).status).toBe(408);
    expect(app.processes.active(item.id)).toBe(true);
  });

  test('an already-cancelled open does not start a development command', async () => {
    const item = add();
    const controller = new AbortController();
    controller.abort();
    const response = await app.fetch(new Request(`http://shelf.test/api/projects/${item.id}/launch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
    }));
    expect(response.status).toBe(408);
    expect(app.processes.active(item.id)).toBe(false);
    expect(app.processes.logs(item.id)).toEqual([]);
  });
});
