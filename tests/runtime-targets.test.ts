import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../server/app';
import type { AgentServer } from '../shared/agent-servers';
import { resolveRuntimeTargets, type RuntimeTarget, type RuntimeTargetInput, type RuntimeTargetsResponse } from '../shared/runtime-targets';
import type { Project, RunStatus } from '../shared/types';
import { activeThreads, cleanup, FakeAgentSupervisor, fixture, project, request, until } from './helpers';

const HOSTNAMES = ['beelinkk', '192.168.1.50', 'devbox.lan'];
const PANEL: RuntimeTargetInput['panel'] = { port: 4958, origins: ['http://beelinkk:4958', 'https://panel.tail750ac6.ts.net'] };

function registered(name: string, overrides: Partial<Project> = {}, status: RunStatus = 'stopped'): Project {
  return {
    ...project('/tmp/opencode/runtime-targets-fixture', { name }),
    runtime: { status, mode: status === 'running' || status === 'starting' ? 'dev' : null, pid: null, startedAt: null, exitCode: null },
    ...overrides,
  };
}

function preview(name: string, port: number, status: AgentServer['status'] = 'running'): AgentServer {
  return {
    id: crypto.randomUUID(), machineId: 'machine', name, cwd: '/tmp/opencode/runtime-targets-fixture', command: 'fixture', port,
    unit: `project-shelf-agent-${name}.service`, createdAt: '2026-01-01T00:00:00.000Z', requestKey: name, machine: 'beelinkk', pid: 1, status,
    ready: status === 'running', url: `http://beelinkk:${port}/`, logsUrl: `/api/agent-servers/${name}/logs`, diagnostic: '', thread: null, tunnel: null,
  };
}

const resolve = (page: string, projects: Project[], agentServers: AgentServer[] = [], panel = PANEL) =>
  resolveRuntimeTargets(new URL(page), { projects, agentServers, hostnames: HOSTNAMES, panel });
const names = (targets: RuntimeTarget[]) => targets.map(target => target.kind === 'project' ? target.project.name : target.server.name);

describe('resolving a browser URL to registered runtimes', () => {
  test('matches a server alias on the project port, whatever the path, query and fragment', () => {
    const web = registered('web', { port: 6100 });
    for (const page of ['http://beelinkk:6100/', 'http://192.168.1.50:6100/app?x=1#section', 'http://devbox.lan:6100/', 'http://localhost:6100/', 'http://127.0.0.1:6100/', 'http://[::1]:6100/', 'http://BEELINKK:6100/']) {
      expect(names(resolve(page, [web]))).toEqual(['web']);
    }
  });

  test('does not match another host, another port, or a service', () => {
    const web = registered('web', { port: 6100 });
    expect(resolve('http://example.com:6100/', [web])).toEqual([]);
    expect(resolve('http://beelinkk:6101/', [web])).toEqual([]);
    expect(resolve('ftp://beelinkk:6100/', [web])).toEqual([]);
    const bookmark = registered('docs', { kind: 'service', port: 6100, url: 'http://beelinkk:6100/' });
    expect(resolve('http://beelinkk:6100/', [bookmark])).toEqual([]);
    expect(resolve('http://beelinkk:6100/', [registered('no port', { port: null })])).toEqual([]);
  });

  test('uses the scheme default port when the address has none', () => {
    const secure = registered('secure', { port: 443 });
    expect(names(resolve('https://beelinkk/', [secure]))).toEqual(['secure']);
    expect(resolve('http://beelinkk/', [secure])).toEqual([]);
    expect(names(resolve('http://beelinkk/', [registered('plain', { port: 80 })]))).toEqual(['plain']);
  });

  test('matches a reverse-proxy address by origin, including a hostname override', () => {
    const proxied = registered('proxied', { port: 3000, url: 'https://app.tail750ac6.ts.net/dashboard' });
    expect(names(resolve('https://app.tail750ac6.ts.net/other/page?x=1', [proxied]))).toEqual(['proxied']);
    expect(resolve('http://app.tail750ac6.ts.net/', [proxied])).toEqual([]);
    expect(resolve('https://another.tail750ac6.ts.net/', [proxied])).toEqual([]);
    const renamed = registered('renamed', { port: 3000, url: 'http://localhost:3000/', hostname: 'workstation' });
    expect(names(resolve('http://workstation:3000/', [renamed]))).toEqual(['renamed']);
    expect(resolve('http://workstation:3001/', [renamed])).toEqual([]);
  });

  test('matches agent previews by alias and port only', () => {
    const server = preview('agent', 5123);
    expect(resolve('http://beelinkk:5123/', [], [server])).toEqual([{ kind: 'agent', server }]);
    expect(resolve('http://example.com:5123/', [], [server])).toEqual([]);
    expect(resolve('http://beelinkk:5124/', [], [server])).toEqual([]);
  });

  test('lists active runtimes before inactive ones when registrations share a port, keeping a stable order', () => {
    const projects = [
      registered('stopped one', { port: 5123 }), registered('running', { port: 5123 }, 'running'),
      registered('failed', { port: 5123 }, 'failed'), registered('starting', { port: 5123 }, 'starting'),
      registered('stopping', { port: 5123 }, 'stopping'), registered('elsewhere', { port: 5999 }, 'running'),
    ];
    const agents = [preview('old preview', 5123, 'stopped'), preview('live preview', 5123, 'running')];
    expect(names(resolve('http://beelinkk:5123/', projects, agents))).toEqual([
      'running', 'starting', 'live preview', 'stopped one', 'failed', 'stopping', 'old preview',
    ]);
    expect(names(resolve('http://beelinkk:5123/', projects, agents))).toEqual(names(resolve('http://beelinkk:5123/', projects, agents)));
  });

  test('never resolves the panel itself, even with a project registered on its port', () => {
    const shelf = registered('shelf', { port: 4958, url: 'https://panel.tail750ac6.ts.net/' }, 'running');
    expect(resolve('http://beelinkk:4958/#manage', [shelf], [preview('agent', 4958)])).toEqual([]);
    expect(resolve('http://192.168.1.50:4958/', [shelf])).toEqual([]);
    expect(resolve('https://panel.tail750ac6.ts.net/', [shelf])).toEqual([]);
    expect(names(resolve('http://beelinkk:4959/', [{ ...shelf, port: 4959 }]))).toEqual(['shelf']);
    expect(names(resolve('http://beelinkk:4958/', [shelf], [], { port: null, origins: [] }))).toEqual(['shelf']);
  });
});

describe('GET /api/runtime-targets', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    root = await fixture();
    app = await createApp({
      dbPath: ':memory:', bootstrap: false, initialSettings: { roots: [] }, processOptions: { stopGraceMs: 100 },
      agentSupervisor: new FakeAgentSupervisor(), t3Threads: activeThreads,
    });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  const targets = async (page: string, env?: { port: number }): Promise<RuntimeTargetsResponse> => {
    const response = await app.fetch(request(`/api/runtime-targets?url=${encodeURIComponent(page)}`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  };

  test('rejects a missing, malformed, or non-http(s) URL with an actionable error', async () => {
    for (const route of ['/api/runtime-targets', '/api/runtime-targets?url=', '/api/runtime-targets?url=not%20a%20url',
      '/api/runtime-targets?url=beelinkk%3A5173', `/api/runtime-targets?url=${encodeURIComponent('javascript:alert(1)')}`,
      `/api/runtime-targets?url=${encodeURIComponent('ftp://beelinkk:21/')}`, `/api/runtime-targets?url=${encodeURIComponent('file:///etc/passwd')}`]) {
      const response = await app.fetch(request(route));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining('url') });
    }
  });

  test('returns projects and previews with the same runtime fields as their list endpoints, active first', async () => {
    const stopped = project(root, { name: 'Stopped', port: 6200 });
    const live = project(root, { name: 'Live', port: 6200, devCommand: 'exec sleep 60' });
    const service = project(root, { name: 'Bookmark', kind: 'service', url: 'http://beelinkk:6200/' });
    for (const item of [stopped, live, service]) app.store.insert(item);
    await app.processes.start(live, 'dev');
    await until(() => app.processes.runtime(live.id).status === 'running');
    const added = await app.agentServers.add({ name: 'Preview', cwd: root, command: 'fixture', threadId: 'fixture-thread' });
    app.store.insert(project(root, { name: 'Shares the preview port', port: added.port }));

    const result = await targets('http://beelinkk:6200/some/page?x=1');
    expect(result.targets.map(target => target.kind === 'project' ? target.project.name : target.server.name)).toEqual(['Live', 'Stopped']);
    const listed = (await (await app.fetch(request('/api/projects'))).json()).projects as Project[];
    for (const target of result.targets) {
      if (target.kind === 'project') expect(target.project).toEqual(listed.find(item => item.id === target.project.id)!);
    }
    expect(result.targets[0]).toMatchObject({ project: { runtime: { status: 'running', mode: 'dev', pid: expect.any(Number) } } });

    const shared = await targets(`http://192.168.1.50:${added.port}/`);
    const listedServers = (await (await app.fetch(request('/api/agent-servers'))).json()).servers as AgentServer[];
    expect(shared.targets).toHaveLength(2);
    expect(shared.targets[0]).toEqual({ kind: 'agent', server: listedServers[0]! });
    expect(shared.targets[1]).toMatchObject({ kind: 'project', project: { name: 'Shares the preview port' } });
    expect(await targets('http://example.com:6200/')).toEqual({ targets: [] });
  });

  test('resolves nothing for the panel’s own page, by listener port or request origin', async () => {
    app.store.insert(project(root, { name: 'The panel', port: 4958, url: 'http://shelf.test/' }));
    expect(await targets('http://beelinkk:4958/', { port: 4958 })).toEqual({ targets: [] });
    expect((await targets('http://beelinkk:4958/')).targets).toHaveLength(1);
    expect(await targets('http://shelf.test/manage')).toEqual({ targets: [] });
  });
});
