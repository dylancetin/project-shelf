import { copyFile, cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dir, '..');
const source = path.join(root, 'extension');
const outdir = path.join(source, 'dist');
await mkdir(outdir, { recursive: true });
await build({ configFile: path.join(source, 'vite.config.ts') });

const result = await Bun.build({
  entrypoints: ['bridge', 'options', 'popup'].map(name => path.join(source, 'src', `${name}.ts`)),
  outdir,
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: false,
  sourcemap: 'none',
});
if (!result.success) throw new AggregateError(result.logs, 'Extension build failed');

// A registered content script is a classic script, not a module, and shares its isolated world with
// any other script on the page: the IIFE format keeps its names private.
const content = await Bun.build({
  entrypoints: [path.join(source, 'src', 'content.ts')],
  outdir,
  target: 'browser',
  format: 'iife',
  minify: true,
  splitting: false,
  sourcemap: 'none',
});
if (!content.success) throw new AggregateError(content.logs, 'Extension content script build failed');

for (const name of await readdir(source)) {
  if (name !== 'newtab.html' && /\.(html|css|json)$/.test(name)) await copyFile(path.join(source, name), path.join(outdir, name));
}
await copyFile(path.join(root, 'public', 'pwa-192.png'), path.join(outdir, 'icon.png'));
await cp(path.join(root, 'public', 'service-icons'), path.join(outdir, 'service-icons'), { recursive: true });
console.log(`Chrome extension built: ${outdir} (content.js ${(Bun.file(path.join(outdir, 'content.js')).size / 1024).toFixed(1)} KiB)\nIn chrome://extensions, enable Developer mode and Load unpacked using this directory.`);
