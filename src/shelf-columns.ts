import type { ReactNode } from 'react';
import type { ProjectKind } from '../shared/types';

/** The launcher supplies web columns; the shared shelf owns their placement. */
export interface ShelfColumn {
  id: string;
  title: string;
  continued?: boolean;
  actions?: ReactNode;
  content: ReactNode;
}

/** One DnD context owns columns, folder groups, and the destination rows. */
export interface ShelfItemDragData {
  type: 'shelf-item';
  group: string;
  kind: ProjectKind;
  name?: string;
}

export const shelfItemId = (id: string) => `entry:${id}`;
