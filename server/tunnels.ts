import { connect as tlsConnect } from 'node:tls';
import { MAX_TUNNEL_ALLOWED_EMAILS, tunnelAccessRule, type TunnelState } from '../shared/tunnels';
import { CloudflareApi, type CloudflareConfig } from './cloudflare';
import { ApiError, errorMessage } from './errors';
import type { Store } from './store';
import type { TunnelConnector } from './tunnel-connector';
import { tunnelName } from './tunnel-names';

export interface TunnelOptions {
  /** Cloudflare account settings; without them tunnels are unavailable (503). */
  cloudflare?: CloudflareConfig | null;
  /** Runs cloudflared for the named tunnel. Required with `cloudflare`. */
  connector?: TunnelConnector;
  /** How long opening waits for the connector to reach Cloudflare. */
  readyTimeoutMs?: number;
  pollMs?: number;
  maxTunnels?: number;
  /**
   * Whether Cloudflare Access already guards a hostname (the edge redirects to the Access login).
   * A new Access app takes several seconds to apply; until this passes the hostname answers 503.
   */
  accessProbe?: (hostname: string) => Promise<boolean>;
  /** How long to wait for a new Access app to apply. */
  accessTimeoutMs?: number;
}

/**
 * True when Cloudflare's edge answers `hostname` with a redirect to the Access login. It resolves
 * through Cloudflare's DNS-over-HTTPS and connects to the edge directly (TLS verified for the
 * hostname), so a negative answer cached by the local resolver cannot stall it.
 */
export async function accessEnforced(hostname: string): Promise<boolean> {
  let address: string | undefined;
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    const answer = await response.json() as { Answer?: { type: number; data: string }[] };
    address = answer.Answer?.find(record => record.type === 1)?.data;
  } catch { return false; }
  if (!address) return false;
  const head = await new Promise<string>(resolve => {
    let text = '';
    const socket = tlsConnect({ host: address, port: 443, servername: hostname, timeout: 5000 }, () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: project-shelf-access-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    const done = () => { socket.destroy(); resolve(text); };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { text += chunk; if (text.includes('\r\n\r\n') || text.length > 16384) done(); });
    socket.on('timeout', done); socket.on('error', done); socket.on('close', done);
  });
  const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
  const location = head.match(/\r\nlocation: *([^\r\n]+)/i)?.[1] ?? '';
  return status >= 300 && status < 400 && /^https:\/\/[^/]+\.cloudflareaccess\.com\/cdn-cgi\/access\/login\//.test(location);
}

/** What a tunnel key points at right now; null when its project or preview is gone. */
export type TunnelTarget = { port: number | null; rules: string[] } | null;

interface TunnelRow {
  key: string;
  /** Three words, reserved for this key for as long as its registration exists. */
  name: string;
  hostname: string;
  open: boolean;
  port: number | null;
  /** Access rules currently applied in Cloudflare (empty: public). */
  allowedEmails: string[];
  accessAppId: string | null;
  dnsRecordId: string | null;
  startedAt: string | null;
  error?: string;
}

export const projectTunnel = (id: string) => `project:${id}`;
export const agentTunnel = (id: string) => `agent:${id}`;
const sameRules = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(rule => b.includes(rule));

function normalizeRules(rules: readonly string[]): string[] {
  const normalized = [...new Set(rules.map(rule => tunnelAccessRule(rule)))];
  if (normalized.some(rule => rule === null) || normalized.length > MAX_TUNNEL_ALLOWED_EMAILS) throw new ApiError(400, 'Tunnel access must be email addresses or *@domain rules');
  return normalized as string[];
}

/**
 * Persistent Cloudflare tunnel hostnames. The panel owns one named tunnel; each project or agent
 * preview gets a stable `<three-words>` hostname routed to its local port, a proxied DNS record,
 * and (unless public) a Cloudflare Access application. Everything is stored in SQLite and
 * reconciled with Cloudflare at startup, and cloudflared runs outside the panel process, so open
 * tunnels survive process exits, restarts and panel restarts. Only an explicit close (or deleting
 * the registration) removes one.
 */
export class TunnelManager {
  private rows = new Map<string, TunnelRow>();
  private starting = new Set<string>();
  /** Keys whose new Access app is not enforced yet: their route answers 503 instead of reaching the port. */
  private guarded = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private api: CloudflareApi | null;
  private tunnelId: string | null = null;
  private token: string | null = null;
  private closed = false;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly maxTunnels: number;
  private readonly accessTimeoutMs: number;
  /** Resolves a key to its current port and effective access. Set by the app. */
  target: (key: string) => TunnelTarget = () => null;

  constructor(private store: Store, private options: TunnelOptions = {}) {
    this.api = options.cloudflare ? new CloudflareApi(options.cloudflare) : null;
    if (this.api && !options.connector) throw new Error('A tunnel connector is required with a Cloudflare config');
    this.readyTimeoutMs = options.readyTimeoutMs ?? 45000;
    this.pollMs = options.pollMs ?? 1000;
    this.maxTunnels = options.maxTunnels ?? 25;
    this.accessTimeoutMs = options.accessTimeoutMs ?? 120000;
    store.db.exec('CREATE TABLE IF NOT EXISTS tunnels (key TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    for (const row of store.db.query('SELECT key, data FROM tunnels').all() as { key: string; data: string }[]) {
      this.rows.set(row.key, { ...JSON.parse(row.data), key: row.key });
    }
  }

  get configured() { return this.api !== null; }

  get(key: string): TunnelState | null {
    const row = this.rows.get(key);
    if (!row?.open) return null;
    // A fresh hostname is not published until it is ready: a lookup before its DNS record exists
    // would be cached as nonexistent by the visitor's resolver.
    return { status: this.starting.has(key) || this.guarded.has(key) ? 'starting' : 'running', url: this.starting.has(key) ? null : `https://${row.hostname}`, startedAt: row.startedAt ?? '',
      allowedEmails: [...row.allowedEmails], ...(row.port !== null ? { port: row.port } : {}), ...(row.error ? { error: row.error } : {}) };
  }

  /** Every open tunnel's key. */
  openKeys(): string[] { return [...this.rows.values()].filter(row => row.open).map(row => row.key); }

  private save(row: TunnelRow) {
    const { key, ...data } = row;
    this.store.db.query('INSERT INTO tunnels (key, name, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, data = excluded.data').run(key, row.name, JSON.stringify(data));
    this.rows.set(key, row);
  }
  private remove(key: string) {
    this.store.db.query('DELETE FROM tunnels WHERE key = ?').run(key);
    this.rows.delete(key);
  }

  /** Runs Cloudflare mutations one at a time: the route list is replaced as a whole. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => {}).then(operation);
    this.queue = pending;
    return pending;
  }
  /** Resolves once queued Cloudflare work is done. */
  idle(): Promise<void> { return this.queue.then(() => {}, () => {}); }

  private require(): CloudflareApi {
    if (this.closed) throw new ApiError(503, 'The server is shutting down');
    if (!this.api) throw new ApiError(503, 'Cloudflare tunnels are not configured on this server: add ~/.config/project-shelf/cloudflare.json');
    return this.api;
  }

  private hostnameFor(name: string) { return this.api!.config.hostname.replace('{name}', name); }
  private cname() { return `${this.tunnelId}.cfargotunnel.com`; }

  private async identity(verify = false): Promise<string> {
    const api = this.api!;
    const name = api.config.tunnelName ?? 'project-shelf';
    if (!this.tunnelId) {
      const saved = this.store.getValue<{ id: string; name: string; accountId: string }>('cloudflareTunnel');
      if (saved && saved.name === name && saved.accountId === api.config.accountId) this.tunnelId = saved.id;
    }
    if (this.tunnelId && (!verify || await api.tunnelExists(this.tunnelId))) return this.tunnelId;
    this.tunnelId = await api.ensureTunnel(name);
    this.token = null;
    this.store.setValue('cloudflareTunnel', { id: this.tunnelId, name, accountId: api.config.accountId });
    return this.tunnelId;
  }

  private async connect(): Promise<void> {
    this.token ??= await this.api!.tunnelToken(this.tunnelId!);
    await this.options.connector!.ensure(this.token);
  }

  private async routes(): Promise<void> {
    await this.api!.setIngress(this.tunnelId!, [...this.rows.values()].filter(row => row.open && row.port !== null)
      .map(row => ({ hostname: row.hostname, port: this.guarded.has(row.key) ? null : row.port! })));
  }

  private async ensureDns(row: TunnelRow): Promise<void> {
    const api = this.api!;
    const found = await api.findDns(row.hostname);
    if (found?.type === 'CNAME' && found.content === this.cname()) { row.dnsRecordId = found.id; return; }
    if (found && found.id !== row.dnsRecordId) throw new ApiError(409, `${row.hostname} already has a DNS record that Project Shelf did not create`);
    if (found) await api.deleteDns(found.id); // Ours, but for a tunnel that was replaced.
    row.dnsRecordId = (await api.createCname(row.hostname, this.cname())).id;
  }

  /** Makes Cloudflare Access match `rules`: an app with that allow-list, or no app at all when public. */
  private async applyAccess(row: TunnelRow, rules: string[]): Promise<void> {
    const api = this.api!;
    if (rules.length) {
      const updated = row.accessAppId ? await api.updateAccessApp(row.accessAppId, row.hostname, rules) : null;
      if (!updated) {
        // Adopt an app left behind by an interrupted open instead of creating a duplicate.
        const [existing, ...extra] = await api.findAccessApps(row.hostname);
        for (const app of extra) await api.deleteAccessApp(app.id);
        const adopted = existing ? (await api.updateAccessApp(existing.id, row.hostname, rules))?.id : undefined;
        // A new app is not enforced at once: keep the hostname away from the port until it is.
        if (!adopted) this.guarded.add(row.key);
        row.accessAppId = adopted ?? (await api.createAccessApp(row.hostname, rules)).id;
      }
    } else {
      this.guarded.delete(row.key);
      if (row.accessAppId) await api.deleteAccessApp(row.accessAppId);
      for (const app of await api.findAccessApps(row.hostname)) await api.deleteAccessApp(app.id);
      row.accessAppId = null;
    }
    row.allowedEmails = [...rules];
  }

  /** Removes the hostname from DNS first (unreachable at once), then its route, then its Access app. */
  private async teardown(row: TunnelRow): Promise<void> {
    const api = this.api!;
    const dns = await api.findDns(row.hostname);
    if (dns && (dns.id === row.dnsRecordId || (dns.type === 'CNAME' && dns.content === this.cname()))) await api.deleteDns(dns.id);
    row.dnsRecordId = null;
    const wasOpen = row.open;
    row.open = false;
    try { if (this.tunnelId) await this.routes(); }
    catch (error) { row.open = wasOpen; throw error; }
    if (row.accessAppId) await api.deleteAccessApp(row.accessAppId);
    for (const app of await api.findAccessApps(row.hostname)) await api.deleteAccessApp(app.id);
    row.accessAppId = null;
    row.allowedEmails = [];
    this.guarded.delete(row.key);
  }

  /**
   * Waits until Cloudflare Access guards a newly protected hostname, then routes it to its port.
   * On timeout it stays guarded (503) with an error; opening again retries.
   */
  private async release(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (!row?.open || !this.guarded.has(key)) return;
    const probe = this.options.accessProbe ?? accessEnforced;
    const deadline = Date.now() + this.accessTimeoutMs;
    while (!await probe(row.hostname)) {
      if (Date.now() >= deadline) {
        row.error = `Cloudflare Access did not start protecting ${row.hostname} within ${Math.round(this.accessTimeoutMs / 1000)} seconds, so it answers 503 for now. Apply access to check again.`;
        this.save(row);
        throw new ApiError(504, row.error);
      }
      if (!this.guarded.has(key) || !this.rows.get(key)?.open) return;
      await Bun.sleep(Math.max(this.pollMs, 20) * 2);
    }
    await this.serial(async () => {
      if (!this.guarded.delete(key) || !this.rows.get(key)?.open) return;
      await this.routes();
      const current = this.rows.get(key)!;
      if (current.error?.startsWith('Cloudflare Access did not start')) { delete current.error; this.save(current); }
    });
  }
  /** `release` in the background, for changes that should not wait for Cloudflare Access. */
  private releasing = new Set<string>();
  private releaseLater(key: string) {
    if (this.releasing.has(key)) return;
    this.releasing.add(key);
    void this.release(key).catch(error => console.warn(`Tunnel ${key} stays guarded: ${errorMessage(error)}`)).finally(() => this.releasing.delete(key));
  }

  private async uniqueName(): Promise<string> {
    const taken = new Set([...this.rows.values()].map(row => row.name));
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = tunnelName();
      if (taken.has(name)) continue;
      if (await this.api!.findDns(this.hostnameFor(name))) continue;
      return name;
    }
    throw new ApiError(500, 'Could not find an unused tunnel name');
  }

  /**
   * Opens a key's tunnel to `port`, or, when it is already open, applies the current port and
   * access to it. Resolves once Cloudflare routes traffic to the connector. The hostname is the
   * one this key always had, so a closed and reopened tunnel keeps its link.
   */
  open(key: string, port: number, rules: readonly string[] = []): Promise<TunnelState> {
    const api = this.require();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'A tunnel needs a local port from 1 to 65535');
    const access = normalizeRules(rules);
    const existing = this.rows.get(key);
    if (!existing?.open && this.openKeys().length >= this.maxTunnels) throw new ApiError(429, `At most ${this.maxTunnels} Cloudflare tunnels can be open at once`);
    if (!existing?.open) this.starting.add(key);
    return this.serial(async () => {
      let row = this.rows.get(key);
      const wasOpen = Boolean(row?.open);
      try {
        if (!wasOpen && this.openKeys().length >= this.maxTunnels) throw new ApiError(429, `At most ${this.maxTunnels} Cloudflare tunnels can be open at once`);
        await this.identity();
        if (!row) {
          const name = await this.uniqueName();
          row = { key, name, hostname: this.hostnameFor(name), open: false, port: null, allowedEmails: [], accessAppId: null, dnsRecordId: null, startedAt: null };
        }
        // The hostname pattern may have changed since the name was reserved.
        if (!wasOpen) row.hostname = this.hostnameFor(row.name);
        // Access first, so the hostname is never reachable without the policy it should have.
        if (!wasOpen || !sameRules(row.allowedEmails, access)) await this.applyAccess(row, access);
        const moved = row.port !== port;
        row.port = port;
        row.startedAt = wasOpen ? row.startedAt : new Date().toISOString();
        row.open = true;
        delete row.error;
        // Saved before routing: a crash from here on is finished by the next startup's reconcile.
        this.save(row);
        if (!wasOpen || moved || this.guarded.has(key)) await this.routes();
        await this.ensureDns(row);
        this.save(row);
        await this.connect();
      } catch (error) {
        if (row && !wasOpen) {
          try { await this.teardown(row); } catch (cleanup) { console.warn(`Could not undo a failed tunnel open for ${key}: ${errorMessage(cleanup)}`); }
          row.open = false;
          this.save(row);
        } else if (row) { row.error = errorMessage(error); this.save(row); }
        this.starting.delete(key);
        throw error;
      }
    }).then(async () => {
      try { await this.connected(); await this.release(key); }
      finally { this.starting.delete(key); }
      const state = this.get(key);
      if (!state) throw new ApiError(409, 'The tunnel was closed before it was ready');
      return state;
    });
  }

  private async connected(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (await this.api!.connections(this.tunnelId!) === 0) {
      if (Date.now() >= deadline) throw new ApiError(504, `The Cloudflare connector did not connect within ${Math.round(this.readyTimeoutMs / 1000)} seconds. The tunnel stays open and starts working once it connects; check its journal (journalctl --user -u 'project-shelf-cloudflared*').`);
      await Bun.sleep(this.pollMs);
    }
  }

  /** Explicitly closes a tunnel. Its name stays reserved for the key. Repeated calls are safe. */
  close(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (!row?.open) return Promise.resolve();
    this.require();
    return this.serial(async () => {
      const current = this.rows.get(key);
      if (!current?.open) return;
      await this.identity();
      try { await this.teardown(current); }
      catch (error) { current.error = `Closing failed: ${errorMessage(error)}`; this.save(current); throw error; }
      delete current.error;
      current.startedAt = null;
      this.save(current);
      if (!this.openKeys().length) await this.options.connector!.stop();
    });
  }

  /** Closes a key's tunnel and releases its name, for a deleted project or preview. */
  async forget(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (!row) return;
    if (row.open && !this.api) {
      console.warn(`Forgetting tunnel ${row.hostname} without Cloudflare access; remove its DNS record and Access app by hand`);
    } else if (row.open) await this.close(key);
    this.remove(key);
  }

  /**
   * Applies each open tunnel's current port and effective access (after a project, folder or
   * Settings change) and removes tunnels whose registration is gone. Failures are kept on the
   * tunnel as `error` and retried at the next sync.
   */
  sync(): Promise<void> {
    if (!this.api || this.closed || !this.openKeys().length) return Promise.resolve();
    return this.serial(async () => {
      let rerouted = false;
      for (const key of this.openKeys()) {
        const row = this.rows.get(key)!;
        try {
          const target = this.target(key);
          if (!target) {
            await this.identity();
            await this.teardown(row);
            this.remove(key);
            console.log(`Closed Cloudflare tunnel ${row.hostname}: ${key} no longer exists`);
            continue;
          }
          const rules = normalizeRules(target.rules);
          if (!sameRules(rules, row.allowedEmails)) {
            await this.identity();
            const guarded = this.guarded.has(key);
            await this.applyAccess(row, rules);
            if (this.guarded.has(key) !== guarded) rerouted = true;
          }
          if (target.port !== null && target.port !== row.port) { row.port = target.port; rerouted = true; }
          delete row.error;
        } catch (error) {
          row.error = errorMessage(error);
          console.warn(`Could not update Cloudflare tunnel ${row.hostname}: ${row.error}`);
        }
        this.save(row);
      }
      if (rerouted) {
        try { await this.identity(); await this.routes(); }
        catch (error) { console.warn(`Could not update Cloudflare tunnel routes: ${errorMessage(error)}`); }
      }
      for (const key of this.guarded) this.releaseLater(key);
    }).catch(error => console.warn(`Tunnel sync failed: ${errorMessage(error)}`));
  }

  /**
   * Brings Cloudflare in line with the database at startup: the named tunnel exists, every open
   * tunnel has its route, DNS record and access, and the connector runs (or stops when nothing is
   * open). Never throws; problems are logged and kept on the affected tunnel.
   */
  reconcile(): Promise<void> {
    if (!this.api) return Promise.resolve();
    return this.serial(async () => {
      const open = this.openKeys();
      if (!open.length) { await this.options.connector!.stop(); return; }
      await this.identity(true);
      for (const key of open) {
        const row = this.rows.get(key)!;
        try {
          const target = this.target(key);
          if (!target) { await this.teardown(row); this.remove(key); console.log(`Closed Cloudflare tunnel ${row.hostname}: ${key} no longer exists`); continue; }
          if (target.port !== null) row.port = target.port;
          const rules = normalizeRules(target.rules);
          await this.applyAccess(row, rules);
          await this.ensureDns(row);
          delete row.error;
        } catch (error) { row.error = errorMessage(error); console.warn(`Could not restore Cloudflare tunnel ${row.hostname}: ${row.error}`); }
        this.save(row);
      }
      await this.routes();
      if (this.openKeys().length) await this.connect();
      else await this.options.connector!.stop();
      for (const key of this.guarded) this.releaseLater(key);
    }).catch(error => console.warn(`Could not restore Cloudflare tunnels: ${errorMessage(error)}`));
  }

  /** Panel shutdown: finish queued work. Tunnels and the connector keep running. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.idle();
  }
}
