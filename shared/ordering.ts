// Every reorder operates on one complete collection, never a filtered search.
export function sameMembers(current: string[], next: string[]): boolean {
  const ids = new Set(next);
  return ids.size === next.length && current.length === next.length && current.every(id => ids.has(id));
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

// Inline views omit hidden entries, favorites, or entries without an address.
// Move only the visible subset, keeping omitted registrations in their slots.
export function moveWithinSubset(all: string[], visible: string[], active: string, over: string): string[] | null {
  const visibleSet = new Set(visible);
  if (new Set(all).size !== all.length || visibleSet.size !== visible.length) return null;
  const current = all.filter(id => visibleSet.has(id));
  if (current.length !== visible.length || !current.every((id, index) => id === visible[index])) return null;
  const from = visible.indexOf(active), to = visible.indexOf(over);
  if (from < 0 || to < 0) return null;
  const next = moveItem(visible, from, to);
  let index = 0;
  return all.map(id => visibleSet.has(id) ? next[index++]! : id);
}
