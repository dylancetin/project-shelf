import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ApiError } from './errors';

/**
 * Cloudflare account settings for persistent tunnels. Kept outside the repository and the
 * database (default `~/.config/project-shelf/cloudflare.json`, mode 0600).
 */
export interface CloudflareConfig {
  /** API token: Account › Cloudflare Tunnel: Edit, Account › Access: Apps and Policies: Edit, Zone › DNS: Edit. */
  apiToken: string;
  accountId: string;
  zoneId: string;
  /** Public hostname pattern; `{name}` becomes three random words, e.g. `{name}-tunnel.taylan.tr`. */
  hostname: string;
  /** Named tunnel the panel creates and owns. Defaults to `project-shelf`. */
  tunnelName?: string;
  /** Tests point this at a fake API. */
  apiBase?: string;
}

export const DEFAULT_CLOUDFLARE_CONFIG = path.join(homedir(), '.config/project-shelf/cloudflare.json');
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validates a config object; throws with the field that is wrong. */
export function cloudflareConfig(value: unknown): CloudflareConfig {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  for (const key of ['apiToken', 'accountId', 'zoneId', 'hostname'] as const) {
    if (typeof input[key] !== 'string' || !input[key]) throw new Error(`Cloudflare config needs a non-empty "${key}"`);
  }
  const hostname = String(input.hostname).toLowerCase();
  const sample = hostname.replace('{name}', 'quiet-amber-falcon');
  if (hostname.split('{name}').length !== 2 || !sample.split('.').every(label => LABEL.test(label)) || sample.split('.').length < 2) {
    throw new Error('Cloudflare config "hostname" must be a DNS name containing {name} once, e.g. {name}-tunnel.example.com');
  }
  const tunnelName = input.tunnelName === undefined ? 'project-shelf' : String(input.tunnelName);
  if (!/^[\w.-]{1,100}$/.test(tunnelName)) throw new Error('Cloudflare config "tunnelName" may only contain letters, digits, ".", "_" and "-"');
  return { apiToken: String(input.apiToken), accountId: String(input.accountId), zoneId: String(input.zoneId), hostname, tunnelName,
    ...(typeof input.apiBase === 'string' ? { apiBase: input.apiBase } : {}) };
}

/** Reads the config file; null when it does not exist. */
export function loadCloudflareConfig(filename = process.env.PANEL_CLOUDFLARE_CONFIG || DEFAULT_CLOUDFLARE_CONFIG): CloudflareConfig | null {
  let text: string;
  try { text = readFileSync(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return cloudflareConfig(JSON.parse(text));
}

/** A hostname's route; a null port answers 503 (used while Cloudflare Access is not enforced yet). */
export interface IngressRule { hostname: string; port: number | null }
export interface DnsRecord { id: string; name: string; type: string; content: string }
export interface AccessApp { id: string; domain: string }

/** The few Cloudflare API calls persistent tunnels need. Every failure is an ApiError (502) naming the step. */
export class CloudflareApi {
  private readonly base: string;
  constructor(readonly config: CloudflareConfig) {
    this.base = (config.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  }

  private async call<T>(step: string, method: string, route: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${route}`, {
        method, signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${this.config.apiToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) { throw new ApiError(502, `Cloudflare could not be reached to ${step}: ${error instanceof Error ? error.message : String(error)}`); }
    const data = await response.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
    if (!response.ok || !data?.success) {
      const reason = data?.errors?.map(item => item.message).filter(Boolean).join('; ') || `HTTP ${response.status}`;
      const error = new ApiError(502, `Cloudflare refused to ${step}: ${reason}`);
      (error as ApiError & { httpStatus?: number }).httpStatus = response.status;
      throw error;
    }
    return data.result as T;
  }
  private account(route: string) { return `/accounts/${encodeURIComponent(this.config.accountId)}${route}`; }
  private zone(route: string) { return `/zones/${encodeURIComponent(this.config.zoneId)}${route}`; }

  /** Finds the named tunnel or creates it as remotely managed (its routes are set through this API). */
  async ensureTunnel(name: string): Promise<string> {
    const found = await this.call<{ id: string; name: string }[]>('list tunnels', 'GET', this.account(`/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`));
    const existing = found.find(item => item.name === name);
    if (existing) return existing.id;
    return (await this.call<{ id: string }>('create the tunnel', 'POST', this.account('/cfd_tunnel'), { name, config_src: 'cloudflare' })).id;
  }
  async tunnelExists(id: string): Promise<boolean> {
    try { return !(await this.call<{ deleted_at?: string | null }>('read the tunnel', 'GET', this.account(`/cfd_tunnel/${encodeURIComponent(id)}`))).deleted_at; }
    catch (error) { if ((error as { httpStatus?: number }).httpStatus === 404) return false; throw error; }
  }
  tunnelToken(id: string): Promise<string> {
    return this.call<string>('read the tunnel token', 'GET', this.account(`/cfd_tunnel/${encodeURIComponent(id)}/token`));
  }
  /** Number of live connector connections. */
  async connections(id: string): Promise<number> {
    const tunnel = await this.call<{ connections?: unknown[] }>('read the tunnel status', 'GET', this.account(`/cfd_tunnel/${encodeURIComponent(id)}`));
    return tunnel.connections?.length ?? 0;
  }
  /**
   * Replaces the tunnel's whole route list. Requests are presented as `localhost` because Vite
   * and similar dev servers only answer known hosts. Unmatched hostnames get a 404.
   */
  async setIngress(id: string, rules: readonly IngressRule[]): Promise<void> {
    await this.call('update the tunnel routes', 'PUT', this.account(`/cfd_tunnel/${encodeURIComponent(id)}/configurations`), { config: {
      ingress: [...rules.map(rule => rule.port === null ? { hostname: rule.hostname, service: 'http_status:503' }
        : { hostname: rule.hostname, service: `http://127.0.0.1:${rule.port}`, originRequest: { httpHostHeader: 'localhost' } }), { service: 'http_status:404' }],
    } });
  }

  async findDns(name: string): Promise<DnsRecord | null> {
    const records = await this.call<DnsRecord[]>('look up DNS', 'GET', this.zone(`/dns_records?name=${encodeURIComponent(name)}`));
    return records.find(record => record.name === name) ?? null;
  }
  createCname(name: string, target: string): Promise<DnsRecord> {
    return this.call<DnsRecord>('create the DNS record', 'POST', this.zone('/dns_records'), { type: 'CNAME', name, content: target, proxied: true, ttl: 1, comment: 'Project Shelf tunnel' });
  }
  async deleteDns(id: string): Promise<void> {
    try { await this.call('delete the DNS record', 'DELETE', this.zone(`/dns_records/${encodeURIComponent(id)}`)); }
    catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 404) throw error; }
  }

  private accessBody(hostname: string, rules: readonly string[]) {
    return {
      type: 'self_hosted', name: `Project Shelf · ${hostname}`, domain: hostname, session_duration: '24h', app_launcher_visible: false,
      policies: [{ name: 'Allowed emails', decision: 'allow', include: rules.map(rule => rule.startsWith('*@')
        ? { email_domain: { domain: rule.slice(2) } } : { email: { email: rule } }) }],
    };
  }
  createAccessApp(hostname: string, rules: readonly string[]): Promise<AccessApp> {
    return this.call<AccessApp>('create the Access application', 'POST', this.account('/access/apps'), this.accessBody(hostname, rules));
  }
  /** Replaces the app's policy; null when the app no longer exists. */
  async updateAccessApp(id: string, hostname: string, rules: readonly string[]): Promise<AccessApp | null> {
    try { return await this.call<AccessApp>('update the Access application', 'PUT', this.account(`/access/apps/${encodeURIComponent(id)}`), this.accessBody(hostname, rules)); }
    catch (error) { if ((error as { httpStatus?: number }).httpStatus === 404) return null; throw error; }
  }
  async findAccessApps(hostname: string): Promise<AccessApp[]> {
    const apps = await this.call<AccessApp[]>('list Access applications', 'GET', this.account(`/access/apps?domain=${encodeURIComponent(hostname)}`));
    return apps.filter(app => app.domain === hostname);
  }
  async deleteAccessApp(id: string): Promise<void> {
    try { await this.call('delete the Access application', 'DELETE', this.account(`/access/apps/${encodeURIComponent(id)}`)); }
    catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 404) throw error; }
  }
}
