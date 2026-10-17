import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectData } from '../server/store';

export async function fixture(): Promise<string> {
  await mkdir('/tmp/opencode', { recursive: true });
  return mkdtemp('/tmp/opencode/project-shelf-test-');
}

export async function files(root: string, entries: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(entries)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export const cleanup = (root: string) => rm(root, { recursive: true, force: true });

export function project(directory: string, overrides: Partial<ProjectData> = {}): ProjectData {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name: 'Disposable fixture', description: '', kind: 'project',
    directory, source: 'test', url: '', hostname: '', devCommand: '', buildCommand: '',
    prodCommand: '', port: null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now, ...overrides,
  };
}

export function request(route: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://shelf.test${route}`, {
    method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await Bun.sleep(20);
  }
}

export function shellCommand(filename: string): string {
  return `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(filename)}`;
}
