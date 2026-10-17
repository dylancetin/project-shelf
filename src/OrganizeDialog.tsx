import { useEffect, useState, type ReactNode } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, DotsSixVertical } from '@phosphor-icons/react';
import { moveItem } from '../shared/ordering';
import { errorMessage } from './api';
import { Dialog, ErrorNotice, IconButton, Spinner } from './components';
import './organize.css';

export interface OrderItem { id: string; name: string; detail: string; icon: ReactNode }

export function OrganizeDialog({ title, description, items, disabled = false, onClose, onSave }: {
  title: string; description: string; items: OrderItem[]; disabled?: boolean;
  onClose: () => void; onSave: (ids: string[], previousIds: string[]) => Promise<void>;
}) {
  // A stable draft: polling and bookmark events must not replace unsaved work.
  const [original] = useState(items);
  const [draft, setDraft] = useState(items);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const changed = draft.some((item, index) => item.id !== original[index]?.id);
  const locked = saving || disabled;
  function move(from: number, to: number) {
    const next = moveItem(draft, from, to);
    setDraft(next);
    if (next !== draft) setAnnouncement(`${next[to]!.name} moved to position ${to + 1} of ${draft.length}.`);
  }
  async function save() {
    if (locked || !changed) return;
    setSaving(true); setError('');
    try { await onSave(draft.map(item => item.id), original.map(item => item.id)); onClose(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <Dialog title={title} eyebrow="YOUR SHELF, YOUR ORDER" className="organize-dialog" onClose={() => { if (!saving && !dragging) onClose(); }} footer={<>
    <span className="organize-save-status" role="status">{saving ? 'Saving order…' : changed ? 'Unsaved changes' : `${draft.length} items`}</span>
    <button className="button" disabled={saving} onClick={onClose}>Cancel</button>
    <button className="button button-primary" disabled={locked || !changed || dragging} onClick={() => void save()}>{saving && <Spinner size={14} />}Save order</button>
  </>}>
    <p className="organize-description">{description}</p>
    <p className="organize-help">Drag a handle, use the arrows, or choose a position.</p>
    {disabled && <p className="organize-help" role="status">Reconnect to save changes to this collection.</p>}
    {error && <ErrorNotice message={error} />}
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={({ active, over }) => {
      setDragging(false);
      if (over) move(draft.findIndex(item => item.id === active.id), draft.findIndex(item => item.id === over.id));
    }} accessibility={{ screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to move, Space to drop, or Escape to cancel.' } }}>
      <SortableContext items={draft.map(item => item.id)} strategy={verticalListSortingStrategy}>
        <ol className="organize-list" aria-label={title}>{draft.map((item, index) => <OrderRow key={item.id} item={item} index={index} count={draft.length} disabled={locked} onMove={to => move(index, to)} />)}</ol>
      </SortableContext>
    </DndContext>
    {!draft.length && <p className="organize-description">Nothing in this collection yet.</p>}
    <p className="organize-footnote">Nothing moves until you save. Cancel leaves the original order untouched.</p>
  </Dialog>;
}

function OrderRow({ item, index, count, disabled, onMove }: { item: OrderItem; index: number; count: number; disabled: boolean; onMove: (to: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  return <li ref={setNodeRef} className={`organize-row${isDragging ? ' is-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null), transition }}>
    <button type="button" ref={setActivatorNodeRef} className="icon-button organize-handle" {...attributes} {...listeners} disabled={disabled} aria-label={`Reorder ${item.name}`} title="Drag to reorder; Space then arrow keys with a keyboard"><DotsSixVertical size={20} /></button>
    {item.icon}
    <span className="organize-item-label"><strong>{item.name}</strong><span>{item.detail}</span></span>
    <div className="organize-arrows">
      <IconButton label={`Move ${item.name} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}><ArrowUp size={15} /></IconButton>
      <IconButton label={`Move ${item.name} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}><ArrowDown size={15} /></IconButton>
    </div>
    {count <= 200 ? <select className="organize-position" aria-label={`Position of ${item.name}`} value={index} disabled={disabled} onChange={event => onMove(Number(event.target.value))}>{Array.from({ length: count }, (_, position) => <option key={position} value={position}>{position + 1}</option>)}</select> : <PositionInput name={item.name} index={index} count={count} disabled={disabled} onMove={onMove} />}
  </li>;
}

// Avoid creating N² <option> nodes for very large bookmark folders.
function PositionInput({ name, index, count, disabled, onMove }: { name: string; index: number; count: number; disabled: boolean; onMove: (to: number) => void }) {
  const [value, setValue] = useState(String(index + 1));
  useEffect(() => setValue(String(index + 1)), [index]);
  return <input className="organize-position" type="number" min={1} max={count} step={1} inputMode="numeric" aria-label={`Position of ${name}`} value={value} disabled={disabled} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => {
    const position = Number(value);
    if (Number.isInteger(position) && position >= 1 && position <= count) onMove(position - 1);
    else setValue(String(index + 1));
  }} />;
}
