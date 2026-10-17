import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store';
import { cleanup, files, fixture, project, until } from './helpers';

test('SIGTERM shuts the real Bun entrypoint down and terminates its fixture-only managed process', async () => {
  const root = await fixture();
  await files(root, { 'source/fixture.txt': 'Disposable process fixture' });
  const dbPath = path.join(root, 'panel.sqlite');
  const store = new Store(dbPath, { roots: [] });
  const item = project(path.join(root, 'source'), { devCommand: 'sleep 60' });
  store.insert(item);
  store.setValue('bootstrapComplete', true);
  store.close();
  const backend = spawn(process.execPath, [fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    env: { ...process.env, PANEL_DB_PATH: dbPath, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let managedPid: number | null = null;
  backend.stdout.on('data', (chunk) => { output += chunk.toString(); });
  backend.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const response = await fetch(`${base}/api/projects/${item.id}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'dev' }),
    });
    expect(response.status).toBe(200);
    managedPid = (await response.json()).project.runtime.pid;
    expect(managedPid).toBeGreaterThan(0);
    backend.kill('SIGTERM');
    await until(() => backend.exitCode !== null || backend.signalCode !== null, 5000);
    expect(backend.exitCode).toBe(0);
    await until(async () => {
      try {
        const state = await readFile(`/proc/${managedPid}/stat`, 'utf8');
        return state.slice(state.lastIndexOf(')') + 2).startsWith('Z ');
      } catch { return true; }
    });
  } finally {
    if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL');
    if (managedPid) { try { process.kill(-managedPid, 'SIGKILL'); } catch { /* Already exited. */ } }
    backend.stdout.destroy();
    backend.stderr.destroy();
    await cleanup(root);
  }
}, 10_000);
