import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment, ProcessManager } from '../server/processes';
import { cleanup, files, fixture, project, shellCommand, until } from './helpers';

async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

describe('managed process lifecycle (temporary fixtures only)', () => {
  let root: string;
  let manager: ProcessManager;
  beforeEach(async () => { root = await fixture(); manager = new ProcessManager({ stopGraceMs: 160 }); });
  afterEach(async () => { await manager.close(); await cleanup(root); });

  test('dev starts once, captures stdout/stderr, and stops cleanly', async () => {
    await files(root, { 'dev.js': 'console.log("fixture stdout"); console.error("fixture stderr"); setInterval(() => {}, 1000);' });
    const item = project(root, { devCommand: shellCommand(path.join(root, 'dev.js')) });
    await manager.start(item, 'dev');
    await until(() => manager.logs(item.id).some((line) => line.text === 'fixture stderr'));
    expect(manager.runtime(item.id)).toMatchObject({ status: 'running', mode: 'dev' });
    expect(manager.runtime(item.id).pid).toBeGreaterThan(0);
    await expect(manager.start(item, 'dev')).rejects.toMatchObject({ status: 409 });
    await manager.stop(item.id);
    expect(manager.runtime(item.id)).toMatchObject({ status: 'stopped', pid: null });
    expect(manager.logs(item.id).some((line) => line.stream === 'stdout' && line.text === 'fixture stdout')).toBe(true);
    expect(manager.logs(item.id).every((line, index, lines) => index === 0 || line.id > lines[index - 1]!.id)).toBe(true);
  });

  test('production executes build before run; build-only does not execute production', async () => {
    const item = project(root, {
      buildCommand: 'printf "build\\n" >> order.txt', prodCommand: 'printf "run\\n" >> order.txt',
    });
    await manager.start(item, 'prod');
    await until(() => !manager.active(item.id));
    expect(await readFile(path.join(root, 'order.txt'), 'utf8')).toBe('build\nrun\n');
    expect(manager.runtime(item.id)).toMatchObject({ status: 'stopped', mode: 'prod', exitCode: 0 });
    await manager.start(item, 'build');
    await until(() => !manager.active(item.id));
    expect(await readFile(path.join(root, 'order.txt'), 'utf8')).toBe('build\nrun\nbuild\n');
  });

  test('failed production builds prevent run and expose the exit code', async () => {
    const item = project(root, { buildCommand: 'echo build-failed >&2; exit 7', prodCommand: 'echo should-not-run > unexpected.txt' });
    await manager.start(item, 'prod');
    await until(() => !manager.active(item.id));
    expect(manager.runtime(item.id)).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(await Bun.file(path.join(root, 'unexpected.txt')).exists()).toBe(false);
    expect(manager.logs(item.id).some((line) => line.stream === 'stderr' && line.text === 'build-failed')).toBe(true);
  });

  test('stop escalates for TERM-resistant process groups and kills grandchildren', async () => {
    await files(root, {
      'child.js': 'import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync("child-ready", String(process.pid)); setInterval(()=>{},1000);',
      'tree.js': `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['child.js'],{stdio:'ignore'}); writeFileSync('tree.json',JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);`,
    });
    const item = project(root, { devCommand: shellCommand(path.join(root, 'tree.js')) });
    await manager.start(item, 'dev');
    await until(() => Bun.file(path.join(root, 'child-ready')).exists());
    const pids = JSON.parse(await readFile(path.join(root, 'tree.json'), 'utf8')) as { parent: number; child: number };
    expect(await alive(pids.parent)).toBe(true);
    expect(await alive(pids.child)).toBe(true);
    await manager.stop(item.id);
    await until(async () => !(await alive(pids.parent)) && !(await alive(pids.child)));
    expect(manager.logs(item.id).some((line) => line.text.includes('SIGKILL'))).toBe(true);
  });

  test('naturally exiting shell commands do not orphan background descendants', async () => {
    const item = project(root, { devCommand: 'sleep 60 & echo $! > background.pid; exit 0' });
    await manager.start(item, 'dev');
    await until(() => !manager.active(item.id));
    const pid = Number(await readFile(path.join(root, 'background.pid'), 'utf8'));
    await until(async () => !(await alive(pid)));
  });

  test('logs are bounded even for huge unterminated output', async () => {
    manager = new ProcessManager({ maxLogLines: 12, maxLineLength: 64, stopGraceMs: 100 });
    await files(root, { 'noisy.js': 'process.stdout.write("x".repeat(100000)); process.stderr.write("last stderr");' });
    const item = project(root, { buildCommand: shellCommand(path.join(root, 'noisy.js')) });
    await manager.start(item, 'build');
    await until(() => !manager.active(item.id));
    const logs = manager.logs(item.id);
    expect(logs.length).toBeLessThanOrEqual(12);
    expect(logs.every((line) => line.text.length <= 64)).toBe(true);
    expect(logs.some((line) => line.text === 'last stderr')).toBe(true);
  });

  test('shutdown stops all managed groups and refuses new starts', async () => {
    const item = project(root, { devCommand: 'sleep 60' });
    await manager.start(item, 'dev');
    await until(() => manager.runtime(item.id).pid !== null);
    const pid = manager.runtime(item.id).pid!;
    await manager.close();
    await until(async () => !(await alive(pid)));
    expect(manager.runtime(item.id).status).toBe('stopped');
    await expect(manager.start(item, 'dev')).rejects.toMatchObject({ status: 503 });
  });

  test('concurrent start requests launch one process group only', async () => {
    const item = project(root, { devCommand: 'sleep 60' });
    const results = await Promise.allSettled([manager.start(item, 'dev'), manager.start(item, 'dev')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  test('child environment removes panel-only settings without mutating the parent environment', () => {
    const inherited = { PORT: '4958', API_PORT: '4959', PANEL_DB_PATH: '/panel.sqlite', HOST: '127.0.0.1', NODE_ENV: 'production', PATH: '/kept/path' };
    expect(childEnvironment({ port: null }, 'dev', inherited)).toEqual({ HOST: '0.0.0.0', NODE_ENV: 'development', PATH: '/kept/path' });
    expect(childEnvironment({ port: 6100 }, 'build', inherited)).toEqual({ PORT: '6100', HOST: '0.0.0.0', NODE_ENV: 'production', PATH: '/kept/path' });
    expect(childEnvironment({ port: 6200 }, 'prod', inherited).PORT).toBe('6200');
    expect(inherited.PORT).toBe('4958');
    expect(inherited.API_PORT).toBe('4959');
  });

  test('actual spawned fixtures do not inherit the panel port/database and honor run-mode environments', async () => {
    await files(root, {
      'environment.js': `import {writeFileSync} from 'node:fs'; const keys=['PORT','API_PORT','PANEL_DB_PATH','HOST','NODE_ENV']; writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(Object.fromEntries(keys.map(key=>[key,process.env[key]??null]))));`,
    });
    const inherited = { PORT: '4958', API_PORT: '4959', PANEL_DB_PATH: '/panel-only.sqlite', HOST: '127.0.0.1', NODE_ENV: 'production' };
    const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited);
    const command = shellCommand(path.join(root, 'environment.js'));
    const item = project(root, {
      devCommand: `CAPTURE_FILE=dev.json ${command}`,
      buildCommand: `CAPTURE_FILE=build.json ${command}`,
      prodCommand: `CAPTURE_FILE=prod.json ${command}`,
    });
    try {
      await manager.start(item, 'dev');
      await until(() => !manager.active(item.id));
      expect(JSON.parse(await readFile(path.join(root, 'dev.json'), 'utf8'))).toEqual({
        PORT: null, API_PORT: null, PANEL_DB_PATH: null, HOST: '0.0.0.0', NODE_ENV: 'development',
      });
      item.port = 6250;
      for (const mode of ['dev', 'build', 'prod'] as const) {
        await manager.start(item, mode);
        await until(() => !manager.active(item.id));
        expect(JSON.parse(await readFile(path.join(root, `${mode}.json`), 'utf8'))).toEqual({
          PORT: '6250', API_PORT: null, PANEL_DB_PATH: null, HOST: '0.0.0.0', NODE_ENV: mode === 'dev' ? 'development' : 'production',
        });
      }
      // Prod's build phase must receive production too, not the inherited/dev mode.
      expect(JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8')).NODE_ENV).toBe('production');
      expect(process.env.PORT).toBe('4958');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('explicit shell environment assignments still override the project launch defaults', async () => {
    const item = project(root, {
      port: 6250,
      devCommand: 'PORT=9250 HOST=127.0.0.2 NODE_ENV=custom /bin/sh -c \'printf "%s|%s|%s" "$PORT" "$HOST" "$NODE_ENV" > explicit-env.txt\'',
    });
    await manager.start(item, 'dev');
    await until(() => !manager.active(item.id));
    expect(await readFile(path.join(root, 'explicit-env.txt'), 'utf8')).toBe('9250|127.0.0.2|custom');
  });
});
