import type { Project, Settings } from '../shared/types';
import { DEFAULT_SEARCH_ENGINE, isSearchEngine } from '../shared/search';
import { shelfPlatform } from './platform';

export const snapshotKey = 'project-shelf.snapshot.v1';
type SavedProject = Omit<Project, 'runtime'>;
export interface ShelfSnapshot { version: 1; projects: SavedProject[]; settings: Settings | null; savedAt: string }
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;

export function unknownRuntime(projects: SavedProject[]): Project[] {
  return projects.map(project => ({ ...project, runtime: { status: 'unknown', mode: null, pid: null, startedAt: null, exitCode: null } }));
}

function validProject(value: unknown): value is SavedProject {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['id', 'name', 'description', 'directory', 'source', 'url', 'hostname', 'devCommand', 'buildCommand', 'prodCommand', 'logo', 'createdAt', 'updatedAt'].every(key => typeof item[key] === 'string')
    && ['project', 'service'].includes(String(item.kind))
    && typeof item.hidden === 'boolean' && typeof item.favorite === 'boolean'
    && (item.port === null || (Number.isInteger(item.port) && Number(item.port) > 0 && Number(item.port) <= 65535));
}

function validSettings(value: unknown): value is Settings | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Settings;
  return Array.isArray(item.roots) && item.roots.every(root => typeof root === 'string')
    && Array.isArray(item.hostnames) && item.hostnames.every(host => typeof host === 'string')
    && typeof item.defaultHostname === 'string' && (item.lastScanAt === null || typeof item.lastScanAt === 'string')
    && (item.defaultSearchEngine === undefined || isSearchEngine(item.defaultSearchEngine));
}

export function readSnapshot(storage?: StorageAccess): ShelfSnapshot | null {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(shelfPlatform().snapshotKey ?? snapshotKey) || 'null');
    if (value?.version !== 1 || !Array.isArray(value.projects) || !value.projects.every(validProject)
      || !validSettings(value.settings) || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) return null;
    if (value.settings) value.settings = { ...value.settings, defaultSearchEngine: value.settings.defaultSearchEngine ?? DEFAULT_SEARCH_ENGINE };
    return value;
  } catch { return null; } // Private browsing, corrupt data, and disabled storage are recoverable.
}

export function saveSnapshot(projects: Project[], settings: Settings | null, storage?: StorageAccess): string | null {
  const savedAt = new Date().toISOString();
  const snapshot: ShelfSnapshot = { version: 1, projects: projects.map(({ runtime: _, ...project }) => project), settings, savedAt };
  try { (storage ?? localStorage).setItem(shelfPlatform().snapshotKey ?? snapshotKey, JSON.stringify(snapshot)); return savedAt; }
  catch { return null; } // Full storage must not break the live shelf.
}
