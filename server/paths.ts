import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors';

export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.output', '.svelte-kit',
  '.astro', '.turbo', '.cache', '.parcel-cache', '.vite', '.yarn', '.pnpm-store',
  '.bun', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'target', 'vendor', 'dist', 'build', 'out', 'coverage', '.gradle',
  '.idea', '.vscode', '.tox', '.eggs', '.DS_Store', 'bower_components', '.npm',
]);

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function absolutePath(value: unknown, field = 'directory'): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim())) {
    throw new ApiError(400, `${field} must be an absolute path`);
  }
  if (value.length > 4096) throw new ApiError(400, `${field} is too long`);
  return path.resolve(value.trim());
}

export async function canonicalDirectory(value: unknown): Promise<string> {
  const directory = absolutePath(value);
  try {
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Not a directory');
    return resolved;
  } catch {
    throw new ApiError(400, `Directory does not exist or is not accessible: ${directory}`);
  }
}

export function safeRelative(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)
    || value.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new ApiError(400, 'Invalid relative file path');
  }
  return value;
}

export async function confinedFile(root: string, relative: string): Promise<string> {
  safeRelative(relative);
  try {
    const resolvedRoot = await realpath(root);
    const resolved = await realpath(path.join(resolvedRoot, relative));
    if (!isWithin(resolvedRoot, resolved) || !(await stat(resolved)).isFile()) {
      throw new ApiError(403, 'File is outside the project directory');
    }
    return resolved;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, 'File not found');
  }
}

export function copyExcluded(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.endsWith('.tsbuildinfo') || name.endsWith('.pyc');
}

/** Reserve the destination exclusively. Symlinks and generated artifacts are never copied. */
export async function copyProject(source: string, destination: string): Promise<string> {
  const from = await canonicalDirectory(source);
  const requested = absolutePath(destination);
  let parent: string;
  try {
    parent = await realpath(path.dirname(requested));
    if (!(await stat(parent)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new ApiError(400, 'The destination parent directory must already exist');
  }
  const to = path.join(parent, path.basename(requested));
  if (isWithin(from, to) || isWithin(to, from)) {
    throw new ApiError(400, 'The destination must be separate from the source directory');
  }
  try {
    await mkdir(to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError(409, 'Destination already exists; nothing was overwritten');
    throw new ApiError(400, 'Cannot create the destination directory');
  }

  let count = 0;
  async function copyDirectory(current: string, target: string, depth: number): Promise<void> {
    if (depth > 80) throw new Error('Maximum copy depth exceeded');
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (++count > 200_000) throw new Error('Maximum copy size exceeded');
      if (copyExcluded(entry.name) || entry.isSymbolicLink()) continue;
      const input = path.join(current, entry.name);
      const output = path.join(target, entry.name);
      // Recheck the actual entry, not only the earlier readdir snapshot.
      const info = await lstat(input);
      if (info.isSymbolicLink()) continue;
      const resolved = await realpath(input);
      if (!isWithin(from, resolved)) continue;
      if (info.isDirectory()) {
        await mkdir(output, { mode: info.mode & 0o777 });
        await copyDirectory(resolved, output, depth + 1);
      } else if (info.isFile()) {
        await copyFile(resolved, output, constants.COPYFILE_EXCL);
      }
    }
  }

  try {
    await copyDirectory(from, to, 0);
  } catch (error) {
    // Keep a partial copy rather than risk deleting files a user may have added meanwhile.
    throw new ApiError(400, `Copy failed; the partial destination was retained at ${to}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return to;
}
