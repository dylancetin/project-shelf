import { describe, expect, test } from 'bun:test';
import { browserBookmarks } from '../extension/src/bookmarks';
import type { ChromeApi } from '../extension/src/browser';
import { bookmarkColumns, bookmarkFolders, bookmarkSections, bookmarkUrl, findBookmark, searchBookmarks, type BookmarkNode } from '../shared/browser-bookmarks';

function mockBrowser() {
  let nodes: BookmarkNode[] = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id, parentId: '1', url: `https://${id}.test/` }));
  const moves: { id: string; parentId: string; index: number }[] = [];
  const listeners = new Set<() => void>();
  const event = { addListener: (listener: () => void) => listeners.add(listener), removeListener: (listener: () => void) => listeners.delete(listener) };
  let reads = 0;
  let failAt = -1;
  let concurrentAt = -1;
  const api = {
    permissions: { contains: async () => true, request: async () => true, onAdded: event, onRemoved: event },
    bookmarks: {
      getTree: async () => [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: nodes }] }],
      getChildren: async () => {
        if (++reads === concurrentAt) nodes = [...nodes, { id: 'new', title: 'Added elsewhere' }];
        return nodes.map(node => ({ ...node }));
      },
      move: async (id: string, destination: { parentId: string; index: number }) => {
        if (moves.length === failAt) throw new Error('Permission revoked');
        moves.push({ id, ...destination });
        const [node] = nodes.splice(nodes.findIndex(node => node.id === id), 1);
        nodes.splice(destination.index, 0, node!);
        return node;
      },
      onCreated: event, onRemoved: event, onChanged: event, onMoved: event, onChildrenReordered: event, onImportEnded: event,
    },
  } as unknown as ChromeApi;
  return { provider: browserBookmarks(api), moves, listeners, order: () => nodes.map(node => node.id),
    fail: (at: number) => { failAt = at; }, concurrent: (at: number) => { concurrentAt = at; }, managed: () => { nodes[0]!.unmodifiable = 'managed'; } };
}

describe('Chrome-native bookmark ordering', () => {
  test('requests only the optional bookmarks permission, with no server or history access', async () => {
    const requested: unknown[] = [];
    const provider = browserBookmarks({ permissions: {
      contains: async (permission: unknown) => { requested.push(permission); return false; },
      request: async (permission: unknown) => { requested.push(permission); return false; },
    } } as unknown as ChromeApi);
    expect(await provider.hasAccess()).toBe(false);
    expect(await provider.requestAccess()).toBe(false);
    expect(requested).toEqual([{ permissions: ['bookmarks'] }, { permissions: ['bookmarks'] }]);
  });

  test('writes actual same-parent Chrome moves, preserving folder and URL identity', async () => {
    const browser = mockBrowser();
    await browser.provider.reorder('1', ['c', 'a', 'd', 'b'], ['a', 'b', 'c', 'd']);
    expect(browser.order()).toEqual(['c', 'a', 'd', 'b']);
    expect(browser.moves).toEqual([{ id: 'c', parentId: '1', index: 0 }, { id: 'd', parentId: '1', index: 2 }]);
    expect(bookmarkUrl(findBookmark(await browser.provider.getTree(), 'a')!)).toBe('https://a.test/');
  });

  test('rejects browser roots, stale drafts, omitted bookmarks, duplicates and managed folders before any move', async () => {
    const browser = mockBrowser();
    await expect(browser.provider.reorder('0', [], [])).rejects.toThrow('root folders');
    for (const ids of [['a'], ['a', 'a', 'c', 'd'], ['a', 'b', 'c', 'missing']]) {
      await expect(browser.provider.reorder('1', ids, ['a', 'b', 'c', 'd'])).rejects.toThrow('folder changed');
    }
    await expect(browser.provider.reorder('1', ['b', 'a', 'c', 'd'], ['b', 'a', 'c', 'd'])).rejects.toThrow('folder changed');
    browser.managed();
    await expect(browser.provider.reorder('1', ['b', 'a', 'c', 'd'], ['a', 'b', 'c', 'd'])).rejects.toThrow('managed');
    expect(browser.moves).toHaveLength(0);
  });

  test('stops on Chrome errors and concurrent edits, without pretending moves are atomic or rolling back other work', async () => {
    const browser = mockBrowser();
    browser.fail(1);
    await expect(browser.provider.reorder('1', ['d', 'c', 'b', 'a'], ['a', 'b', 'c', 'd'])).rejects.toThrow('Permission revoked');
    expect(browser.order()).toEqual(['d', 'a', 'b', 'c']);
    expect(browser.moves).toHaveLength(1);
    const concurrent = mockBrowser();
    concurrent.concurrent(3);
    await expect(concurrent.provider.reorder('1', ['d', 'c', 'b', 'a'], ['a', 'b', 'c', 'd'])).rejects.toThrow('changed during saving');
    expect(concurrent.order()).toEqual(['d', 'a', 'b', 'c', 'new']);
    expect(concurrent.moves).toHaveLength(1);
  });

  test('unsubscribes browser events on unmount', () => {
    const browser = mockBrowser();
    const unsubscribe = browser.provider.subscribe(() => {});
    expect(browser.listeners.size).toBe(1);
    unsubscribe();
    expect(browser.listeners.size).toBe(0);
  });

  test('searches titles, URLs and nested folder paths; blocks executable bookmark URLs', () => {
    const tree: BookmarkNode[] = [{ id: '1', title: 'Research', children: [{ id: '2', title: 'TypeScript', url: 'https://www.typescriptlang.org/docs/#reference' }, { id: '3', title: 'Unsafe', url: 'javascript:alert(1)' }] }];
    expect(searchBookmarks(tree, 'research docs').map(node => node.id)).toEqual(['2']);
    expect(findBookmark(tree, '2')?.title).toBe('TypeScript');
    expect(bookmarkUrl(tree[0]!.children![0]!)).toBe('https://www.typescriptlang.org/docs/#reference');
    expect(bookmarkUrl(tree[0]!.children![1]!)).toBe('');
    expect(bookmarkUrl({ id: '4', title: 'Data', url: 'data:text/html,unsafe' })).toBe('');
  });
});

test('column sections expose every bookmark once across roots, preserve sibling folders, and pack whole folders together', () => {
  const tree: BookmarkNode[] = [{ id: '0', title: '', children: [
    { id: '1', title: 'Bookmarks bar', children: [
      { id: 'a', title: 'Loose', url: 'https://loose.test' },
      { id: 'work', title: 'Work', children: [{ id: 'b', title: 'Docs', url: 'https://docs.test' }, { id: 'nested', title: 'Nested', children: [{ id: 'c', title: 'Deep', url: 'https://deep.test' }] }] },
      { id: 'read', title: 'Reading', children: [{ id: 'd', title: 'Article', url: 'https://article.test' }] },
    ] },
    { id: '2', title: 'Other bookmarks', children: [{ id: 'e', title: 'Elsewhere', url: 'https://elsewhere.test' }] },
    { id: '3', title: 'Mobile bookmarks', children: [] },
  ] }];
  const sections = bookmarkSections(tree);
  expect(sections.map(section => section.folder.id)).toEqual(['1', 'work', 'read', '2', '3']);
  expect(sections.flatMap(section => searchBookmarks(section.nodes, '').map(node => node.id))).toEqual(['a', 'b', 'c', 'd', 'e']);
  const packed = bookmarkColumns(sections, 8);
  expect(packed.map(column => column.map(section => section.folder.id))).toEqual([['1', 'work'], ['read', '2'], ['3']]);
  expect(bookmarkFolders(tree).map(folder => folder.path)).toContain('Bookmarks bar / Work / Nested');
  expect(bookmarkFolders(tree).some(folder => folder.node.id === '0')).toBe(false);
});
