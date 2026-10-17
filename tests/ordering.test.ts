import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
import { moveItem, moveWithinSubset } from '../shared/ordering';
import { cleanup, fixture, project, request } from './helpers';

describe('persistent shelf ordering', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    root = await fixture();
    app = await createApp({ dbPath: path.join(root, 'panel.sqlite'), bootstrap: false });
    for (const [id, name, kind, hidden] of [['p1', 'Alpha', 'project', false], ['p2', 'Zulu', 'project', true], ['s1', 'Archive', 'service', false], ['s2', 'Storage', 'service', false]] as const) {
      app.store.insert(project(root, { id, name, kind, hidden, favorite: id === 'p1' }));
    }
  });
  afterEach(async () => { await app.close(); await cleanup(root); });
  const order = (kind: 'project' | 'service') => app.store.list().filter(item => item.kind === kind).map(item => item.id);
  const reorder = (kind: string, ids: string[], previousIds: string[]) => app.fetch(request('/api/projects/reorder', 'POST', { kind, ids, previousIds }));

  test('orders full collections independently, persists after restart, appends new entries, and preserves metadata', async () => {
    expect((await reorder('project', ['p2', 'p1'], ['p1', 'p2'])).status).toBe(200);
    expect(order('service')).toEqual(['s1', 's2']);
    expect((await reorder('service', ['s2', 's1'], ['s1', 's2'])).status).toBe(200);
    const response = await (await app.fetch(request('/api/projects'))).json();
    expect(response.projects.map((item: { id: string }) => item.id)).toEqual(['p2', 'p1', 's2', 's1']);
    expect(app.store.get('p2')?.hidden).toBe(true);
    expect(app.store.get('p1')?.favorite).toBe(true);
    await app.close();
    app = await createApp({ dbPath: path.join(root, 'panel.sqlite'), bootstrap: false });
    expect(order('project')).toEqual(['p2', 'p1']);
    expect(order('service')).toEqual(['s2', 's1']);
    app.store.insert(project(root, { id: 'p3', name: 'A new entry' }));
    expect(order('project')).toEqual(['p2', 'p1', 'p3']);
    app.store.remove('p2');
    expect(order('project')).toEqual(['p1', 'p3']);
    app.store.update({ ...app.store.get('p1')!, kind: 'service' });
    expect(order('service')).toEqual(['s2', 's1', 'p1']);
  });

  test('rejects filtered, duplicate, foreign, stale, or concurrently edited orders without changing anything', async () => {
    for (const ids of [['p1'], ['p1', 'p1'], ['p2', 'missing'], ['s1', 'p1']]) {
      expect((await reorder('project', ids, ['p1', 'p2'])).status).toBe(409);
      expect(order('project')).toEqual(['p1', 'p2']);
    }
    expect((await reorder('project', ['p2', 'p1'], ['p2', 'p1'])).status).toBe(409);
    expect((await reorder('project', ['p2', 'p1'], ['p1', 'p2'])).status).toBe(200);
    expect((await reorder('project', ['p1', 'p2'], ['p1', 'p2'])).status).toBe(409);
    app.store.insert(project(root, { id: 'p3', name: 'Added elsewhere' }));
    expect((await reorder('project', ['p1', 'p2'], ['p2', 'p1'])).status).toBe(409);
    expect(order('project')).toEqual(['p2', 'p1', 'p3']);
  });

  test('validates payloads and retains same-origin mutation protection', async () => {
    for (const input of [{}, { kind: 'bookmark', ids: [], previousIds: [] }, { kind: 'project', ids: [null], previousIds: [] }, { kind: 'project', ids: [], previousIds: 'bad' }, { kind: 'project', ids: [], previousIds: [], other: true }]) {
      expect((await app.fetch(request('/api/projects/reorder', 'POST', input))).status).toBe(400);
    }
    expect((await app.fetch(request('/api/projects/reorder', 'POST', { kind: 'project', ids: ['p2', 'p1'], previousIds: ['p1', 'p2'] }, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(order('project')).toEqual(['p1', 'p2']);
  });
});

test('move operations insert rather than swap, with cancel-safe immutable input', () => {
  const input = ['a', 'b', 'c', 'd'];
  expect(moveItem(input, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  expect(moveItem(input, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  expect(moveItem(input, -1, 2)).toBe(input);
  expect(moveItem(input, 0, 10)).toBe(input);
  expect(input).toEqual(['a', 'b', 'c', 'd']);
});

test('inline ordering preserves hidden, favorite and unconfigured slots and includes every registration', () => {
  const all = ['hidden', 'one', 'favorite', 'two', 'no-address', 'three'];
  const next = moveWithinSubset(all, ['one', 'two', 'three'], 'three', 'one');
  expect(next).toEqual(['hidden', 'three', 'favorite', 'one', 'no-address', 'two']);
  expect(all).toEqual(['hidden', 'one', 'favorite', 'two', 'no-address', 'three']);
  expect(moveWithinSubset(all, ['one', 'two', 'three'], 'one', 'three')).toEqual(['hidden', 'two', 'favorite', 'three', 'no-address', 'one']);
  expect(moveWithinSubset(all, ['one', 'two', 'three'], 'two', 'two')).toEqual(all);
  expect(moveWithinSubset(all, ['one', 'missing'], 'one', 'missing')).toBeNull();
  expect(moveWithinSubset(all, ['three', 'two', 'one'], 'three', 'one')).toBeNull();
  expect(moveWithinSubset(all, ['one', 'one'], 'one', 'one')).toBeNull();
  expect(moveWithinSubset(all, ['one', 'two'], 'hidden', 'one')).toBeNull();
  expect(moveWithinSubset(['one', 'one'], ['one'], 'one', 'one')).toBeNull();
});
