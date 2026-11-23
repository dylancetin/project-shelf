import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSupervisor, UnitState } from '../server/agent-supervisor';
import type { ProjectData } from '../server/store';
import type { T3Threads } from '../server/t3-threads';
import type { AgentServerRecord } from '../shared/agent-servers';

export async function fixture(): Promise<string> {
  await mkdir('/tmp/opencode', { recursive: true });
  return mkdtemp('/tmp/opencode/project-shelf-test-');
}

export async function files(root: string, entries: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(entries)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export const cleanup = (root: string) => rm(root, { recursive: true, force: true });

export function project(directory: string, overrides: Partial<ProjectData> = {}): ProjectData {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name: 'Disposable fixture', description: '', kind: 'project',
    directory, source: 'test', url: '', hostname: '', devCommand: '', buildCommand: '',
    prodCommand: '', port: null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now, ...overrides,
  };
}

export function request(route: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://shelf.test${route}`, {
    method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await Bun.sleep(20);
  }
}

export function shellCommand(filename: string): string {
  return `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(filename)}`;
}

interface FakeApp { id: string; domain: string; rules: string[] }
interface FakeDns { id: string; name: string; type: string; content: string; proxied: boolean }

/**
 * An in-memory stand-in for the Cloudflare API and the cloudflared connector. It keeps tunnels,
 * route lists, DNS records and Access apps, and records every call. `fail` makes a call such as
 * `POST /access/apps` fail; `connect: false` keeps the connector from ever reaching Cloudflare.
 */
export class FakeCloudflare {
  tunnels: { id: string; name: string }[] = [];
  ingress = new Map<string, { hostname?: string; service: string; originRequest?: unknown }[]>();
  dns: FakeDns[] = [];
  apps: FakeApp[] = [];
  calls: string[] = [];
  fail = new Set<string>();
  connect = true;
  /** Hostnames whose Access app the "edge" does not enforce yet; others are enforced as soon as they exist. */
  propagating = new Set<string>();
  enforced(hostname: string) { return Boolean(this.app(hostname)) && !this.propagating.has(hostname); }
  connector = { running: false, token: '', starts: 0, stops: 0,
    ensure: async (token: string) => { if (!this.connector.running || this.connector.token !== token) this.connector.starts++; this.connector.running = true; this.connector.token = token; },
    stop: async () => { if (this.connector.running) this.connector.stops++; this.connector.running = false; } };
  private server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => this.handle(request) });
  private next = 1;

  get config() {
    return { apiToken: 'fixture-token', accountId: 'acct', zoneId: 'zone', hostname: '{name}-tunnel.example.com', apiBase: `http://127.0.0.1:${this.server.port}/client/v4` };
  }
  /** Options for createApp: real TunnelManager, fake Cloudflare. */
  options(extra: Record<string, unknown> = {}) {
    return { cloudflare: this.config, connector: this.connector, readyTimeoutMs: 1500, pollMs: 20, accessProbe: async (hostname: string) => this.enforced(hostname), ...extra };
  }
  /** The single route list of the panel's tunnel, without the 404 catch-all. */
  routes() {
    const id = this.tunnels[0]?.id;
    return (id ? this.ingress.get(id) ?? [] : []).filter(rule => rule.hostname).map(rule => ({ hostname: rule.hostname!, service: rule.service }));
  }
  app(hostname: string) { return this.apps.find(app => app.domain === hostname) ?? null; }
  record(hostname: string) { return this.dns.find(record => record.name === hostname) ?? null; }
  stop() { this.server.stop(true); }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace('/client/v4', '').replace('/accounts/acct', '').replace('/zones/zone', '');
    const step = `${request.method} ${route.replace(/\/(?:fixture\d{8}|[0-9a-f-]{36})(?=\/|$)/g, '/:id')}`;
    this.calls.push(step);
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const fail = (status: number, message: string) => Response.json({ success: false, errors: [{ code: 1, message }], result: null }, { status });
    if (request.headers.get('authorization') !== 'Bearer fixture-token') return fail(403, 'bad token');
    if (this.fail.has(step)) return fail(500, `fixture failure for ${step}`);
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json() as Record<string, any>;
    const id = () => `fixture${String(this.next++).padStart(8, '0')}`;
    let match: RegExpMatchArray | null;
    if (route === '/cfd_tunnel' && request.method === 'GET') return ok(this.tunnels.filter(item => item.name === url.searchParams.get('name')));
    if (route === '/cfd_tunnel' && request.method === 'POST') { const tunnel = { id: crypto.randomUUID(), name: body!.name }; this.tunnels.push(tunnel); return ok(tunnel); }
    if ((match = route.match(/^\/cfd_tunnel\/([\w-]+)$/))) {
      const tunnel = this.tunnels.find(item => item.id === match![1]);
      return tunnel ? ok({ ...tunnel, connections: this.connect && this.connector.running ? [{ id: 'c1' }] : [] }) : fail(404, 'tunnel not found');
    }
    if ((match = route.match(/^\/cfd_tunnel\/([\w-]+)\/token$/))) return ok(`fixture-tunnel-token-${match[1]}`);
    if ((match = route.match(/^\/cfd_tunnel\/([\w-]+)\/configurations$/))) { this.ingress.set(match[1]!, body!.config.ingress); return ok({}); }
    if (route === '/dns_records' && request.method === 'GET') return ok(this.dns.filter(record => record.name === url.searchParams.get('name')));
    if (route === '/dns_records' && request.method === 'POST') { const record = { id: id(), name: body!.name, type: body!.type, content: body!.content, proxied: body!.proxied }; this.dns.push(record); return ok(record); }
    if ((match = route.match(/^\/dns_records\/([\w-]+)$/)) && request.method === 'DELETE') {
      const before = this.dns.length; this.dns = this.dns.filter(record => record.id !== match![1]);
      return before === this.dns.length ? fail(404, 'record not found') : ok({ id: match[1] });
    }
    const rules = (input: Record<string, any>) => (input.policies[0].include as Record<string, any>[]).map(item => item.email ? item.email.email : `*@${item.email_domain.domain}`);
    if (route === '/access/apps' && request.method === 'GET') return ok(this.apps.filter(app => app.domain === url.searchParams.get('domain')));
    if (route === '/access/apps' && request.method === 'POST') { const app = { id: id(), domain: body!.domain, rules: rules(body!) }; this.apps.push(app); return ok(app); }
    if ((match = route.match(/^\/access\/apps\/([\w-]+)$/))) {
      const app = this.apps.find(item => item.id === match![1]);
      if (!app) return fail(404, 'app not found');
      if (request.method === 'PUT') { app.rules = rules(body!); return ok(app); }
      if (request.method === 'DELETE') { this.apps = this.apps.filter(item => item !== app); return ok({ id: app.id }); }
    }
    return fail(404, `fixture has no route ${step}`);
  }
}

export async function processAlive(pid: number): Promise<boolean> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

/** An in-memory stand-in for systemd: units are "running" from start until stop. */
export class FakeAgentSupervisor implements AgentSupervisor {
  units = new Map<string, UnitState>();
  starts = 0;
  async start(record: AgentServerRecord) {
    this.starts++;
    this.units.set(record.unit, { status: 'running', pid: 1000 + this.starts, controlGroup: '/fixture', diagnostic: 'running' });
  }
  async state(record: AgentServerRecord): Promise<UnitState> {
    return this.units.get(record.unit) ?? { status: 'stopped', pid: null, controlGroup: '', diagnostic: 'missing' };
  }
  async ready() { return true; }
  async logs() { return 'fixture stdout'; }
  async stop(record: AgentServerRecord) { this.units.delete(record.unit); }
}

/** Every thread ID is an active top-level thread. */
export const activeThreads: T3Threads = {
  lookup: ids => new Map(ids.map(id => [id, { id, rootId: id, title: 'Fixture thread', status: 'active', link: null }])),
};
