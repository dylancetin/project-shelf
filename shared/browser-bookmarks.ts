export interface BookmarkNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  children?: BookmarkNode[];
  unmodifiable?: string;
}

export interface BrowserBookmarks {
  hasAccess(): Promise<boolean>;
  requestAccess(): Promise<boolean>;
  getTree(): Promise<BookmarkNode[]>;
  subscribe(listener: () => void): () => void;
  reorder(parentId: string, ids: string[], previousIds: string[]): Promise<void>;
  favicons?: BrowserFavicons;
}

export interface BrowserFavicons {
  hasAccess(): Promise<boolean>;
  requestAccess(): Promise<boolean>;
  read(url: string): Promise<string | null>;
  refresh(urls: string[], progress: (done: number, total: number) => void): Promise<number>;
  clear?(): Promise<void>;
}

export interface BookmarkSection { folder: BookmarkNode; nodes: BookmarkNode[]; path: string }

// Lift first-level folders into the column layout without duplicating their
// bookmarks. Loose links stay together under their browser root's heading.
export function bookmarkSections(tree: BookmarkNode[]): BookmarkSection[] {
  return (tree[0]?.children ?? []).flatMap(root => {
    const children = root.children ?? [];
    const loose = children.filter(node => !node.children);
    return [
      ...(loose.length || !children.length ? [{ folder: root, nodes: loose, path: root.title }] : []),
      ...children.filter(node => node.children).map(folder => ({ folder, nodes: folder.children!, path: `${root.title} / ${folder.title}` })),
    ];
  });
}

// Pack whole folders, not individual rows. Expansion never reshuffles columns.
export function bookmarkColumns(sections: BookmarkSection[], budget = 22): BookmarkSection[][] {
  const columns: BookmarkSection[][] = [];
  let used = 0;
  for (const section of sections) {
    const weight = Math.max(3, section.nodes.length + 2);
    if (!columns.length || used + weight > budget) { columns.push([]); used = 0; }
    columns.at(-1)!.push(section);
    used += weight;
  }
  return columns;
}

export function bookmarkFolders(tree: BookmarkNode[], path = ''): { node: BookmarkNode; path: string }[] {
  return tree.flatMap(node => {
    if (!node.children) return [];
    const label = [path, node.title].filter(Boolean).join(' / ');
    return [...(node.id === '0' ? [] : [{ node, path: label }]), ...bookmarkFolders(node.children, label)];
  });
}

export function findBookmark(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children && findBookmark(node.children, id);
    if (child) return child;
  }
}

export function bookmarkUrl(node: BookmarkNode): string {
  try {
    const url = new URL(node.url ?? '');
    // Bookmarklets and other executable schemes must never execute in Shelf.
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function searchBookmarks(nodes: BookmarkNode[], query: string, path = ''): (BookmarkNode & { path: string })[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return nodes.flatMap(node => node.children
    ? searchBookmarks(node.children, query, [path, node.title].filter(Boolean).join(' / '))
    : words.every(word => `${node.title} ${node.url} ${path}`.toLowerCase().includes(word)) ? [{ ...node, path }] : []);
}
