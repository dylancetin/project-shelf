import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { ProcessManager } from '../server/processes';
import { inferPort, inferRunCommand, scanRoots } from '../server/scanner';
import { Store } from '../server/store';
import { cleanup, files, fixture, until } from './helpers';

describe('recursive discovery', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await fixture();
    store = new Store(':memory:', { roots: [root], defaultHostname: 'beelinkk' });
  });
  afterEach(async () => { store.close(); await cleanup(root); });

  test('discovers nested JS and non-JS manifests, infers scripts/config, skips caches and symlinks', async () => {
    await files(root, {
      'web/package.json': JSON.stringify({ name: 'Studio', packageManager: 'pnpm@10.0.0', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' } }),
      'web/vite.config.ts': 'export default { server: { port: 6123 } }',
      'web/packages/nested/package.json': JSON.stringify({ name: 'Nested', scripts: { dev: 'next dev --port=4123', start: 'next start', build: 'next build' } }),
      'web/pnpm-lock.yaml': 'lockfileVersion: 9',
      'python/pyproject.toml': '[project]\nname = "python-tool"',
      'rust/Cargo.toml': '[package]\nname = "rust-tool"',
      'web/node_modules/ignored/package.json': '{}',
      'web/.git/ignored/package.json': '{}',
      'web/dist/ignored/package.json': '{}',
      'web/.cache/ignored/package.json': '{}',
      'ordinary/notes.txt': 'Not a project',
    });
    await symlink(path.join(root, 'web'), path.join(root, 'linked-web'));
    const result = await scanRoots(store);
    expect(result).toMatchObject({ added: 4, existing: 0, scanned: 4, errors: [] });
    const studio = store.list().find((item) => item.name === 'Studio')!;
    expect(studio).toMatchObject({ devCommand: 'pnpm run dev --host 0.0.0.0 --port "$PORT" --strictPort', buildCommand: 'pnpm run build', prodCommand: 'pnpm run preview --host 0.0.0.0 --port "$PORT" --strictPort', port: 6123, url: 'http://localhost:6123/', hostname: 'beelinkk' });
    expect(store.list().find((item) => item.name === 'Nested')).toMatchObject({ devCommand: 'pnpm exec next dev --hostname 0.0.0.0 --port "$PORT"', prodCommand: 'pnpm run start --hostname 0.0.0.0 --port "$PORT"', port: 4123 });
    expect(store.list().find((item) => item.name === 'python-tool')).toMatchObject({ devCommand: '', buildCommand: '', prodCommand: '', port: null });
  });

  test('rescan is idempotent and does not overwrite any edited fields', async () => {
    await files(root, { 'app/package.json': JSON.stringify({ name: 'Original', scripts: { dev: 'vite' } }) });
    await scanRoots(store);
    const saved = store.list()[0]!;
    expect(saved.hidden).toBe(false);
    store.update({ ...saved, name: 'My chosen name', devCommand: 'custom command', prodCommand: 'custom production', hostname: '', favorite: true, hidden: true, port: 9000 });
    await files(root, { 'app/package.json': JSON.stringify({ name: 'Changed manifest', scripts: { dev: 'next dev' } }) });
    const result = await scanRoots(store, [root, path.join(root, 'app')]);
    expect(result).toMatchObject({ added: 0, existing: 1, scanned: 1 });
    expect(store.list()).toHaveLength(1);
    expect(store.get(saved.id)).toMatchObject({ name: 'My chosen name', devCommand: 'custom command', prodCommand: 'custom production', hostname: '', favorite: true, hidden: true, port: 9000 });
    expect(store.settings().lastScanAt).not.toBeNull();
  });

  test('skips examples and test fixtures inside projects without losing nested apps or packages', async () => {
    await files(root, {
      'proxy/go.mod': 'module example.local/proxy',
      'proxy/examples/plugin/Makefile': 'all:',
      'proxy/examples/plugin/go/go.mod': 'module example.local/plugin',
      'proxy/examples/plugin/rust/Cargo.toml': '[package]\nname = "example-plugin"',
      'proxy/examples/plugin/c/CMakeLists.txt': 'project(example_plugin)',
      'proxy/internal/pluginhost/testdata/reload/go.mod': 'module example.local/reload',
      'proxy/tests/integration/package.json': '{}',
      'proxy/test/fixture/package.json': '{}',
      'proxy/__tests__/fixture/package.json': '{}',
      'proxy/fixtures/app/package.json': '{}',
      'proxy/__fixtures__/app/package.json': '{}',
      'proxy/Samples/broken/package.json': '{bad',
      'proxy/demo/package.json': '{}',
      'proxy/apps/web/package.json': '{"name":"Web","scripts":{"dev":"vite"}}',
      'proxy/packages/sdk/package.json': '{"name":"SDK"}',
      'collection/examples/standalone/package.json': '{"name":"Standalone"}',
    });
    expect(await scanRoots(store)).toMatchObject({ added: 4, scanned: 4, existing: 0, errors: [] });
    expect(store.list().map(item => item.name).sort()).toEqual(['SDK', 'Standalone', 'Web', 'proxy']);
    expect(await scanRoots(store)).toMatchObject({ added: 0, scanned: 4, existing: 4, errors: [] });
  });

  test('explicit roots opt into examples, and later scans preserve their saved registrations and edits', async () => {
    const example = path.join(root, 'proxy/examples/app');
    await files(root, {
      'proxy/go.mod': 'module example.local/proxy',
      'proxy/examples/app/package.json': '{"name":"Example","scripts":{"dev":"vite"}}',
    });
    expect(await scanRoots(store, [root, example])).toMatchObject({ added: 2, scanned: 2, errors: [] });
    const saved = store.byDirectory(example)!;
    store.update({ ...saved, name: 'My example', devCommand: 'custom command', favorite: true, hidden: true });
    expect(await scanRoots(store)).toMatchObject({ added: 0, scanned: 1, existing: 1, errors: [] });
    expect(store.get(saved.id)).toMatchObject({ name: 'My example', devCommand: 'custom command', favorite: true, hidden: true });
    expect(store.list()).toHaveLength(2);
    expect(await scanRoots(store, [example, root])).toMatchObject({ added: 0, scanned: 2, existing: 2, errors: [] });
  });

  test('missing roots and malformed manifests are reported without aborting healthy roots', async () => {
    await files(root, { 'broken/package.json': '{bad', 'healthy/go.mod': 'module example.local/tool' });
    const result = await scanRoots(store, [path.join(root, 'missing'), root]);
    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(store.list()[0]!.devCommand).toBe('');
  });

  test('port inference supports script flags, env assignments, framework defaults, and rejects invalid ports', () => {
    expect(inferPort({ dev: 'PORT=8044 node app.js' })).toBe(8044);
    expect(inferPort({ dev: 'next dev -p 4500' })).toBe(4500);
    expect(inferPort({ dev: 'astro dev' })).toBe(4321);
    expect(inferPort({ dev: 'vite' })).toBe(5173);
    expect(inferPort({}, 'PORT=3400')).toBe(3400);
    expect(inferPort({}, '', { port: '8000' })).toBe(8000);
    expect(inferPort({ dev: 'node app --port=99999' })).toBeNull();
    expect(inferPort({ preview: 'vite preview' })).toBe(4173);
    expect(inferPort({ 'start:prod': 'next start' })).toBe(3000);
  });

  test('new discovered projects default to the LAN hostname without overriding an explicit default', async () => {
    store.setValue('settings', { ...store.settings(), defaultHostname: '' });
    await files(root, { 'first/package.json': '{"name":"First","scripts":{"dev":"vite"}}' });
    await scanRoots(store);
    expect(store.list().find((item) => item.name === 'First')?.hostname).toBe('beelinkk');
    store.setValue('settings', { ...store.settings(), defaultHostname: 'nas.local' });
    await files(root, { 'second/go.mod': 'module second' });
    await scanRoots(store);
    expect(store.list().find((item) => item.name === 'second')?.hostname).toBe('nas.local');
    expect(store.list().find((item) => item.name === 'First')?.hostname).toBe('beelinkk');
  });

  test('recognizes direct Vite/Astro/Next server scripts with package-manager-specific forwarding', () => {
    expect(inferRunCommand('npm', 'dev', 'vite', 5173)).toBe('npm run dev -- --host 0.0.0.0 --port "$PORT" --strictPort');
    expect(inferRunCommand('bun', 'preview', 'vite preview --mode staging', 5173)).toBe('bun run preview --host 0.0.0.0 --port "$PORT" --strictPort');
    expect(inferRunCommand('pnpm', 'dev', 'astro dev', 4321)).toBe('pnpm run dev --host 0.0.0.0 --port "$PORT"');
    expect(inferRunCommand('npm', 'preview', 'astro preview', 4321)).toBe('npm run preview -- --host 0.0.0.0 --port "$PORT"');
    expect(inferRunCommand('pnpm', 'start', 'next start', 3000)).toBe('pnpm run start --hostname 0.0.0.0 --port "$PORT"');
    expect(inferRunCommand('yarn', 'dev', 'next dev --turbo', 3000)).toBe('yarn run dev --hostname 0.0.0.0 --port "$PORT"');
    expect(inferRunCommand('npm', 'build', 'vite build', 5173)).toBe('npm run build');
  });

  test('replaces fixed framework binding flags rather than appending duplicate --port values', () => {
    expect(inferRunCommand('npm', 'dev', 'vite --host localhost --port=3000 --config "config file.ts"', 6100))
      .toBe('npm exec --offline --no -- vite --config "config file.ts" --host 0.0.0.0 --port "$PORT" --strictPort');
    expect(inferRunCommand('bun', 'dev', 'next dev -p 3000 -H localhost --turbo', 6100))
      .toBe('bun x --no-install next dev --turbo --hostname 0.0.0.0 --port "$PORT"');
  });

  test('leaves compound scripts, wrappers, assignments, expansions and unknown frameworks alone', () => {
    for (const script of [
      'turbo dev', 'npx vite', 'cross-env NODE_ENV=development vite', 'PORT=8123 vite',
      'vite && node post.js', 'echo before; vite', 'vite | tee output.log',
      'vite --port "$CUSTOM_PORT"', 'vite --config $(node config.js)', 'vite # a comment',
      'vite --config "unterminated', 'vite -- --port 1234', 'node scripts/dev.js', 'next custom-server',
    ]) {
      expect(inferRunCommand('npm', 'dev', script, 6100)).toBe('npm run dev');
    }
  });

  test('inferred npm/Bun Vite preview commands pass the configured port and LAN host to a disposable binary', async () => {
    const manager = new ProcessManager({ stopGraceMs: 100 });
    try {
      for (const pm of ['npm', 'bun']) {
        for (const variant of ['plain', 'fixed']) {
          const directory = path.join(root, `${pm}-${variant}`);
          const capture = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync('captured.json',JSON.stringify({args:process.argv.slice(2),port:process.env.PORT,host:process.env.HOST,mode:process.env.NODE_ENV}));`;
          await files(directory, {
            'package.json': JSON.stringify({ name: `fixture-${pm}-${variant}`, packageManager: `${pm}@1.0.0`, scripts: {
              dev: 'vite', preview: variant === 'plain' ? 'vite preview' : 'vite preview --host localhost --port=4173 --mode "staging"',
            } }),
            'node_modules/.bin/vite': capture,
          });
          await chmod(path.join(directory, 'node_modules/.bin/vite'), 0o755);
        }
      }
      await scanRoots(store);
      for (const pm of ['npm', 'bun']) {
        for (const variant of ['plain', 'fixed']) {
          const item = store.list().find((entry) => entry.name === `fixture-${pm}-${variant}`)!;
          item.port = 6381;
          await manager.start(item, 'prod');
          await until(() => !manager.active(item.id));
          expect(manager.runtime(item.id).exitCode).toBe(0);
          expect(JSON.parse(await readFile(path.join(item.directory, 'captured.json'), 'utf8'))).toEqual({
            args: ['preview', ...(variant === 'fixed' ? ['--mode', 'staging'] : []), '--host', '0.0.0.0', '--port', '6381', '--strictPort'],
            port: '6381', host: '0.0.0.0', mode: 'production',
          });
        }
      }
    } finally { await manager.close(); }
  });
});
