import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * When `directory` is inside a linked Git worktree (`git worktree add`, as T3 Code
 * uses), returns the same relative location inside the main checkout. Reads the
 * worktree's `.git` file and `commondir` only; never runs Git or project code.
 */
export function mainCheckoutPathSync(directory: string): string | null {
  for (let root = directory; ; root = path.dirname(root)) {
    const marker = path.join(root, '.git');
    let info;
    try { info = statSync(marker); } catch { info = null; }
    if (info?.isDirectory()) return null; // A main checkout, not a linked worktree.
    if (info?.isFile()) {
      let pointer: string | undefined;
      try { pointer = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]; } catch { /* unreadable marker */ }
      if (!pointer) return null;
      const gitDir = path.resolve(root, pointer);
      if (path.basename(path.dirname(gitDir)) !== 'worktrees') return null; // Submodules also use a .git file.
      let common = '';
      try { common = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); } catch { /* defaults below */ }
      let commonDir: string | null;
      try { commonDir = realpathSync(path.resolve(gitDir, common || '../..')); } catch { commonDir = null; }
      // Only a regular repository (`<checkout>/.git`) has a main checkout to map to.
      if (!commonDir || path.basename(commonDir) !== '.git') return null;
      return path.join(path.dirname(commonDir), path.relative(root, directory));
    }
    if (path.dirname(root) === root) return null;
  }
}

export async function mainCheckoutPath(directory: string): Promise<string | null> {
  return mainCheckoutPathSync(directory);
}

/** Canonical location: the real path when it exists, else the normalized absolute path. */
export function canonicalPathSync(directory: string): string {
  try { return realpathSync(directory); } catch { return path.resolve(directory); }
}

// Agent rows and project lists poll every few seconds; worktree layout and real paths rarely change.
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 1000;
const cache = new Map<string, { at: number; canonical: string; main: string | null }>();

/** `canonicalPathSync` plus `mainCheckoutPathSync`, memoized per directory for a short time. */
export function locate(directory: string, now = Date.now()): { canonical: string; main: string | null } {
  const hit = cache.get(directory);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit;
  const canonical = canonicalPathSync(directory);
  const entry = { at: now, canonical, main: mainCheckoutPathSync(canonical) };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(directory, entry);
  return entry;
}

/** Forgets memoized worktree mappings (tests, or after registrations move). */
export function clearLocateCache() { cache.clear(); }

/** Registered `kind: 'project'` entries with a usable absolute directory. */
export function projectEntries<T extends { kind: string; directory: string }>(projects: readonly T[]): T[] {
  return projects.filter(project => project.kind === 'project' && project.directory && path.isAbsolute(project.directory));
}

/** Deepest project directory containing `target` (equal or ancestor). */
export function deepestContaining<T extends { directory: string }>(target: string, candidates: readonly T[]): T | null {
  return candidates.filter(project => inside(target, project.directory))
    .sort((a, b) => b.directory.length - a.directory.length)[0] ?? null;
}

/**
 * The registered project a directory belongs to: the deepest project directory
 * containing it, or else containing its counterpart in the main Git checkout.
 */
export async function owningProject<T extends { kind: string; directory: string }>(directory: string, projects: readonly T[]): Promise<T | null> {
  return owningProjectSync(directory, projects, canonicalPathSync, mainCheckoutPathSync);
}

export function owningProjectSync<T extends { kind: string; directory: string }>(directory: string, projects: readonly T[],
  canonical: (directory: string) => string = path => locate(path).canonical, main: (directory: string) => string | null = path => locate(path).main): T | null {
  const resolved = canonical(directory);
  const candidates = projectEntries(projects);
  const direct = deepestContaining(resolved, candidates);
  if (direct) return direct;
  const counterpart = main(resolved);
  return counterpart ? deepestContaining(counterpart, candidates) : null;
}
