import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import type { Project } from '../shared/types';
import { activeThreads, cleanup, fakeCloudflared, FakeAgentSupervisor, files, fixture, processAlive, project, request, shellCommand, until } from './helpers';

interface Run { leader: number; child: number; label: string; port: string; apiPort: string }

describe('restarting managed projects (disposable process trees)', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const apiPort = process.env.API_PORT;

  beforeEach(async () => {
    root = await fixture();
    // Each run records itself, then idles with a grandchild in the same process group.
    await files(root, { 'run.js': `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
appendFileSync(${JSON.stringify(path.join(root, 'runs'))}, [process.pid, child.pid, process.argv[2], process.env.PORT, process.env.API_PORT ?? 'unset'].join(' ') + '\\n');
setInterval(() => {}, 1000);` });
    process.env.API_PORT = '4959';
    app = await createApp({
      dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [] }, processOptions: { stopGraceMs: 150 },
      agentSupervisor: new FakeAgentSupervisor(), t3Threads: activeThreads,
      tunnelOptions: { binary: await fakeCloudflared(root), startTimeoutMs: 3000, stopGraceMs: 150 },
    });
  });
  afterEach(async () => {
    await app.close();
    if (apiPort === undefined) delete process.env.API_PORT; else process.env.API_PORT = apiPort;
    await cleanup(root);
  });

  const script = (label: string) => `${shellCommand(path.join(root, 'run.js'))} ${label}`;
  function add(overrides: Parameters<typeof project>[1] = {}) {
    const item = project(root, { port: 6300, devCommand: script('dev'), prodCommand: script('prod'), ...overrides });
    app.store.insert(item);
    return item;
  }
  async function runs(): Promise<Run[]> {
    const text = await readFile(path.join(root, 'runs'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map(line => {
      const [leader, child, label, port, api] = line.split(' ');
      return { leader: Number(leader), child: Number(child), label: label!, port: port!, apiPort: api! };
    });
  }
  const post = (id: string, action: string, value?: unknown, headers?: Record<string, string>) => app.fetch(request(`/api/projects/${id}/${action}`, 'POST', value, headers));
  const state = async (id: string) => ((await (await app.fetch(request('/api/projects'))).json()).projects as Project[]).find(item => item.id === id)!;
  async function runningAs(id: string, mode: 'dev' | 'prod', count: number) {
    await until(async () => (await runs()).length === count && app.processes.runtime(id).status === 'running');
    expect(app.processes.runtime(id).mode).toBe(mode);
    return (await runs()).at(-1)!;
  }

  test('a running project comes back running in a new process group, and the old one is gone when the call returns', async () => {
    const item = add();
    expect((await post(item.id, 'start', { mode: 'dev' })).status).toBe(200);
    const before = await runningAs(item.id, 'dev', 1);
    expect(before).toMatchObject({ label: 'dev', port: '6300', apiPort: 'unset' });

    const response = await post(item.id, 'restart', {});
    expect(response.status).toBe(200);
    const { project: restarted } = await response.json() as { project: Project };
    const pid = restarted.runtime.pid!;
    expect(restarted.runtime.mode).toBe('dev');
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(before.leader);
    // No polling: restart itself must have waited for the whole old group, grandchild included.
    expect(await processAlive(before.leader)).toBe(false);
    expect(await processAlive(before.child)).toBe(false);

    const after = await runningAs(item.id, 'dev', 2);
    expect(after.leader).toBe(pid);
    expect(after).toMatchObject({ port: '6300', apiPort: 'unset' });
    expect(await processAlive(after.leader)).toBe(true);
  });

  test('repeated and concurrent restarts converge on exactly one running tree', async () => {
    const item = add();
    await post(item.id, 'start', { mode: 'dev' });
    await runningAs(item.id, 'dev', 1);
    const responses = await Promise.all([post(item.id, 'restart', {}), post(item.id, 'restart', {}), post(item.id, 'restart')]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    // Runs replaced while still starting are killed before they record themselves, so count launches in the log.
    expect(app.processes.logs(item.id).filter(line => line.text.startsWith('Starting dev')).length).toBe(4);
    const final = app.processes.runtime(item.id).pid!;
    await until(async () => (await runs()).some(run => run.leader === final));
    for (const run of await runs()) {
      if (run.leader === final) continue;
      expect(await processAlive(run.leader)).toBe(false);
      expect(await processAlive(run.child)).toBe(false);
    }
    expect(await processAlive(final)).toBe(true);
  });

  test('restarting a stopped project just starts it in development', async () => {
    const item = add();
    expect((await post(item.id, 'restart')).status).toBe(200);
    await runningAs(item.id, 'dev', 1);
    // A stopped production run is not resumed in production.
    await post(item.id, 'stop', {});
    await post(item.id, 'start', { mode: 'prod' });
    await runningAs(item.id, 'prod', 2);
    await post(item.id, 'stop', {});
    expect((await state(item.id)).runtime).toMatchObject({ status: 'stopped', mode: 'prod' });
    expect((await post(item.id, 'restart', {})).status).toBe(200);
    await runningAs(item.id, 'dev', 3);
  });

  test('keeps the running mode unless one is requested, and prod still builds first', async () => {
    const item = add({ buildCommand: 'echo built >> builds' });
    await post(item.id, 'start', { mode: 'prod' });
    await runningAs(item.id, 'prod', 1);
    expect((await post(item.id, 'restart', {})).status).toBe(200);
    expect((await runningAs(item.id, 'prod', 2)).label).toBe('prod');
    expect((await readFile(path.join(root, 'builds'), 'utf8')).trim().split('\n')).toHaveLength(2);

    expect((await post(item.id, 'restart', { mode: 'dev' })).status).toBe(200);
    expect((await runningAs(item.id, 'dev', 3)).label).toBe('dev');
    expect((await post(item.id, 'restart', { mode: 'prod' })).status).toBe(200);
    expect((await runningAs(item.id, 'prod', 4)).label).toBe('prod');
    expect((await post(item.id, 'restart', {})).status).toBe(200);
    expect((await runningAs(item.id, 'prod', 5)).label).toBe('prod');
  });

  test('a failed production build stops the old run and never starts production', async () => {
    const item = add({ buildCommand: 'echo build-failed >&2; exit 7' });
    await post(item.id, 'start', { mode: 'dev' });
    const before = await runningAs(item.id, 'dev', 1);
    expect((await post(item.id, 'restart', { mode: 'prod' })).status).toBe(200);
    await until(() => !app.processes.active(item.id));
    expect((await state(item.id)).runtime).toMatchObject({ status: 'failed', mode: 'prod', exitCode: 7 });
    expect(await processAlive(before.leader)).toBe(false);
    expect(await runs()).toHaveLength(1);
    // A crashed production run restarts in production rather than silently becoming development.
    expect((await post(item.id, 'restart', {})).status).toBe(200);
    await until(() => !app.processes.active(item.id));
    expect((await state(item.id)).runtime).toMatchObject({ status: 'failed', mode: 'prod', exitCode: 7 });
    expect(await runs()).toHaveLength(1);
  });

  test('closes the Cloudflare tunnel with the old process', async () => {
    const item = add();
    await post(item.id, 'start', { mode: 'dev' });
    await runningAs(item.id, 'dev', 1);
    expect((await post(item.id, 'tunnel', {})).status).toBe(200);
    const launches = (await readFile(path.join(root, 'cloudflared.log'), 'utf8')).trim().split('\n');
    expect(launches).toHaveLength(1);
    const tunnelPid = Number(launches[0]!.split(' ')[0]);
    expect(await processAlive(tunnelPid)).toBe(true);

    const { project: restarted } = await (await post(item.id, 'restart', {})).json() as { project: Project };
    expect(restarted.runtime.tunnel ?? null).toBeNull();
    expect(await processAlive(tunnelPid)).toBe(false);
    await runningAs(item.id, 'dev', 2);
    expect((await state(item.id)).runtime.tunnel ?? null).toBeNull();
  });

  test('rejects bad requests without touching the running process', async () => {
    const item = add();
    await post(item.id, 'start', { mode: 'dev' });
    const before = await runningAs(item.id, 'dev', 1);
    const service = project(root, { kind: 'service', url: 'http://beelinkk:6400/' });
    app.store.insert(service);
    for (const [id, value, status] of [
      [item.id, { mode: 'build' }, 400], [item.id, { mode: 'staging' }, 400], [item.id, { mode: 1 }, 400],
      [item.id, { force: true }, 400], [service.id, {}, 400], ['missing', {}, 404],
    ] as const) {
      expect((await post(id, 'restart', value)).status).toBe(status);
    }
    expect((await app.fetch(request(`/api/projects/${item.id}/restart`, 'GET'))).status).toBe(404);
    expect((await app.fetch(request(`/api/projects/${item.id}/restart`, 'DELETE'))).status).toBe(405);
    expect(app.processes.runtime(item.id).pid).toBe(before.leader);
    expect(await runs()).toHaveLength(1);
  });

  test('keeps the same-origin mutation guard: cross-origin restarts are refused and change nothing', async () => {
    const item = add();
    await post(item.id, 'start', { mode: 'dev' });
    const before = await runningAs(item.id, 'dev', 1);
    const foreign: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
      { Origin: 'http://dev-page.example:5173' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of foreign) {
      const response = await post(item.id, 'restart', {}, headers);
      expect(response.status).toBe(403);
    }
    expect(app.processes.runtime(item.id).pid).toBe(before.leader);
    expect(await runs()).toHaveLength(1);
    // The panel's own origin is still accepted.
    expect((await post(item.id, 'restart', {}, { Origin: 'http://shelf.test', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });
});

describe('restarting agent previews over HTTP', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let supervisor: FakeAgentSupervisor;
  beforeEach(async () => {
    root = await fixture();
    supervisor = new FakeAgentSupervisor();
    app = await createApp({ dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [] }, agentSupervisor: supervisor, t3Threads: activeThreads });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  test('runs the existing in-place restart: same ID, port and URL, one more start', async () => {
    const created = await app.agentServers.add({ name: 'Preview', cwd: root, command: 'fixture', threadId: 'fixture-thread' });
    const response = await app.fetch(request(`/api/agent-servers/${created.id}/restart`, 'POST', {}));
    expect(response.status).toBe(200);
    const { server } = await response.json();
    expect(server).toMatchObject({ id: created.id, port: created.port, url: created.url, unit: created.unit, status: 'running', ready: true });
    expect(server.pid).not.toBe(created.pid);
    expect(supervisor.starts).toBe(2);
    expect((await app.fetch(request(`/api/agent-servers/${created.id}/restart`, 'POST'))).status).toBe(200);
    expect(supervisor.starts).toBe(3);
  });

  test('reports an unknown preview, and refuses cross-origin restarts without restarting', async () => {
    const created = await app.agentServers.add({ name: 'Preview', cwd: root, command: 'fixture', threadId: 'fixture-thread' });
    expect((await app.fetch(request(`/api/agent-servers/${crypto.randomUUID()}/restart`, 'POST', {}))).status).toBe(404);
    const foreign: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Origin: 'http://dev-page.example:5173' }, { 'Sec-Fetch-Site': 'same-site' }];
    for (const headers of foreign) {
      expect((await app.fetch(request(`/api/agent-servers/${created.id}/restart`, 'POST', {}, headers))).status).toBe(403);
    }
    expect(supervisor.starts).toBe(1);
  });
});
