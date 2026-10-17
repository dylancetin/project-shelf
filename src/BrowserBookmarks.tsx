import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowsDownUp, Bookmarks, CaretRight, DotsSixVertical, Folder, FolderOpen, Plus, X } from '@phosphor-icons/react';
import { bookmarkFolders, bookmarkSections, bookmarkUrl, findBookmark, searchBookmarks, type BookmarkNode, type BookmarkSection } from '../shared/browser-bookmarks';
import { errorMessage } from './api';
import { ErrorNotice, IconButton, Spinner } from './components';
import { BookmarkIcon, BookmarkIconProvider, BookmarkIconTools } from './BookmarkIcons';
import { OrganizeDialog } from './OrganizeDialog';
import { addBookmarkColumn, columnLayoutKey, compatibleShelfDrop, moveBookmarkSection, moveColumn, parseColumnLayout, reconcileColumnLayout, reorderVisibleSiblings, webColumnId, type ColumnLayout, type LayoutColumn, type ShelfDragScope } from './column-layout';
import type { ShelfColumn } from './shelf-columns';
import type { useBookmarks } from './useBookmarks';
import './bookmarks.css';

const openKey = 'project-shelf.bookmark-open-folders.v1';
const newColumnId = 'new-bookmark-column';
const columnDragId = (id: string) => `column:${id}`;
const sectionDragId = (id: string) => `section:${id}`;
const bookmarkDragId = (id: string) => `bookmark:${id}`;

type DragData = ShelfDragScope & { name?: string; columnId?: string; sectionId?: string; visibleIds?: string[] };
interface DragSnapshot { tree: BookmarkNode[]; layout: ColumnLayout; data: DragData; parentId?: string; previousIds?: string[]; visibleIds?: string[] }

function readLayout(): ColumnLayout | null {
  try { return parseColumnLayout(JSON.parse(localStorage.getItem(columnLayoutKey) ?? 'null')); }
  catch { return null; }
}

function focusSectionControl(id: string, control: 'handle' | 'column') {
  window.requestAnimationFrame(() => {
    const attribute = `data-section-${control}`;
    Array.from(document.querySelectorAll<HTMLElement>(`[${attribute}]`)).find(element => element.getAttribute(attribute) === id)?.focus();
  });
}

const shelfCollisions: CollisionDetection = args => {
  const data = args.active.data.current as DragData | undefined;
  if (!data) return [];
  const droppableContainers = args.droppableContainers.filter(container => {
    const target = container.data.current as DragData | undefined;
    return target && compatibleShelfDrop(data, target);
  });
  const scoped = { ...args, droppableContainers };
  // Handles drop where the pointer is, never at an unrelated nearby list.
  return args.pointerCoordinates ? pointerWithin(scoped) : closestCenter(scoped);
};

/** Unlike the default sortable keyboard sensor, this also visits empty columns. */
const shelfKeyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) return;
  event.preventDefault();
  const { active, collisionRect, droppableContainers, droppableRects, over } = context;
  const data = active?.data.current as DragData | undefined;
  if (!active || !data || !collisionRect) return;
  const origin = (over && droppableRects.get(over.id)) || collisionRect;
  const center = { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 };
  let best: { x: number; y: number; score: number } | undefined;
  for (const container of droppableContainers.getEnabled()) {
    const target = container.data.current as DragData | undefined;
    const rect = droppableRects.get(container.id);
    if (container.id === over?.id || (!over && container.id === active.id) || !target || !rect || !compatibleShelfDrop(data, target)) continue;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const dx = x - center.x, dy = y - center.y;
    const horizontal = event.code === 'ArrowLeft' || event.code === 'ArrowRight';
    const forward = event.code === 'ArrowLeft' ? -dx : event.code === 'ArrowRight' ? dx : event.code === 'ArrowUp' ? -dy : dy;
    if (forward <= 2) continue;
    const score = forward + Math.abs(horizontal ? dy : dx) * 3;
    if (!best || score < best.score) best = { x, y, score };
  }
  return best ? { x: currentCoordinates.x + best.x - collisionRect.left - collisionRect.width / 2, y: currentCoordinates.y + best.y - collisionRect.top - collisionRect.height / 2 } : undefined;
};

function readOpenFolders(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(openKey) ?? 'null');
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
  } catch { return null; }
}

export function BrowserBookmarks({ bookmarks, query, shelfColumns = [], children, onReorderShelfItem }: { bookmarks: ReturnType<typeof useBookmarks>; query: string; shelfColumns?: ShelfColumn[]; children?: ReactNode; onReorderShelfItem?: (activeId: string, overId: string) => Promise<void> }) {
  const { provider, tree, granted, loading, error, refresh, connect } = bookmarks;
  const searching = Boolean(query.trim());
  const [savedLayout, setSavedLayout] = useState(readLayout);
  const [arrange, setArrange] = useState(false);
  const arranging = arrange && !searching;
  const [frozenTree, setFrozenTree] = useState<BookmarkNode[] | null>(null);
  const [frozenLayout, setFrozenLayout] = useState<ColumnLayout | null>(null);
  const displayedTree = frozenTree ?? tree;
  const sections = useMemo(() => bookmarkSections(displayedTree), [displayedTree]);
  const folders = useMemo(() => bookmarkFolders(displayedTree), [displayedTree]);
  const results = useMemo(() => searching ? searchBookmarks(displayedTree, query) : [], [displayedTree, query, searching]);
  const bookmarksReady = granted && !loading && !error && tree.length > 0 && sections.length > 0;
  const webIds = shelfColumns.map(column => column.id);
  const reconciledLayout = useMemo(() => reconcileColumnLayout(savedLayout, webIds, sections, bookmarksReady), [savedLayout, webIds.join('\0'), sections, bookmarksReady]);
  const layout = frozenLayout ?? reconciledLayout;
  const sectionsById = new Map(sections.map(section => [section.folder.id, section]));
  const webById = new Map(shelfColumns.map(column => [webColumnId(column.id), column]));
  const visibleColumns = layout.columns.filter(column => column.kind === 'web' ? webById.has(column.id) : provider && granted && !searching && (bookmarksReady || frozenTree) && (arranging || column.sectionIds.some(id => sectionsById.has(id))));
  const bookmarkColumns = visibleColumns.filter(column => column.kind === 'bookmarks');
  const [savedOpen, setSavedOpen] = useState(readOpenFolders);
  const open = useMemo(() => new Set(savedOpen ?? sections.map(section => section.folder.id)), [savedOpen, sections]);
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const snapshot = useRef<DragSnapshot | null>(null);
  const externalLayout = useRef<{ value: ColumnLayout | null } | null>(null);
  const suppressClick = useRef(false);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: shelfKeyboardCoordinates }));

  function persist(next: ColumnLayout | null) {
    setSavedLayout(next);
    try {
      if (next) localStorage.setItem(columnLayoutKey, JSON.stringify(next)); else localStorage.removeItem(columnLayoutKey);
      setStorageNotice('');
    } catch { setStorageNotice('Shelf layout works in this tab, but browser storage could not save it.'); }
  }
  function applyExternalLayout() {
    if (!externalLayout.current) return false;
    setSavedLayout(externalLayout.current.value); externalLayout.current = null;
    setAnnouncement('Shelf layout updated in another tab.');
    return true;
  }
  // Reconciliation is safe only with a real native tree, never a permission error.
  useEffect(() => {
    if (!savedLayout || searching || dragging || nativeBusy || JSON.stringify(layout) === JSON.stringify(savedLayout)) return;
    persist(layout);
  }, [layout, savedLayout, searching, dragging, nativeBusy]);
  useEffect(() => {
    if (!granted || !tree.length) return;
    try { localStorage.setItem(openKey, JSON.stringify([...open])); }
    catch { /* Disclosure buttons also work without storage. */ }
  }, [savedOpen, granted, tree]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
      if (event.key === openKey) setSavedOpen(readOpenFolders());
      if (event.key !== columnLayoutKey && event.key !== null) return;
      let next: ColumnLayout | null = null;
      if (event.newValue !== null && event.key !== null) {
        try { next = parseColumnLayout(JSON.parse(event.newValue)); } catch { return; }
        if (!next) return;
      }
      if (snapshot.current) externalLayout.current = { value: next };
      else setSavedLayout(next);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function toggle(id: string) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSavedOpen([...next]);
  }
  function startDrag({ active }: DragStartEvent) {
    const data = active.data.current as DragData | undefined;
    if (!data || searching || nativeBusy) return;
    const parent = data.type === 'bookmark-item' ? findBookmark(tree, data.parentId) : undefined;
    snapshot.current = { tree, layout, data, parentId: parent?.id, previousIds: parent?.children?.map(node => node.id), visibleIds: data.visibleIds && [...data.visibleIds] };
    setFrozenTree(tree); setFrozenLayout(layout); setDragging(true); setMoveError(''); suppressClick.current = true;
  }
  function finishDrag() {
    snapshot.current = null; setFrozenTree(null); setFrozenLayout(null); setDragging(false);
    applyExternalLayout();
    // A pointer release after dragging a handle must not open a nearby link.
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  }
  async function endDrag({ active, over, activatorEvent }: DragEndEvent) {
    const original = snapshot.current;
    const data = original?.data;
    const target = over?.data.current as DragData | undefined;
    if (!original || !data || !over || !target || !compatibleShelfDrop(data, target) || active.id === over.id || searching) { finishDrag(); setAnnouncement('No change to the order.'); return; }
    if ((data.type === 'shelf-column' || data.type === 'bookmark-section') && externalLayout.current) {
      finishDrag(); setAnnouncement('Layout changed in another tab. Your drag was cancelled; try again.'); return;
    }
    try {
      if (data.type === 'shelf-column' && data.columnId && target.columnId) {
        persist(moveColumn(original.layout, data.columnId, original.layout.columns.findIndex(column => column.id === target.columnId)));
        setAnnouncement(`${data.name || 'Column'} moved.`);
      } else if (data.type === 'bookmark-section' && data.sectionId && target.columnId) {
        let next = original.layout;
        const columnId = target.columnId === newColumnId ? (next = addBookmarkColumn(next)).columns.at(-1)!.id : target.columnId;
        const destination = next.columns.find(column => column.id === columnId);
        if (!destination) return;
        let position = destination.sectionIds.filter(id => id !== data.sectionId).length;
        if (target.type === 'bookmark-section' && target.sectionId) {
          const targetIndex = destination.sectionIds.indexOf(target.sectionId);
          // Within a column, dropping on a sibling has normal sortable semantics.
          position = targetIndex;
        }
        persist(moveBookmarkSection(next, data.sectionId, columnId, position));
        setAnnouncement(`${data.name || 'Folder'} moved on this shelf. Chrome folders were not changed.`);
        if (activatorEvent instanceof KeyboardEvent) focusSectionControl(data.sectionId, 'handle');
      } else if (data.type === 'bookmark-item' && original.parentId && original.previousIds && original.visibleIds && provider && granted) {
        const ids = reorderVisibleSiblings(original.previousIds, original.visibleIds, String(active.id).replace(/^bookmark:/, ''), String(over.id).replace(/^bookmark:/, ''));
        if (!ids || ids.every((id, index) => id === original.previousIds![index])) return;
        setNativeBusy(true);
        try { await provider.reorder(original.parentId, ids, original.previousIds); setAnnouncement(`${data.name || 'Bookmark'} reordered in Chrome.`); }
        catch (error) { setMoveError(`${errorMessage(error)} Chrome may have applied some moves. No moves were rolled back. Check bookmark access and review the current Chrome order before trying again.`); }
        finally { await refresh(); setNativeBusy(false); }
      } else if (data.type === 'shelf-item' && onReorderShelfItem) {
        setNativeBusy(true);
        try {
          await onReorderShelfItem(String(active.id).replace(/^entry:/, ''), String(over.id).replace(/^entry:/, ''));
          setAnnouncement(`${data.name || 'Destination'} reordered.`);
        } finally { setNativeBusy(false); }
      }
    } catch (error) { setMoveError(errorMessage(error)); }
    finally { finishDrag(); }
  }
  function moveSection(sectionId: string, columnId: string, position: number) {
    let next = layout;
    if (columnId === newColumnId) { next = addBookmarkColumn(next); columnId = next.columns.at(-1)!.id; }
    persist(moveBookmarkSection(next, sectionId, columnId, position));
    setAnnouncement(`${sectionsById.get(sectionId)?.folder.title || 'Folder'} moved on this shelf. Chrome folders were not changed.`);
    focusSectionControl(sectionId, 'column');
  }
  const organizer = organizeId ? findBookmark(displayedTree, organizeId) : undefined;
  const locked = searching || nativeBusy || dragging;
  const columnLabel = (column: LayoutColumn) => {
    const web = webById.get(column.id);
    return web ? `${web.title}${web.continued ? ' continued' : ''}` : `Bookmark column ${bookmarkColumns.findIndex(candidate => candidate.id === column.id) + 1}`;
  };
  return <BookmarkIconProvider provider={provider?.favicons} tree={displayedTree}>
    {(shelfColumns.length > 0 || provider) && <div className="shelf-layout-tools">
      <button className="text-button" aria-pressed={arranging} disabled={searching || nativeBusy || dragging} onClick={() => setArrange(value => !value)}><ArrowsDownUp size={13} />{arranging ? 'Done arranging' : 'Arrange shelf'}</button>
      {arranging && <>
        <span>Drag columns or folders. Layout stays in this browser; Chrome folders stay intact.</span>
        {provider && granted && <button className="text-button" disabled={locked} onClick={() => { persist(addBookmarkColumn(layout)); setAnnouncement('Empty bookmark column added.'); }}><Plus size={13} />Add column</button>}
        <button className="text-button" disabled={locked} onClick={() => { persist(null); setAnnouncement('Automatic shelf layout restored. Chrome bookmark order was not changed.'); }}>Reset layout</button>
      </>}
      {searching && <span>Clear search to rearrange.</span>}
    </div>}
    {arranging && <p className="shelf-arrange-help">Handles: Space to pick up, arrow keys to move between columns, Space to drop, Escape to cancel. Or use the column and position controls.</p>}
    <div className="sr-only" role="status" aria-live="polite">{nativeBusy ? 'Saving order…' : announcement}</div>
    <DndContext sensors={sensors} collisionDetection={shelfCollisions} onDragStart={startDrag} onDragEnd={event => void endDrag(event)} onDragCancel={() => { finishDrag(); setAnnouncement('Move cancelled. Nothing was changed.'); }} accessibility={{ screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to move, including left and right between eligible columns. Press Space to drop or Escape to cancel.' }, announcements: {
      onDragStart: ({ active }) => `Picked up ${active.data.current?.name || 'item'}.`,
      onDragOver: ({ over }) => over ? `Over ${over.data.current?.name || 'an eligible position'}.` : 'Not over an eligible drop target.',
      onDragEnd: ({ over }) => over ? 'Dropped.' : 'Move cancelled.',
      onDragCancel: () => 'Move cancelled.',
    } }}>
    <div className={`launcher-groups shelf-layout-groups${provider ? ' launcher-mixed-groups' : ''}${arranging ? ' is-arranging' : ''}`} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}>
      {children}
      <SortableContext items={visibleColumns.map(column => columnDragId(column.id))} strategy={rectSortingStrategy}>
      {visibleColumns.map((column, index) => <ShelfLayoutColumn key={column.id} column={column} title={columnLabel(column)} index={index} count={visibleColumns.length} arranging={arranging} disabled={searching || nativeBusy} onPosition={position => {
        const target = visibleColumns[position];
        if (target) { persist(moveColumn(layout, column.id, layout.columns.findIndex(candidate => candidate.id === target.id))); setAnnouncement(`${columnLabel(column)} moved to column ${position + 1}.`); }
      }} onRemove={() => persist({ ...layout, columns: layout.columns.filter(candidate => candidate.id !== column.id) })}>
        {column.kind === 'web' ? <>
          <div className="launcher-group-heading"><h2>{webById.get(column.id)!.title}{webById.get(column.id)!.continued && <span className="launcher-continued">continued</span>}</h2>{webById.get(column.id)!.actions}</div>
          {webById.get(column.id)!.content}
        </> : <>
          <SortableContext items={column.sectionIds.filter(id => sectionsById.has(id)).map(sectionDragId)} strategy={verticalListSortingStrategy}>
            {column.sectionIds.map(id => {
              const section = sectionsById.get(id);
              return section && <BookmarkFolderSection key={id} section={section} column={column} columns={bookmarkColumns} arranging={arranging} disabled={searching || nativeBusy} open={open} onToggle={toggle} onOrganize={setOrganizeId} tree={displayedTree} onMove={moveSection} />;
            })}
          </SortableContext>
          {arranging && <SectionDropZone columnId={column.id} name={`End of ${columnLabel(column)}`} empty={!column.sectionIds.length} />}
        </>}
      </ShelfLayoutColumn>)}
      </SortableContext>
      {arranging && provider && granted && <SectionDropZone columnId={newColumnId} name="New bookmark column" empty />}
      {provider && (!granted ? <section className="bookmark-column bookmark-connect" aria-labelledby="bookmark-connect-title">
        <h2 id="bookmark-connect-title"><Bookmarks size={15} />Browser bookmarks</h2>
        <p>Your saved folders and links, in compact columns. They stay in this browser.</p>
        <button className="button" disabled={loading} onClick={() => void connect()}>{loading ? <Spinner size={14} /> : <Bookmarks size={14} />}Show browser bookmarks</button>
      </section> : searching ? results.length ? Array.from({ length: Math.ceil(results.length / 24) }, (_, index) => <section className="bookmark-column" key={`results-${index}`} aria-label="Matching bookmarks">
        <h2 className="bookmark-results-heading"><Bookmarks size={14} />Bookmarks{index === 0 && <span>{results.length} found</span>}</h2>
        <ul className="bookmark-tree">{results.slice(index * 24, (index + 1) * 24).map(node => <li key={node.id}><BookmarkLink node={node} path={node.path} /></li>)}</ul>
      </section>) : <p className="bookmark-column bookmarks-empty">No matching bookmarks.</p> : null)}
    </div>
    </DndContext>
    {provider && <div className="bookmark-tools">
      <span className="bookmark-local-label"><Bookmarks size={13} />This browser only</span>
      {granted && <>
        <label className="bookmark-organize-select"><ArrowsDownUp size={13} /><span className="sr-only">Organize bookmark folder</span><select aria-label="Organize bookmark folder" value="" disabled={locked} onChange={event => setOrganizeId(event.target.value || null)}><option value="">Organize bookmarks…</option>{folders.filter(({ node }) => !node.unmodifiable && (node.children?.length ?? 0) > 1 && !node.children?.some(child => child.unmodifiable)).map(({ node, path }) => <option key={node.id} value={node.id}>{path}</option>)}</select></label>
        <BookmarkIconTools />
        <button className="text-button" onClick={() => setSavedOpen([])}>Collapse folders</button>
      </>}
    </div>}
    {storageNotice && <p className="bookmark-storage-notice" role="status">{storageNotice}</p>}
    {error && <><ErrorNotice message={error} /><button className="text-button" onClick={() => void refresh()}>Retry bookmarks</button></>}
    {moveError && <ErrorNotice message={moveError} onDismiss={() => setMoveError('')} />}
    {organizer && <OrganizeDialog title={`Organize ${organizer.title || 'bookmarks'}`} disabled={searching || !granted || nativeBusy} description="Saved directly to this Chrome profile. This changes the order inside the selected folder; nested folders stay intact." items={(organizer.children ?? []).map(node => ({ id: node.id, name: node.title || node.url || 'Untitled folder', detail: node.children ? `${node.children.length} items · Folder` : node.url || '', icon: node.children ? <Folder size={20} /> : <BookmarkIcon node={node} /> }))} onClose={() => setOrganizeId(null)} onSave={async (ids, previousIds) => {
      try { await provider!.reorder(organizer.id, ids, previousIds); }
      catch (error) { throw new Error(`${errorMessage(error)} Chrome may have applied some moves; close and reopen Organize to review.`); }
      finally { await refresh(); }
    }} />}
  </BookmarkIconProvider>;
}

function ShelfLayoutColumn({ column, title, index, count, arranging, disabled, onPosition, onRemove, children }: { column: LayoutColumn; title: string; index: number; count: number; arranging: boolean; disabled: boolean; onPosition: (position: number) => void; onRemove: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: columnDragId(column.id), data: { type: 'shelf-column', columnId: column.id, name: title }, disabled: !arranging || disabled });
  const accessibleName = column.kind === 'web' ? `${title} column` : title;
  return <section ref={setNodeRef} className={`${column.kind === 'web' ? 'launcher-group' : 'bookmark-column'} shelf-layout-column${isDragging ? ' is-dragging' : ''}`} aria-label={title} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {arranging && <div className="shelf-column-controls">
      <button ref={setActivatorNodeRef} className="icon-button shelf-drag-handle" {...attributes} {...listeners} disabled={disabled} aria-label={`Move ${accessibleName}`} title="Drag column; or press Space and use arrow keys"><DotsSixVertical size={16} /></button>
      <span>{title}</span>
      <PositionControl label={`Position of ${accessibleName}`} index={index} count={count} disabled={disabled} onMove={onPosition} />
      {column.kind === 'bookmarks' && !column.sectionIds.length && <IconButton label={`Remove empty ${title.toLowerCase()}`} disabled={disabled} onClick={onRemove}><X size={13} /></IconButton>}
    </div>}
    {children}
  </section>;
}

function SectionDropZone({ columnId, name, empty }: { columnId: string; name: string; empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `section-drop:${columnId}`, data: { type: 'bookmark-column-drop', columnId, name } });
  return <div ref={setNodeRef} className={`shelf-section-drop${empty ? ' is-empty' : ''}${isOver ? ' is-over' : ''}`} aria-label={name}>{columnId === newColumnId ? <><Plus size={14} />Drop folder into a new column</> : empty ? 'Drop folder here' : 'Drop folder at end'}</div>;
}

function BookmarkFolderSection({ section, column, columns, arranging, disabled, open, onToggle, onOrganize, tree, onMove }: { section: BookmarkSection; column: LayoutColumn; columns: LayoutColumn[]; arranging: boolean; disabled: boolean; open: Set<string>; onToggle: (id: string) => void; onOrganize: (id: string) => void; tree: BookmarkNode[]; onMove: (id: string, columnId: string, position: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: sectionDragId(section.folder.id), data: { type: 'bookmark-section', sectionId: section.folder.id, columnId: column.id, name: section.folder.title || 'Untitled folder' }, disabled: !arranging || disabled });
  return <section ref={setNodeRef} className={`bookmark-folder-section${arranging ? ' is-arranging' : ''}${isDragging ? ' is-dragging' : ''}${isOver && arranging ? ' is-over' : ''}`} aria-label={section.path} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {arranging && <div className="shelf-section-controls">
      <button ref={setActivatorNodeRef} className="icon-button shelf-drag-handle" data-section-handle={section.folder.id} {...attributes} {...listeners} disabled={disabled} aria-label={`Move ${section.folder.title || 'untitled folder'} section`} title="Move whole folder section on this shelf"><DotsSixVertical size={15} /></button>
      <select data-section-column={section.folder.id} aria-label={`Column for ${section.folder.title || 'untitled folder'}`} value={column.id} disabled={disabled} onChange={event => onMove(section.folder.id, event.target.value, columns.find(candidate => candidate.id === event.target.value)?.sectionIds.length ?? 0)}>{columns.map((candidate, index) => <option key={candidate.id} value={candidate.id}>Bookmark column {index + 1}</option>)}<option value={newColumnId}>New column</option></select>
      <PositionControl label={`Position of ${section.folder.title || 'untitled folder'} section`} index={column.sectionIds.indexOf(section.folder.id)} count={column.sectionIds.length} disabled={disabled} onMove={position => onMove(section.folder.id, column.id, position)} />
    </div>}
    <FolderRow node={section.folder} open={open.has(section.folder.id)} onToggle={() => onToggle(section.folder.id)} onOrganize={() => onOrganize(section.folder.id)} path={section.path} heading />
    {open.has(section.folder.id) && <BookmarkTree nodes={section.nodes} folderId={section.folder.id} open={open} onToggle={onToggle} onOrganize={onOrganize} path={section.path} tree={tree} disabled={disabled || arranging} />}
  </section>;
}

function PositionControl({ label, index, count, disabled, onMove }: { label: string; index: number; count: number; disabled: boolean; onMove: (position: number) => void }) {
  const [value, setValue] = useState(String(index + 1));
  useEffect(() => setValue(String(index + 1)), [index]);
  return <label className="shelf-position-control"><span>Position</span><input type="number" min={1} max={count} step={1} inputMode="numeric" aria-label={label} value={value} disabled={disabled} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => {
    const position = Number(value);
    if (Number.isInteger(position) && position > 0 && position <= count) onMove(position - 1); else setValue(String(index + 1));
  }} /></label>;
}

function FolderRow({ node, open, onToggle, onOrganize, path, heading = false }: { node: BookmarkNode; open: boolean; onToggle: () => void; onOrganize: () => void; path: string; heading?: boolean }) {
  const button = <button className="bookmark-folder-toggle" aria-expanded={open} aria-controls={open ? `bookmark-children-${node.id}` : undefined} onClick={onToggle} title={path}>
    <CaretRight size={11} className={open ? 'is-open' : ''} />{open ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.title || 'Untitled folder'}</span>
  </button>;
  return <div className={`bookmark-folder-row${heading ? ' bookmark-folder-heading' : ''}`}>
    {heading ? <h2>{button}</h2> : button}
    {!node.unmodifiable && (node.children?.length ?? 0) > 1 && !node.children?.some(child => child.unmodifiable) && <IconButton className="bookmark-folder-organize" label={`Organize ${node.title || 'untitled folder'}`} onClick={onOrganize}><ArrowsDownUp size={12} /></IconButton>}
  </div>;
}

function BookmarkTree({ nodes, folderId, open, onToggle, onOrganize, path, tree, disabled }: { nodes: BookmarkNode[]; folderId: string; open: Set<string>; onToggle: (id: string) => void; onOrganize: (id: string) => void; path: string; tree: BookmarkNode[]; disabled: boolean }) {
  const parent = findBookmark(tree, folderId);
  const readOnly = disabled || nodes.length < 2 || folderId === '0' || Boolean(parent?.unmodifiable) || !parent?.children || parent.children.some(node => node.unmodifiable);
  const visibleIds = nodes.map(node => node.id);
  return <SortableContext items={visibleIds.map(bookmarkDragId)} strategy={verticalListSortingStrategy}>
    <ul id={`bookmark-children-${folderId}`} className="bookmark-tree">{nodes.length ? nodes.map(node => <SortableBookmarkRow key={node.id} node={node} parentId={folderId} visibleIds={visibleIds} disabled={readOnly}>
      <div className="bookmark-native-line">{node.children ? <FolderRow node={node} open={open.has(node.id)} onToggle={() => onToggle(node.id)} onOrganize={() => onOrganize(node.id)} path={`${path} / ${node.title}`} /> : <BookmarkLink node={node} path={path} />}</div>
      {node.children && open.has(node.id) && <BookmarkTree nodes={node.children} folderId={node.id} open={open} onToggle={onToggle} onOrganize={onOrganize} path={`${path} / ${node.title}`} tree={tree} disabled={disabled} />}
    </SortableBookmarkRow>) : <li className="bookmark-empty-folder">Empty folder</li>}</ul>
  </SortableContext>;
}

function SortableBookmarkRow({ node, parentId, visibleIds, disabled, children }: { node: BookmarkNode; parentId: string; visibleIds: string[]; disabled: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: bookmarkDragId(node.id), data: { type: 'bookmark-item', parentId, visibleIds, name: node.title || node.url || 'Untitled bookmark' }, disabled });
  return <li ref={setNodeRef} className={`bookmark-native-row${isDragging ? ' is-dragging' : ''}${isOver ? ' is-over' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {!disabled && <button ref={setActivatorNodeRef} className="icon-button bookmark-item-handle" {...attributes} {...listeners} aria-label={`Reorder ${node.title || 'untitled bookmark'} in Chrome`} title="Reorder siblings in Chrome; Space and arrow keys also work"><DotsSixVertical size={12} /></button>}
    {children}
  </li>;
}

function BookmarkLink({ node, path }: { node: BookmarkNode; path: string }) {
  const url = bookmarkUrl(node);
  const label = <><BookmarkIcon node={node} /><span>{node.title || node.url || 'Untitled bookmark'}</span></>;
  const title = `${node.title || 'Untitled bookmark'}\n${node.url || ''}\n${path}`;
  return url ? <a className="bookmark-link" href={url} title={title}>{label}</a> : <span className="bookmark-link bookmark-unsupported" aria-disabled="true" title={`${title}\nOpen this address from Chrome’s bookmark manager`}>{label}</span>;
}
