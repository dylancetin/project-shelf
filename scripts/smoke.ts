import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LogLine, LogoFile, Project, RunMode, Settings } from '../shared/types';

// Only registers and runs disposable fixtures; never scans or changes settings.
const baseURL = new URL(Bun.argv[2] ?? 'http://127.0.0.1:4958');
assert.ok(['http:', 'https:'].includes(baseURL.protocol), 'Expected an HTTP(S) server URL');

const pause = (ms: number) => Bun.sleep(ms);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

async function response(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, baseURL), {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await response(method, path, body);
  const text = await result.text();
  assert.ok(result.ok, `${method} ${path}: HTTP ${result.status}: ${text.slice(0, 1_000)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    assert.fail(`${method} ${path} did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function rejected(method: string, path: string, body?: unknown): Promise<void> {
  const result = await response(method, path, body);
  const text = await result.text();
  assert.ok(result.status >= 400 && result.status < 500,
    `${method} ${path} should reject unsafe input, got ${result.status}: ${text.slice(0, 500)}`);
}

async function projects(): Promise<Project[]> {
  const data = await api<{ projects: Project[] }>('GET', '/api/projects');
  assert.ok(Array.isArray(data.projects), 'Project listing must contain an array');
  return data.projects;
}

async function project(id: string): Promise<Project> {
  const found = (await projects()).find(item => item.id === id);
  assert.ok(found, `Registration ${id} disappeared`);
  return found;
}

async function poll<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean,
  timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  do {
    last = await read();
    if (ready(last)) return last;
    await pause(150);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function main(): Promise<void> {
  await mkdir('/tmp/opencode', { recursive: true });
  const sandbox = await mkdtemp('/tmp/opencode/project-shelf-smoke-');
  const token = basename(sandbox);
  const fixture = join(sandbox, 'fixture');
  const copy = join(sandbox, 'copied-fixture');
  const registrations = new Set<string>();
  const names = new Set<string>();
  const cleanupErrors: string[] = [];
  let testError: unknown;
  let failed = false;

  function name(suffix: string): string {
    const value = `${token}: ${suffix}`;
    names.add(value);
    return value;
  }

  function track(value: Project): Project {
    assert.ok(value && typeof value.id === 'string' && value.id.length > 0,
      'Mutation must return a project with an ID');
    registrations.add(value.id);
    return value;
  }

  async function create(body: Record<string, unknown>): Promise<Project> {
    return track((await api<{ project: Project }>('POST', '/api/projects', body)).project);
  }

  async function logs(id: string): Promise<LogLine[]> {
    const result = await api<{ logs: LogLine[] }>('GET', `/api/projects/${id}/logs`);
    assert.ok(Array.isArray(result.logs), 'Logs must be an array');
    return result.logs;
  }

  async function output(id: string, marker: string): Promise<void> {
    await poll(`output ${marker}`, () => logs(id), lines => lines.some(line => line.text.includes(marker)));
  }

  async function events(): Promise<string[]> {
    const path = join(fixture, 'events.jsonl');
    if (!await exists(path)) return [];
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { mode: string }).mode);
  }

  async function workerPID(mode: RunMode): Promise<number> {
    return poll(`${mode} worker PID`, async () => {
      const path = join(fixture, `${mode}.pid`);
      return await exists(path) ? Number(await readFile(path, 'utf8')) : 0;
    }, pid => Number.isSafeInteger(pid) && pid > 0);
  }

  async function start(id: string, mode: RunMode): Promise<void> {
    const result = await api<{ project: Project }>('POST', `/api/projects/${id}/start`, { mode });
    assert.equal(result.project.id, id);
  }

  async function running(id: string, mode: RunMode): Promise<void> {
    const current = await poll(`${mode} running`, () => project(id), value => value.runtime.status === 'running');
    assert.equal(current.runtime.mode, mode);
    assert.ok(current.runtime.pid && current.runtime.pid > 0, 'Running process needs a PID');
  }

  async function stop(id: string, mode: 'dev' | 'prod'): Promise<void> {
    const pid = await workerPID(mode);
    assert.ok(alive(pid), `${mode} worker should be alive before stopping`);
    const result = await api<{ project: Project }>('POST', `/api/projects/${id}/stop`);
    assert.equal(result.project.id, id);
    await poll(`${mode} stopped`, () => project(id), value =>
      value.runtime.status === 'stopped' && value.runtime.pid === null);
    await poll(`${mode} child exit`, async () => alive(pid), value => !value, 5_000);
  }

  async function removeRegistration(id: string): Promise<void> {
    const result = await api<{ ok: boolean }>('DELETE', `/api/projects/${id}`);
    assert.equal(result.ok, true);
    registrations.delete(id);
  }

  async function cleanup(): Promise<void> {
    // Discover even registrations whose successful response was lost or malformed.
    try {
      for (const item of await projects()) {
        if (names.has(item.name)) registrations.add(item.id);
      }
    } catch (error) {
      cleanupErrors.push(`discover registrations: ${describe(error)}`);
    }

    for (const id of registrations) {
      try {
        const result = await response('POST', `/api/projects/${id}/stop`);
        assert.ok(result.ok || result.status === 404, `HTTP ${result.status}`);
        await result.text();
        if (result.status !== 404) {
          await poll(`cleanup stop ${id}`, async () => (await projects()).find(item => item.id === id), value =>
            !value || (value.runtime.pid === null && ['stopped', 'failed'].includes(value.runtime.status)), 5_000);
        }
      } catch (error) {
        cleanupErrors.push(`stop ${id}: ${describe(error)}`);
      }
      try {
        const result = await response('DELETE', `/api/projects/${id}`);
        assert.ok(result.ok || result.status === 404, `HTTP ${result.status}`);
        await result.text();
      } catch (error) {
        cleanupErrors.push(`delete ${id}: ${describe(error)}`);
      }
    }

    // API failures must not leave our workers alive. Verify ownership before killing
    // any recorded PID, since the OS could have reused an exited worker's PID.
    for (const mode of ['dev', 'build', 'prod'] as const) {
      try {
        const pidFile = join(fixture, `${mode}.pid`);
        if (!await exists(pidFile)) continue;
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) continue;
        const ownsPID = async () => {
          try {
            const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
            return command.split('\0').includes(token) && command.includes('smoke-worker.ts');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          }
        };
        if (!await ownsPID()) continue;
        process.kill(pid, 'SIGTERM');
        for (let attempt = 0; attempt < 20 && await ownsPID(); attempt++) await pause(100);
        if (await ownsPID()) process.kill(pid, 'SIGKILL');
        await poll(`cleanup ${mode} worker exit`, ownsPID, value => !value, 3_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          cleanupErrors.push(`kill fixture ${mode}: ${describe(error)}`);
        }
      }
    }

    try {
      const remaining = (await projects()).filter(item => registrations.has(item.id) || names.has(item.name));
      assert.equal(remaining.length, 0, `Registrations remain: ${remaining.map(item => item.id).join(', ')}`);
    } catch (error) {
      cleanupErrors.push(`verify registration cleanup: ${describe(error)}`);
    }
    try {
      // This is the mkdtemp directory created above, never a user-supplied path.
      await rm(sandbox, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`remove ${sandbox}: ${describe(error)}`);
    }
  }

  try {
    assert.equal((await api<{ ok: boolean }>('GET', '/api/health')).ok, true);
    const settings = (await api<{ settings: Settings }>('GET', '/api/settings')).settings;
    const searchBase = {
      duckduckgo: 'https://duckduckgo.com/?q=', google: 'https://www.google.com/search?q=',
      bing: 'https://www.bing.com/search?q=', brave: 'https://search.brave.com/search?q=',
    }[settings.defaultSearchEngine];
    assert.ok(searchBase, 'Settings must expose a supported default search engine');
    for (const [query, expected] of [
      ['!gh bun sqlite', 'https://github.com/search?utf8=%E2%9C%93&q=bun%20sqlite'],
      ['!g bun', 'https://www.google.com/search?q=bun'],
      ['bun sqlite', `${searchBase}bun%20sqlite`],
      ['!unknown-shelf-bang bun', `${searchBase}bun`],
    ]) {
      const search = await fetch(new URL(`/search?q=${encodeURIComponent(query)}`, baseURL), {
        redirect: 'manual', signal: AbortSignal.timeout(10_000),
      });
      assert.equal(search.status, 302);
      assert.equal(search.headers.get('location'), expected);
      assert.equal(search.headers.get('cache-control'), 'no-store');
    }
    const description = await response('GET', '/opensearch.xml');
    assert.equal(description.status, 200);
    assert.match(description.headers.get('content-type') ?? '', /^application\/opensearchdescription\+xml/);
    assert.ok((await description.text()).includes(`template="${baseURL.origin}/search?q={searchTerms}"`));
    console.log('[smoke] browser search redirects, saved engine fallback, and OpenSearch discovery passed');
    await mkdir(join(fixture, 'assets'), { recursive: true });
    await mkdir(join(fixture, 'node_modules', 'smoke-excluded'), { recursive: true });
    await writeFile(join(fixture, 'node_modules', 'smoke-excluded', 'index.js'), 'must not be copied\n');
    await writeFile(join(fixture, 'README.md'), `Disposable fixture ${token}\n`);
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: token, private: true }));
    await writeFile(join(fixture, 'assets', 'logo.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>${token}</title><rect width="16" height="16" fill="#456"/></svg>`);
    await writeFile(join(sandbox, 'outside.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>must not escape project</title></svg>');
    await writeFile(join(fixture, 'smoke-worker.ts'), `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode, token] = process.argv.slice(2);
if (!['dev', 'build', 'prod'].includes(mode) || !token) throw new Error('Invalid fixture arguments');
writeFileSync(join(import.meta.dir, mode + '.pid'), String(process.pid));
appendFileSync(join(import.meta.dir, 'events.jsonl'), JSON.stringify({ mode, pid: process.pid }) + '\\n');
if (mode === 'build') {
  writeFileSync(join(import.meta.dir, 'build-marker'), token);
  console.log(token + ':BUILD_DONE');
  process.exit(0);
}
if (mode === 'prod' && readFileSync(join(import.meta.dir, 'build-marker'), 'utf8') !== token) {
  throw new Error('Production started without a successful build');
}
console.log(token + ':' + mode.toUpperCase() + '_READY');
console.error(token + ':' + mode.toUpperCase() + '_STDERR');
setInterval(() => console.log(token + ':' + mode.toUpperCase() + '_TICK'), 250);
`);

    const command = (mode: RunMode) => `${shellQuote(process.execPath)} run ./smoke-worker.ts ${mode} ${shellQuote(token)}`;
    const original = await create({
      name: name('project'), kind: 'project', directory: fixture,
      url: 'http://localhost:43123/demo?smoke=1#fixture', hostname: '',
      devCommand: command('dev'), buildCommand: command('build'), prodCommand: command('prod'),
    });
    assert.equal(original.kind, 'project');
    const saved = await project(original.id);
    assert.equal(saved.directory, fixture);
    assert.equal(saved.devCommand, command('dev'));
    assert.equal(saved.buildCommand, command('build'));
    assert.equal(saved.prodCommand, command('prod'));
    assert.equal(saved.runtime.status, 'stopped');
    const edited = (await api<{ project: Project }>('PATCH', `/api/projects/${original.id}`, { hostname: 'beelinkk' })).project;
    assert.equal(edited.hostname, 'beelinkk');
    assert.equal((await project(original.id)).hostname, 'beelinkk');
    const beforeURL = new URL(saved.url);
    const afterURL = new URL(edited.url);
    for (const field of ['protocol', 'port', 'pathname', 'search', 'hash'] as const) {
      assert.equal(afterURL[field], beforeURL[field], `Hostname edit must preserve URL ${field}`);
    }
    console.log('[smoke] create, list/read, and hostname edit passed');

    const candidates = (await api<{ logos: LogoFile[] }>('GET', `/api/projects/${original.id}/logos`)).logos;
    assert.ok(candidates.some(logo => logo.path === 'assets/logo.svg'), 'Fixture logo should be discoverable');
    const logo = await response('GET', `/api/projects/${original.id}/logo?path=${encodeURIComponent('assets/logo.svg')}`);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-type') ?? '', /^image\//);
    assert.ok((await logo.text()).includes(token), 'Logo response must contain our image');
    await rejected('GET', `/api/projects/${original.id}/logo?path=${encodeURIComponent('../outside.svg')}`);
    console.log('[smoke] logo discovery, image response, and traversal rejection passed');

    const remoteLogo = 'https://example.test/logo.png?v=2#image';
    const remote = (await api<{ project: Project }>('PATCH', `/api/projects/${original.id}`, { logo: remoteLogo })).project;
    assert.equal(remote.logo, remoteLogo);
    assert.equal((await project(original.id)).logo, remoteLogo);
    await rejected('PATCH', `/api/projects/${original.id}`, { logo: 'javascript:alert(1)' });
    await rejected('PATCH', `/api/projects/${original.id}`, { logo: 'https://user:password@example.test/logo.png' });
    assert.equal((await project(original.id)).logo, remoteLogo);
    await api('PATCH', `/api/projects/${original.id}`, { logo: 'assets/logo.svg' });
    console.log('[smoke] remote logo persistence, unsafe URL rejection, and local-image restore passed');

    await start(original.id, 'dev');
    await running(original.id, 'dev');
    await output(original.id, `${token}:DEV_READY`);
    await output(original.id, `${token}:DEV_STDERR`);
    const activePID = (await project(original.id)).runtime.pid;
    const hidden = (await api<{ project: Project }>('PATCH', `/api/projects/${original.id}`, { hidden: true })).project;
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.runtime.pid, activePID, 'Hiding must not stop or replace the running process');
    assert.equal((await project(original.id)).hidden, true, 'Hidden entries remain manageable in the API');
    await rejected('PATCH', `/api/projects/${original.id}`, { hidden: 'true' });
    const shown = (await api<{ project: Project }>('PATCH', `/api/projects/${original.id}`, { hidden: false })).project;
    assert.equal(shown.hidden, false);
    assert.equal(shown.runtime.pid, activePID);
    console.log('[smoke] hide/show persistence, validation, and running-process preservation passed');
    await stop(original.id, 'dev');
    console.log('[smoke] dev start, stdout/stderr logs, and child-process stop passed');

    await start(original.id, 'build');
    await output(original.id, `${token}:BUILD_DONE`);
    const built = await poll('finite build completion', () => project(original.id), value =>
      value.runtime.status === 'stopped' && value.runtime.pid === null);
    assert.equal(built.runtime.exitCode, 0);
    assert.equal(await readFile(join(fixture, 'build-marker'), 'utf8'), token);
    assert.deepEqual(await events(), ['dev', 'build']);
    await rm(join(fixture, 'build-marker'));
    const eventOffset = (await events()).length;
    await start(original.id, 'prod');
    await running(original.id, 'prod');
    await output(original.id, `${token}:PROD_READY`);
    assert.deepEqual((await events()).slice(eventOffset), ['build', 'prod'], 'Production must build before running');
    assert.equal(await readFile(join(fixture, 'build-marker'), 'utf8'), token);
    await stop(original.id, 'prod');
    console.log('[smoke] finite build and build-then-prod lifecycle passed');

    const duplicate = track((await api<{ project: Project }>('POST', `/api/projects/${original.id}/duplicate`, {
      name: name('config duplicate'), copyFiles: false,
    })).project);
    assert.notEqual(duplicate.id, original.id);
    assert.equal(duplicate.directory, fixture);
    assert.equal(duplicate.devCommand, saved.devCommand);
    assert.equal(duplicate.buildCommand, saved.buildCommand);
    assert.equal(duplicate.prodCommand, saved.prodCommand);
    assert.equal(duplicate.hostname, 'beelinkk');
    assert.equal(duplicate.runtime.status, 'stopped');
    const copied = track((await api<{ project: Project }>('POST', `/api/projects/${original.id}/duplicate`, {
      name: name('copied duplicate'), directory: copy, copyFiles: true,
    })).project);
    assert.notEqual(copied.id, original.id);
    assert.notEqual(copied.id, duplicate.id);
    assert.equal(copied.directory, copy);
    assert.equal(await readFile(join(copy, 'README.md'), 'utf8'), await readFile(join(fixture, 'README.md'), 'utf8'));
    assert.equal(await exists(join(copy, 'node_modules')), false, 'Copy must exclude node_modules');
    console.log('[smoke] configuration duplicate and safe sibling copy excluding node_modules passed');

    await rejected('POST', '/api/projects', {
      name: name('invalid service'), kind: 'service', url: 'javascript:alert(1)',
    });
    const serviceURL = 'http://127.0.0.1:65432/health?smoke=1#fixture';
    const service = await create({ name: name('service'), kind: 'service', url: serviceURL, hostname: '' });
    assert.equal(service.kind, 'service');
    assert.equal((await project(service.id)).url, serviceURL);
    console.log('[smoke] URL-only service registration and unsafe URL rejection passed');

    for (const id of [duplicate.id, copied.id, service.id, original.id]) await removeRegistration(id);
    assert.ok((await stat(fixture)).isDirectory(), 'Deletion must retain the original directory');
    assert.ok((await stat(copy)).isDirectory(), 'Deletion must retain the copied directory');
    assert.ok(await exists(join(fixture, 'README.md')));
    assert.ok(await exists(join(copy, 'README.md')));
    assert.equal((await projects()).filter(item => names.has(item.name)).length, 0);
    console.log('[smoke] registration deletion retains fixture directories');
  } catch (error) {
    failed = true;
    testError = error;
  } finally {
    await cleanup();
  }

  if (failed || cleanupErrors.length) {
    throw new AggregateError([
      ...(failed ? [testError] : []),
      ...cleanupErrors.map(message => new Error(message)),
    ], 'Smoke checks or cleanup failed');
  }
  console.log('[smoke] All checks passed; registrations, processes, and disposable directories cleaned up.');
}

await main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
