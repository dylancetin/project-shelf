import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * When `directory` is inside a linked Git worktree (`git worktree add`, as T3 Code
 * uses), returns the same relative location inside the main checkout. Reads the
 * worktree's `.git` file and `commondir` only; never runs Git or project code.
 */
export async function mainCheckoutPath(directory: string): Promise<string | null> {
  for (let root = directory; ; root = path.dirname(root)) {
    const marker = path.join(root, '.git');
    const info = await stat(marker).catch(() => null);
    if (info?.isDirectory()) return null; // A main checkout, not a linked worktree.
    if (info?.isFile()) {
      const pointer = (await readFile(marker, 'utf8').catch(() => '')).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (!pointer) return null;
      const gitDir = path.resolve(root, pointer);
      if (path.basename(path.dirname(gitDir)) !== 'worktrees') return null; // Submodules also use a .git file.
      const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
      const commonDir = await realpath(path.resolve(gitDir, common || '../..')).catch(() => null);
      // Only a regular repository (`<checkout>/.git`) has a main checkout to map to.
      if (!commonDir || path.basename(commonDir) !== '.git') return null;
      return path.join(path.dirname(commonDir), path.relative(root, directory));
    }
    if (path.dirname(root) === root) return null;
  }
}

/**
 * The registered project a directory belongs to: the deepest project directory
 * containing it, or else containing its counterpart in the main Git checkout.
 */
export async function owningProject<T extends { kind: string; directory: string }>(directory: string, projects: readonly T[]): Promise<T | null> {
  const resolved = await realpath(directory).catch(() => path.resolve(directory));
  const candidates = projects.filter(project => project.kind === 'project' && project.directory && path.isAbsolute(project.directory));
  const deepest = (target: string) => candidates.filter(project => inside(target, project.directory))
    .sort((a, b) => b.directory.length - a.directory.length)[0] ?? null;
  const direct = deepest(resolved);
  if (direct) return direct;
  const main = await mainCheckoutPath(resolved);
  return main ? deepest(main) : null;
}
