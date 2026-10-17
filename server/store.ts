import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Project, ProjectKind, Settings } from '../shared/types';
import { sameMembers } from '../shared/ordering';
import { DEFAULT_SEARCH_ENGINE, isSearchEngine } from '../shared/search';
import { ApiError } from './errors';

export type ProjectData = Omit<Project, 'runtime'>;
export const DEFAULT_ROOTS = ['/home/taytay/.t3/projects', '/home/taytay/.t3-nightly/projects', '/home/taytay/workspace'];
export const DEFAULT_HOSTNAMES = ['beelinkk', '192.168.1.50', 'beelinkk.tail750ac6.ts.net', '100.119.176.63'];

function readProject(row: { data: string }): ProjectData {
  // Existing registrations predate visibility preferences and remain visible.
  return { hidden: false, ...JSON.parse(row.data) } as ProjectData;
}

export class Store {
  readonly db: Database;

  constructor(filename: string, initialSettings: Partial<Settings> = {}) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        url TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_directory ON projects(directory);
      CREATE INDEX IF NOT EXISTS projects_url ON projects(url);
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (!this.getValue('settings')) {
      this.setValue('settings', {
        roots: [...DEFAULT_ROOTS], hostnames: [...DEFAULT_HOSTNAMES], defaultHostname: 'beelinkk',
        defaultSearchEngine: DEFAULT_SEARCH_ENGINE, lastScanAt: null, ...initialSettings,
      } satisfies Settings);
    }
  }

  list(): ProjectData[] {
    const projects = (this.db.query('SELECT data FROM projects ORDER BY rowid').all() as { data: string }[])
      .map(readProject);
    const order = this.getValue<Partial<Record<ProjectKind, string[]>>>('destinationOrder') ?? {};
    const ranks = {
      project: new Map((order.project ?? []).map((id, index) => [id, index])),
      service: new Map((order.service ?? []).map((id, index) => [id, index])),
    };
    return projects.sort((a, b) => a.kind.localeCompare(b.kind)
      || (ranks[a.kind].get(a.id) ?? Infinity) - (ranks[b.kind].get(b.id) ?? Infinity)
      || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  reorder(kind: ProjectKind, ids: string[], previousIds: string[]): void {
    const current = this.list().filter(project => project.kind === kind).map(project => project.id);
    if (!sameMembers(current, ids) || !current.every((id, index) => id === previousIds[index]) || current.length !== previousIds.length) {
      throw new ApiError(409, 'This collection changed. Close Organize and reopen it to load the latest order.');
    }
    const order = this.getValue<Partial<Record<ProjectKind, string[]>>>('destinationOrder') ?? {};
    this.setValue('destinationOrder', { ...order, [kind]: ids });
  }

  get(id: string): ProjectData | null {
    const row = this.db.query('SELECT data FROM projects WHERE id = ?').get(id) as { data: string } | null;
    return row ? readProject(row) : null;
  }

  byDirectory(directory: string): ProjectData | null {
    const row = this.db.query("SELECT data FROM projects WHERE directory = ? AND kind = 'project' LIMIT 1").get(directory) as { data: string } | null;
    return row ? readProject(row) : null;
  }

  byUrl(url: string): ProjectData | null {
    const row = this.db.query('SELECT data FROM projects WHERE url = ? LIMIT 1').get(url) as { data: string } | null;
    return row ? readProject(row) : null;
  }

  insert(data: ProjectData): ProjectData {
    this.db.query('INSERT INTO projects (id, directory, url, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, data.directory, data.url, data.kind, JSON.stringify(data));
    return data;
  }

  update(data: ProjectData): ProjectData {
    this.db.query('UPDATE projects SET directory = ?, url = ?, kind = ?, data = ? WHERE id = ?')
      .run(data.directory, data.url, data.kind, JSON.stringify(data), data.id);
    return data;
  }

  remove(id: string): void {
    this.db.query('DELETE FROM projects WHERE id = ?').run(id);
  }

  getValue<T>(key: string): T | null {
    const row = this.db.query('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | null;
    return row ? JSON.parse(row.value) as T : null;
  }

  setValue(key: string, value: unknown): void {
    this.db.query('INSERT INTO preferences(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  settings(): Settings {
    const settings = this.getValue<Settings>('settings')!;
    // Older databases gain the new default without rewriting other preferences.
    return { ...settings, defaultSearchEngine: isSearchEngine(settings.defaultSearchEngine) ? settings.defaultSearchEngine : DEFAULT_SEARCH_ENGINE };
  }

  close(): void {
    this.db.close();
  }
}
