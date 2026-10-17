import { describe, expect, test } from 'bun:test';
import type { BookmarkSection } from '../shared/browser-bookmarks';
import { addBookmarkColumn, compatibleShelfDrop, moveBookmarkSection, moveColumn, parseColumnLayout, reconcileColumnLayout, reorderVisibleSiblings, type ColumnLayout } from '../src/column-layout';

const sections = (ids: string[]): BookmarkSection[] => ids.map(id => ({ folder: { id, title: id, children: [] }, nodes: [], path: id }));
const web = ['projects-0', 'services-0', 'favorites-0'];

describe('browser-local shelf columns', () => {
  test('defaults put web destinations first and allocate column IDs independent of folders', () => {
    const layout = reconcileColumnLayout(null, web, sections(['a', 'b']), true);
    expect(layout.columns.map(column => column.id)).toEqual(['web:projects-0', 'web:services-0', 'web:favorites-0', 'bookmarks:1']);
    expect(layout.columns.at(-1)?.sectionIds).toEqual(['a', 'b']);
  });

  test('moves sections locally, preserves empty columns, and reorders web columns too', () => {
    const original = reconcileColumnLayout(null, web, sections(['a', 'b']), true);
    let layout = addBookmarkColumn(original);
    layout = moveBookmarkSection(layout, 'a', 'bookmarks:2', 0);
    layout = moveBookmarkSection(layout, 'b', 'bookmarks:2', 0);
    layout = moveColumn(layout, 'web:services-0', 0);
    expect(layout.columns[0]?.id).toBe('web:services-0');
    expect(layout.columns.find(column => column.id === 'bookmarks:1')?.sectionIds).toEqual([]);
    expect(layout.columns.find(column => column.id === 'bookmarks:2')?.sectionIds).toEqual(['b', 'a']);
    expect(original.columns.at(-1)?.sectionIds).toEqual(['a', 'b']);
    expect(moveBookmarkSection(layout, 'a', 'web:projects-0', 0)).toBe(layout);
  });

  test('native reorder/expansion retains manual groups; stale sections are removed and new ones appended', () => {
    const saved: ColumnLayout = { version: 1, columns: [
      { id: 'bookmarks:4', kind: 'bookmarks', sectionIds: ['b', 'a', 'gone'] },
      { id: 'web:services-0', kind: 'web', sectionIds: [] },
    ] };
    const reordered = reconcileColumnLayout(saved, web, sections(['a', 'b', 'new']), true);
    expect(reordered.columns.find(column => column.id === 'bookmarks:4')?.sectionIds).toEqual(['b', 'a']);
    expect(reordered.columns.at(-1)?.sectionIds).toEqual(['new']);
    expect(reordered.columns.filter(column => column.kind === 'web').map(column => column.id)).toEqual(['web:services-0', 'web:projects-0', 'web:favorites-0']);
  });

  test('denied permission, no extension, and transient empty data never erase bookmark grouping', () => {
    const saved = reconcileColumnLayout(null, web, sections(['a', 'b']), true);
    const unavailable = reconcileColumnLayout(saved, web, [], false);
    expect(unavailable).toEqual(saved);
    expect(reconcileColumnLayout(saved, [], [], false)).toEqual(saved);
  });

  test('different Compact/Grid continuation counts cannot erase each other across tabs', () => {
    const compact = reconcileColumnLayout(null, ['projects-0', 'projects-1', 'services-0'], sections(['a']), true);
    const grid = reconcileColumnLayout(compact, ['projects-0', 'services-0'], sections(['a']), true);
    expect(grid).toEqual(compact);
    expect(reconcileColumnLayout(grid, ['projects-0', 'projects-1', 'services-0'], sections(['a']), true)).toEqual(compact);
  });

  test('version checking, deduplication, malformed storage and stale IDs are safe', () => {
    expect(parseColumnLayout({ version: 2, columns: [] })).toBeNull();
    expect(parseColumnLayout({ version: 1, columns: [{ id: 'bad', kind: 'bookmarks', sectionIds: [1] }] })).toBeNull();
    const parsed = parseColumnLayout({ version: 1, columns: [
      { id: 'bookmarks:1', kind: 'bookmarks', sectionIds: ['a', 'a'] },
      { id: 'bookmarks:1', kind: 'bookmarks', sectionIds: ['other'] },
      { id: 'bookmarks:2', kind: 'bookmarks', sectionIds: ['a', 'b'] },
    ] });
    expect(parsed?.columns.map(column => column.sectionIds)).toEqual([['a'], ['b']]);
    expect(reconcileColumnLayout(parsed, [], sections(['b']), true).columns.map(column => column.sectionIds)).toEqual([[], ['b']]);
  });
});

describe('inline native ordering boundaries', () => {
  test('reorders a complete sibling list without mutating the drag-start snapshot', () => {
    const previous = ['a', 'b', 'c'];
    expect(reorderVisibleSiblings(previous, previous, 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(previous).toEqual(['a', 'b', 'c']);
  });

  test('loose root links replace only their visible slots, preserving folder positions', () => {
    expect(reorderVisibleSiblings(['a', 'folder', 'b', 'other-folder', 'c'], ['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'folder', 'a', 'other-folder', 'b']);
    expect(reorderVisibleSiblings(['a', 'b'], ['a', 'missing'], 'a', 'missing')).toBeNull();
    expect(reorderVisibleSiblings(['a', 'b'], ['a', 'a'], 'a', 'b')).toBeNull();
    expect(reorderVisibleSiblings(['a', 'folder', 'b'], ['b', 'a'], 'b', 'a')).toBeNull();
  });

  test('scope allows continuation drops, never other groups/kinds/parents or layout targets', () => {
    const active = { type: 'shelf-item' as const, group: 'favorites', kind: 'project' };
    expect(compatibleShelfDrop(active, { ...active })).toBe(true);
    expect(compatibleShelfDrop(active, { ...active, kind: 'service' })).toBe(false);
    expect(compatibleShelfDrop(active, { ...active, group: 'projects' })).toBe(false);
    expect(compatibleShelfDrop(active, { type: 'shelf-column' })).toBe(false);
    expect(compatibleShelfDrop({ type: 'bookmark-item', parentId: 'a' }, { type: 'bookmark-item', parentId: 'b' })).toBe(false);
    expect(compatibleShelfDrop({ type: 'bookmark-section' }, { type: 'bookmark-column-drop' })).toBe(true);
  });
});
