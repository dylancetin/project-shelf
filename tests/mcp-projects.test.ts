import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LogLine, Project } from '../shared/types';
import { createApp } from '../server/app';
import { cleanup, files, fixture, project, request, shellCommand, until } from './helpers';

describe('registered projects through the official MCP HTTP client', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let http: ReturnType<typeof Bun.serve>;
  let client: Client;

  beforeEach(async () => {
    root = await fixture();
    app = await createApp({ dbPath: `${root}/panel.sqlite`, bootstrap: false,
      processOptions: { stopGraceMs: 100, maxLogLines: 12, maxLineLength: 64 } });
    http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    client = new Client({ name: 'project-tools-fixture', version: '1' });
    const { bearerToken } = await Bun.file(`${root}/panel.sqlite.mcp.json`).json();
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
    }));
  });

  afterEach(async () => {
    await client.close();
    await http.stop(true);
    await app.close();
    await cleanup(root);
  });

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, text: content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
  }

  function data<T>(result: { isError: boolean; text: string }): T {
    expect(result.isError).toBe(false);
    return JSON.parse(result.text) as T;
  }

  const list = async () => data<{ projects: Project[] }>(await tool('projects_list')).projects;
  const logs = async (id: string) => data<{ logs: LogLine[] }>(await tool('project_logs', { id })).logs;

  test('list and logs expose saved entries without discovery or command execution', async () => {
    expect(await list()).toEqual([]);
    const item = project(root, { name: 'Hidden project', hidden: true, devCommand: 'touch unexpected.txt' });
    const service = project('', { name: 'Service link', kind: 'service', url: 'http://localhost:9000/' });
    app.store.insert(item);
    app.store.insert(service);
    const response = await app.fetch(request('/api/projects'));
    expect(await list()).toEqual((await response.json()).projects);
    expect(await list()).toContainEqual(expect.objectContaining({ ...item, runtime: expect.objectContaining({ status: 'stopped' }) }));
    expect(await logs(item.id)).toEqual([]);
    expect(await Bun.file(`${root}/unexpected.txt`).exists()).toBe(false);
  });

  test('concurrent runs start once, share dashboard runtime, and return bounded stream-aware logs', async () => {
    await files(root, { 'dev.js': 'for (let i = 0; i < 30; i++) console.log("x".repeat(100)); console.log("fixture stdout"); console.error("fixture stderr"); setInterval(() => {}, 1000);' });
    const item = project(root, { devCommand: shellCommand(`${root}/dev.js`) });
    app.store.insert(item);
    const results = await Promise.all([tool('project_run', { id: item.id }), tool('project_run', { id: item.id })]);
    expect(results.filter(result => !result.isError)).toHaveLength(1);
    expect(results.find(result => result.isError)?.text).toContain('already has a managed command');
    expect(data<{ project: Project }>(results.find(result => !result.isError)!).project.runtime.mode).toBe('dev');
    await until(async () => (await logs(item.id)).some(line => line.stream === 'stderr' && line.text === 'fixture stderr'));
    const current = (await list())[0]!;
    expect(current.runtime).toMatchObject({ status: 'running', mode: 'dev', pid: expect.any(Number) });
    expect((await app.fetch(request(`/api/projects/${item.id}/start`, 'POST', { mode: 'dev' }))).status).toBe(409);
    const lines = await logs(item.id);
    expect(lines).toEqual((await (await app.fetch(request(`/api/projects/${item.id}/logs`))).json()).logs);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.every(line => line.text.length <= 64 && Number.isFinite(Date.parse(line.timestamp)))).toBe(true);
    expect(lines.some(line => line.stream === 'stdout' && line.text === 'fixture stdout')).toBe(true);
    expect(lines.every((line, index) => index === 0 || line.id > lines[index - 1]!.id)).toBe(true);
    expect((await app.fetch(request(`/api/projects/${item.id}/stop`, 'POST'))).status).toBe(200);
    expect((await list())[0]!.runtime).toMatchObject({ status: 'stopped', pid: null });
  });

  test('build and production modes preserve build ordering and expose failed builds without running production', async () => {
    const item = project(root, { buildCommand: 'echo build >> order.txt', prodCommand: 'echo prod >> order.txt' });
    app.store.insert(item);
    data(await tool('project_run', { id: item.id, mode: 'build' }));
    await until(() => !app.processes.active(item.id));
    expect(await Bun.file(`${root}/order.txt`).text()).toBe('build\n');
    data(await tool('project_run', { id: item.id, mode: 'prod' }));
    await until(() => !app.processes.active(item.id));
    expect(await Bun.file(`${root}/order.txt`).text()).toBe('build\nbuild\nprod\n');
    app.store.update({ ...item, buildCommand: 'echo build-failed >&2; exit 7' });
    data(await tool('project_run', { id: item.id, mode: 'prod' }));
    await until(() => !app.processes.active(item.id));
    expect((await list())[0]!.runtime).toMatchObject({ status: 'failed', mode: 'prod', exitCode: 7 });
    expect(await logs(item.id)).toContainEqual(expect.objectContaining({ stream: 'stderr', text: 'build-failed' }));
    expect(await Bun.file(`${root}/order.txt`).text()).toBe('build\nbuild\nprod\n');
  });

  test('invalid IDs, modes, services, and missing commands report tool errors without launching', async () => {
    const item = project(root);
    const service = project(root, { kind: 'service', url: 'http://localhost:9000/', devCommand: 'touch unexpected.txt' });
    app.store.insert(item);
    app.store.insert(service);
    for (const [name, args, message] of [
      ['project_run', { id: crypto.randomUUID() }, 'Project not found'],
      ['project_logs', { id: crypto.randomUUID() }, 'Project not found'],
      ['project_run', { id: service.id }, 'Services are links'],
      ['project_run', { id: item.id }, 'No dev command'],
      ['project_run', { id: item.id, mode: 'restart' }, 'Invalid arguments'],
      ['project_run', {}, 'Invalid arguments'],
      ['project_logs', { id: '' }, 'Invalid arguments'],
    ] as const) {
      const result = await tool(name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
    }
    expect((await list()).every(entry => entry.runtime.status === 'stopped')).toBe(true);
    expect(await logs(item.id)).toEqual([]);
    expect(await Bun.file(`${root}/unexpected.txt`).exists()).toBe(false);
  });

  test('MCP run waits for dashboard deletion and cannot start a removed registration', async () => {
    const item = project(root, { devCommand: 'touch unexpected.txt; exec sleep 60' });
    app.store.insert(item);
    const originalStop = app.processes.stop.bind(app.processes);
    let enteredStop = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.processes.stop = async id => { enteredStop = true; await gate; return originalStop(id); };
    const deletion = app.fetch(request(`/api/projects/${item.id}`, 'DELETE'));
    let running: ReturnType<typeof tool> | undefined;
    try {
      await until(() => enteredStop);
      running = tool('project_run', { id: item.id });
      // The pending deletion owns the mutation lock while the MCP request arrives.
      await Bun.sleep(50);
      expect(app.processes.active(item.id)).toBe(false);
    } finally { release(); }
    expect((await deletion).status).toBe(200);
    const result = await running!;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Project not found');
    expect(await list()).toEqual([]);
    expect(await Bun.file(`${root}/unexpected.txt`).exists()).toBe(false);
  });
});
