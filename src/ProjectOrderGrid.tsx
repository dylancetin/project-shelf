import type { ReactNode } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Project } from '../shared/types';
import { shelfItemId } from './shelf-columns';
import './project-order.css';

export function ProjectOrderGrid({ projects, disabled, onStart, onMove, children }: {
  projects: Project[]; disabled: boolean; onStart: () => void;
  onMove: (activeId: string, overId: string) => Promise<void>; children: ReactNode;
}) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const name = (id: string | number) => projects.find(project => shelfItemId(project.id) === id)?.name ?? 'Destination';
  return <DndContext sensors={sensors} collisionDetection={args => closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(container => container.data.current?.kind === args.active.data.current?.kind) })}
    onDragStart={onStart} onDragEnd={({ active, over }) => {
      if (!disabled && over && active.id !== over.id && active.data.current?.kind === over.data.current?.kind) {
        void onMove(String(active.id).slice(6), String(over.id).slice(6)).catch(() => {});
      }
    }} accessibility={{ screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to move within the same kind. Press Space to save the order, or Escape to cancel.' }, announcements: {
      onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
      onDragOver: ({ active, over }) => over ? `${name(active.id)} is over ${name(over.id)}.` : 'No compatible drop target.',
      onDragEnd: ({ active, over }) => over && active.id !== over.id ? `Dropped ${name(active.id)}. Saving the order.` : 'Order unchanged.',
      onDragCancel: () => 'Cancelled. The saved order has not changed.',
    } }}>
    <SortableContext items={projects.map(project => shelfItemId(project.id))} strategy={rectSortingStrategy}>{children}</SortableContext>
  </DndContext>;
}
