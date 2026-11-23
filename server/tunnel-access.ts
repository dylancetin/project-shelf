import path from 'node:path';
import { MAX_TUNNEL_ALLOWED_EMAILS, TUNNEL_ACCESS_MODES, type TunnelAccess, type TunnelAccessMode, type TunnelAccessRef } from '../shared/tunnels';
import { ApiError } from './errors';
import { inside, locate, owningProjectSync } from './project-owner';

/** The stored fields the resolver reads from a registration. */
export interface AccessEntry {
  id: string;
  name: string;
  kind: string;
  directory: string;
  tunnelAccessMode?: TunnelAccessMode;
  tunnelAllowedEmails?: string[];
}

/** The server-computed, read-only fields a project carries in API responses. */
export interface ProjectAccessFields {
  tunnelAccess?: TunnelAccess;
  tunnelAccessInherited?: TunnelAccess;
  tunnelAccessPeers?: TunnelAccessRef[];
}

/** How the resolver finds a directory's real path and its main Git checkout (memoized filesystem reads by default). */
export interface Locator { (directory: string): { canonical: string; main: string | null } }

const normalize = (directory: string) => path.resolve(directory);
const ref = (entry: AccessEntry): TunnelAccessRef => ({ id: entry.id, name: entry.name });

/**
 * Stored mode for an entry, including rows saved before modes existed: a non-empty list
 * reads as `custom`, anything else as `inherit`. A `custom` mode without rules (only
 * possible through a hand-edited row) reads as `inherit` rather than silently public.
 */
export function storedMode(entry: Pick<AccessEntry, 'tunnelAccessMode' | 'tunnelAllowedEmails'>): TunnelAccessMode {
  const listed = Array.isArray(entry.tunnelAllowedEmails) && entry.tunnelAllowedEmails.length > 0;
  const mode = entry.tunnelAccessMode;
  if (mode === 'custom') return listed ? 'custom' : 'inherit';
  if (mode && TUNNEL_ACCESS_MODES.includes(mode)) return mode;
  return listed ? 'custom' : 'inherit';
}

/**
 * Layered tunnel access. A layer is every project entry registered at one directory.
 * A layer with a `custom` member grants the union of its custom lists; otherwise a
 * `public` member makes it public; otherwise it sets nothing. The nearest layer at or
 * above a directory that sets something decides; a linked Git worktree then continues
 * from its main checkout; then the Settings default applies.
 */
export class TunnelAccessResolver {
  private layers = new Map<string, AccessEntry[]>();
  private directories: string[];

  constructor(private projects: readonly AccessEntry[], private defaultList: readonly string[] = [], private locator: Locator = locate) {
    for (const entry of projects) {
      if (entry.kind !== 'project' || !entry.directory || !path.isAbsolute(entry.directory)) continue;
      const key = normalize(entry.directory);
      const layer = this.layers.get(key);
      if (layer) layer.push(entry); else this.layers.set(key, [entry]);
    }
    // Deepest first.
    this.directories = [...this.layers.keys()].sort((a, b) => b.length - a.length);
  }

  /** The rule one folder layer sets, ignoring `exclude`; null when every member inherits. */
  private layerRule(directory: string, exclude?: string): TunnelAccess | null {
    const members = (this.layers.get(directory) ?? []).filter(entry => entry.id !== exclude);
    const custom = members.filter(entry => storedMode(entry) === 'custom');
    if (custom.length) {
      const allowedEmails = [...new Set(custom.flatMap(entry => entry.tunnelAllowedEmails ?? []))];
      return { source: 'project', from: custom.map(ref), allowedEmails };
    }
    const open = members.filter(entry => storedMode(entry) === 'public');
    return open.length ? { source: 'project', from: open.map(ref), allowedEmails: [] } : null;
  }

  private walk(target: string, exclude?: string): TunnelAccess | null {
    for (const directory of this.directories) {
      if (!inside(target, directory)) continue;
      const rule = this.layerRule(directory, exclude);
      if (rule) return rule;
    }
    return null;
  }

  /** Effective access for a directory (a preview's cwd, or a project folder). */
  resolveDirectory(directory: string, options: { exclude?: string } = {}): TunnelAccess {
    const { canonical, main } = this.locator(directory);
    const target = normalize(canonical);
    const found = this.walk(target, options.exclude) ?? (main ? this.walk(normalize(main), options.exclude) : null);
    if (found) return found;
    return this.defaultList.length
      ? { source: 'default', from: [], allowedEmails: [...this.defaultList] }
      : { source: 'none', from: [], allowedEmails: [] };
  }

  /** Deepest registered project containing a directory, directly or through its main Git checkout. */
  owner(directory: string): TunnelAccessRef | null {
    const project = owningProjectSync(directory, this.projects, path => this.locator(path).canonical, path => this.locator(path).main);
    return project ? ref(project) : null;
  }

  /** Other project entries registered at the same directory. */
  peers(entry: AccessEntry): TunnelAccessRef[] {
    if (!entry.directory) return [];
    return (this.layers.get(normalize(entry.directory)) ?? []).filter(other => other.id !== entry.id).map(ref);
  }

  /** The computed `tunnelAccess*` fields for a registration; services get none. */
  fields(entry: AccessEntry): ProjectAccessFields {
    if (entry.kind !== 'project' || !entry.directory) return {};
    const inherited = this.resolveDirectory(entry.directory, { exclude: entry.id });
    const mode = storedMode(entry);
    const tunnelAccess: TunnelAccess = mode === 'custom' ? { source: 'own', from: [ref(entry)], allowedEmails: [...entry.tunnelAllowedEmails!] }
      : mode === 'public' ? { source: 'own', from: [ref(entry)], allowedEmails: [] }
      : inherited;
    return { tunnelAccess, tunnelAccessInherited: inherited, tunnelAccessPeers: this.peers(entry) };
  }
}

/** The rules a tunnel opened now must use; refuses a combined list Cloudflare would not accept. */
export function tunnelRules(access: TunnelAccess): string[] {
  if (access.allowedEmails.length > MAX_TUNNEL_ALLOWED_EMAILS) {
    const names = access.from.map(entry => entry.name).join(', ');
    throw new ApiError(409, `Tunnel access combines ${access.allowedEmails.length} rules${names ? ` from ${names}` : ''}, but Cloudflare accepts at most ${MAX_TUNNEL_ALLOWED_EMAILS}. Shorten those lists (a *@domain rule covers a whole domain) or set this project's own access.`);
  }
  return access.allowedEmails;
}
