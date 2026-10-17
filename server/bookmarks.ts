import { isIP } from 'node:net';
import { DEFAULT_HOSTNAMES, Store } from './store';
import { canonicalUrl } from './validation';
import { serviceHostname } from './hostnames';

export interface Bookmark { name: string; url: string }

export function decodeEntities(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const number = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : entity;
    }
    return entities[code.toLowerCase()] || entity;
  });
}

export function isLocalUrl(input: string): boolean {
  let name: string;
  try { name = new URL(input).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); }
  catch { return false; }
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')
    || name.endsWith('.lan') || name.endsWith('.home') || name.endsWith('.internal')
    || name.endsWith('.ts.net') || (!name.includes('.') && !name.includes(':'))) return true;
  if (isIP(name) === 4) {
    const [a, b] = name.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(name) === 6) {
    if (name.startsWith('::ffff:')) {
      const mapped = name.slice(7);
      if (isIP(mapped) === 4) return isLocalUrl(`http://${mapped}`);
      const match = mapped.match(/^([0-9a-f]+):([0-9a-f]+)$/);
      if (match) {
        const first = parseInt(match[1]!, 16), second = parseInt(match[2]!, 16);
        return isLocalUrl(`http://${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
      }
    }
    return name === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/.test(name) || /^fe[89ab][0-9a-f]:/.test(name);
  }
  return false;
}

/** Parse a local Netscape bookmark export, without loading a DOM or fetching URLs. */
export function parseBookmarks(html: string, localOnly = true): { bookmarks: Bookmark[]; skipped: number } {
  const bookmarks: Bookmark[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const anchors = html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);
  for (const match of anchors) {
    const attribute = match[1]!.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if (!attribute) { skipped++; continue; }
    let url: string;
    try { url = canonicalUrl(decodeEntities(attribute[1] ?? attribute[2] ?? attribute[3] ?? ''), false); }
    catch { skipped++; continue; }
    if ((localOnly && !isLocalUrl(url)) || seen.has(url)) { skipped++; continue; }
    seen.add(url);
    const name = decodeEntities(match[2]!.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    bookmarks.push({ name: name || new URL(url).hostname, url });
  }
  return { bookmarks, skipped };
}

export function importBookmarks(store: Store, html: string, localOnly = true): { added: number; skipped: number } {
  const parsed = parseBookmarks(html, localOnly);
  let added = 0, skipped = parsed.skipped;
  const now = new Date().toISOString();
  const aliases = new Set([...DEFAULT_HOSTNAMES, ...store.settings().hostnames]);
  const identity = (value: string) => {
    const url = new URL(value);
    if (aliases.has(url.hostname)) url.hostname = 'server.invalid';
    return url.href;
  };
  const existing = new Set(store.list().filter(item => item.kind === 'service' && item.url).map(item => identity(item.url)));
  for (const bookmark of parsed.bookmarks) {
    const key = identity(bookmark.url);
    if (store.byUrl(bookmark.url) || existing.has(key)) { skipped++; continue; }
    const port = new URL(bookmark.url).port;
    store.insert({
      id: crypto.randomUUID(), name: bookmark.name, description: 'Imported from bookmarks',
      kind: 'service', directory: '', source: 'bookmarks', url: bookmark.url,
      hostname: serviceHostname(bookmark.url, store.settings()), devCommand: '', buildCommand: '', prodCommand: '',
      port: port ? Number(port) : null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now,
    });
    existing.add(key);
    added++;
  }
  return { added, skipped };
}
