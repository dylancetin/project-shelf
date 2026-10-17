import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { LogoFile } from '../shared/types';
import { ApiError } from './errors';
import { confinedFile, IGNORED_DIRECTORIES, isWithin } from './paths';

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
};

export async function findLogos(directory: string, id: string): Promise<LogoFile[]> {
  if (!directory) return [];
  let root: string;
  try { root = await realpath(directory); } catch { return []; }
  const candidates: string[] = [];
  let count = 0;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 5 || count > 5000 || candidates.length >= 100) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++count > 5000 || candidates.length >= 100) break;
      if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      const resolved = await realpath(full).catch(() => '');
      if (!resolved || !isWithin(root, resolved) || (await lstat(full)).isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(resolved, depth + 1);
      else if (entry.isFile() && MIME[path.extname(entry.name).toLowerCase()]
        && (/(?:logo|icon|favicon|brand|mark)/i.test(entry.name) || depth <= 1)) {
        candidates.push(path.relative(root, resolved).split(path.sep).join('/'));
      }
    }
  }
  await walk(root, 0);
  return candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b)).map((relative) => ({
    path: relative,
    url: `/api/projects/${encodeURIComponent(id)}/logo?path=${encodeURIComponent(relative)}`,
  }));
}

function score(filename: string): number {
  const name = path.basename(filename).toLowerCase();
  return (name.includes('logo') ? 100 : 0) + (name.includes('favicon') ? 30 : 0) + (name.endsWith('.svg') ? 10 : 0) - filename.split('/').length;
}

export async function serveLogo(directory: string, relative: string): Promise<Response> {
  if (!directory) throw new ApiError(404, 'This entry has no project directory');
  const extension = path.extname(relative).toLowerCase();
  const type = MIME[extension];
  if (!type) throw new ApiError(400, 'Only supported image files can be served');
  const filename = await confinedFile(directory, relative);
  const file = Bun.file(filename);
  if (file.size > 10 * 1024 * 1024) throw new ApiError(413, 'Image is larger than 10 MB');
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = new TextDecoder().decode(head);
  const signatureOk = extension === '.svg' ? /<svg(?:\s|>)/i.test(ascii)
    : extension === '.png' ? head[0] === 137 && ascii.slice(1, 4) === 'PNG'
    : ['.jpg', '.jpeg'].includes(extension) ? head[0] === 255 && head[1] === 216 && head[2] === 255
    : extension === '.gif' ? /^GIF8[79]a/.test(ascii)
    : extension === '.webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
    : extension === '.avif' ? ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8, 40))
    : head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0;
  if (!signatureOk) throw new ApiError(400, 'The file does not contain a supported image');
  return new Response(file, { headers: {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=60',
  } });
}
