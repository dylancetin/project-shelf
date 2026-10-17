import { bookmarkColumns, type BookmarkSection } from '../shared/browser-bookmarks';
import { moveWithinSubset } from '../shared/ordering';

export interface LayoutColumn {
  /** Independent of the first folder, so moving a folder never renames a column. */
  id: string;
  kind: 'web' | 'bookmarks';
  sectionIds: string[];
}

export interface ColumnLayout { version: 1; columns: LayoutColumn[] }
export const columnLayoutKey = 'project-shelf.columns.v1';
export const webColumnId = (id: string) => `web:${id}`;

export function parseColumnLayout(value: unknown): ColumnLayout | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('columns' in value) || !Array.isArray(value.columns) || value.columns.length > 1000) return null;
  const columns: LayoutColumn[] = [];
  const seenColumns = new Set<string>();
  const seenSections = new Set<string>();
  for (const column of value.columns) {
    if (!column || typeof column !== 'object' || typeof column.id !== 'string' || !column.id || !['web', 'bookmarks'].includes(column.kind) || !Array.isArray(column.sectionIds) || !column.sectionIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) return null;
    if (seenColumns.has(column.id)) continue;
    seenColumns.add(column.id);
    const sectionIds = column.kind === 'bookmarks' ? (column.sectionIds as string[]).filter(id => {
      if (seenSections.has(id)) return false;
      seenSections.add(id); return true;
    }) : [];
    columns.push({ id: column.id, kind: column.kind, sectionIds });
  }
  return { version: 1, columns };
}

export function nextBookmarkColumnId(layout: ColumnLayout): string {
  const ids = new Set(layout.columns.map(column => column.id));
  let index = 1;
  while (ids.has(`bookmarks:${index}`)) ++index;
  return `bookmarks:${index}`;
}

/** A missing/denied/temporarily empty native tree must not erase saved grouping. */
export function reconcileColumnLayout(saved: ColumnLayout | null, webIds: string[], sections: BookmarkSection[], bookmarksReady: boolean): ColumnLayout {
  const web = [...new Set(webIds)].map(webColumnId);
  const sectionIds = new Set(sections.map(section => section.folder.id));
  const normalized = saved && parseColumnLayout(saved);
  // Web continuations can disappear in Grid view or while loading. Retain their
  // placement (and hide them in the view) so Compact/Grid tabs cannot repeatedly
  // delete and recreate each other's saved columns through storage events.
  const columns = normalized ? normalized.columns
    .map(column => ({ ...column, sectionIds: column.sectionIds.filter(id => !bookmarksReady || sectionIds.has(id)) })) : [];
  const missingWeb = web.filter(id => !columns.some(column => column.id === id));
  // Newly appearing web/continuation columns follow the existing web columns.
  const lastWeb = columns.reduce((last, column, index) => column.kind === 'web' ? index : last, -1);
  columns.splice(lastWeb + 1, 0, ...missingWeb.map(id => ({ id, kind: 'web' as const, sectionIds: [] })));
  const placed = new Set(columns.flatMap(column => column.sectionIds));
  if (bookmarksReady) {
    for (const packed of bookmarkColumns(sections.filter(section => !placed.has(section.folder.id)))) {
      const id = nextBookmarkColumnId({ version: 1, columns });
      columns.push({ id, kind: 'bookmarks', sectionIds: packed.map(section => section.folder.id) });
    }
  }
  return { version: 1, columns };
}

export function moveColumn(layout: ColumnLayout, id: string, position: number): ColumnLayout {
  const from = layout.columns.findIndex(column => column.id === id);
  if (from < 0 || !Number.isInteger(position) || position < 0 || position >= layout.columns.length || from === position) return layout;
  const columns = [...layout.columns];
  const [column] = columns.splice(from, 1);
  columns.splice(position, 0, column!);
  return { ...layout, columns };
}

export function addBookmarkColumn(layout: ColumnLayout): ColumnLayout {
  return { ...layout, columns: [...layout.columns, { id: nextBookmarkColumnId(layout), kind: 'bookmarks', sectionIds: [] }] };
}

/** Shelf-only grouping; this never changes a bookmark's native parent. */
export function moveBookmarkSection(layout: ColumnLayout, sectionId: string, columnId: string, position: number): ColumnLayout {
  const source = layout.columns.find(column => column.sectionIds.includes(sectionId));
  const target = layout.columns.find(column => column.id === columnId && column.kind === 'bookmarks');
  if (!source || !target || !Number.isInteger(position)) return layout;
  const remaining = target.sectionIds.filter(id => id !== sectionId);
  const at = Math.max(0, Math.min(position, remaining.length));
  remaining.splice(at, 0, sectionId);
  return { ...layout, columns: layout.columns.map(column => column.id === target.id ? { ...column, sectionIds: remaining } : column.id === source.id ? { ...column, sectionIds: column.sectionIds.filter(id => id !== sectionId) } : column) };
}

/** Replace only visible sibling slots (root loose links can hide folder siblings). */
export function reorderVisibleSiblings(previousIds: string[], visibleIds: string[], activeId: string, overId: string): string[] | null {
  return moveWithinSubset(previousIds, visibleIds, activeId, overId);
}

export type ShelfDragScope =
  | { type: 'shelf-column' }
  | { type: 'bookmark-section' }
  | { type: 'bookmark-column-drop' }
  | { type: 'bookmark-item'; parentId: string }
  | { type: 'shelf-item'; group: string; kind: string };

/** One root context, with no accidental cross-kind or cross-parent mutations. */
export function compatibleShelfDrop(active: ShelfDragScope, over: ShelfDragScope): boolean {
  if (active.type === 'shelf-column') return over.type === 'shelf-column';
  if (active.type === 'bookmark-section') return over.type === 'bookmark-section' || over.type === 'bookmark-column-drop';
  if (active.type === 'bookmark-item') return over.type === 'bookmark-item' && active.parentId === over.parentId;
  if (active.type === 'shelf-item') return over.type === 'shelf-item' && active.group === over.group && active.kind === over.kind;
  return false;
}
