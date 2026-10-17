import { describe, expect, test } from 'bun:test';
import type { Project, Settings } from '../shared/types';
import { project } from './helpers';
import { readSnapshot, saveSnapshot, snapshotKey, unknownRuntime } from '../src/offline';

const settings: Settings = { roots: ['/tmp/opencode'], hostnames: ['shelf.test'], defaultHostname: 'shelf.test', defaultSearchEngine: 'duckduckgo', lastScanAt: null };
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function runningProject(): Project {
  return { ...project('/tmp/opencode/fixture', { favorite: true, hidden: true, url: 'https://shelf.test:6123/path?q=1#part' }), runtime: { status: 'running', mode: 'dev', pid: 12345, startedAt: new Date().toISOString(), exitCode: null } };
}

describe('offline shelf snapshots', () => {
  test('persists real destinations and edits, never process state, and restores unknown status', () => {
    const store = storage();
    const live = runningProject();
    const savedAt = saveSnapshot([live], settings, store);
    const raw = JSON.parse(store.getItem(snapshotKey)!);
    expect(raw.projects[0]).not.toHaveProperty('runtime');
    const snapshot = readSnapshot(store)!;
    expect(snapshot.savedAt).toBe(savedAt!);
    expect(snapshot.settings).toEqual(settings);
    const restored = unknownRuntime(snapshot.projects);
    expect(restored[0]).toMatchObject({ id: live.id, favorite: true, hidden: true, url: live.url, runtime: { status: 'unknown', mode: null, pid: null, startedAt: null, exitCode: null } });
    expect(live.runtime.status).toBe('running');
    saveSnapshot([], settings, store);
    expect(readSnapshot(store)?.projects).toEqual([]);
  });

  test('blocked/full storage cannot break the live shelf', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota exceeded'); } };
    expect(readSnapshot(blocked)).toBeNull();
    expect(saveSnapshot([runningProject()], settings, blocked)).toBeNull();
    const store = storage();
    expect(readSnapshot(store)).toBeNull();
    store.setItem(snapshotKey, '{broken');
    expect(readSnapshot(store)).toBeNull();
  });

  test('retains the chosen search engine offline and upgrades older snapshots without losing destinations', () => {
    const store = storage();
    const live = runningProject();
    saveSnapshot([live], { ...settings, defaultSearchEngine: 'brave' }, store);
    expect(readSnapshot(store)?.settings?.defaultSearchEngine).toBe('brave');
    const raw = JSON.parse(store.getItem(snapshotKey)!);
    delete raw.settings.defaultSearchEngine;
    store.setItem(snapshotKey, JSON.stringify(raw));
    const migrated = readSnapshot(store)!;
    expect(migrated.settings?.defaultSearchEngine).toBe('duckduckgo');
    expect(migrated.projects[0].id).toBe(live.id);
    raw.settings.defaultSearchEngine = 'https://evil.test/search';
    store.setItem(snapshotKey, JSON.stringify(raw));
    expect(readSnapshot(store)).toBeNull();
  });

  test('rejects incompatible or corrupt cached data rather than crashing the launcher', () => {
    const store = storage();
    saveSnapshot([runningProject()], settings, store);
    const raw = JSON.parse(store.getItem(snapshotKey)!);
    for (const value of [
      { ...raw, version: 2 }, { ...raw, savedAt: 'invalid' }, { ...raw, settings: { roots: null } },
      { ...raw, projects: [null] }, { ...raw, projects: [{ ...raw.projects[0], name: 23 }] },
      { ...raw, projects: [{ ...raw.projects[0], port: -1 }] },
    ]) {
      store.setItem(snapshotKey, JSON.stringify(value));
      expect(readSnapshot(store)).toBeNull();
    }
  });
});
