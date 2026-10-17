import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ScanResult } from '../shared/types';
import { errorMessage } from './errors';
import { IGNORED_DIRECTORIES, isWithin } from './paths';
import { Store, type ProjectData } from './store';

const OTHER_MANIFESTS = new Map([
  ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['Pipfile', 'Python'],
  ['setup.py', 'Python'], ['Cargo.toml', 'Rust'], ['go.mod', 'Go'], ['pom.xml', 'Java'],
  ['build.gradle', 'Java'], ['build.gradle.kts', 'Kotlin'], ['composer.json', 'PHP'],
  ['Gemfile', 'Ruby'], ['mix.exs', 'Elixir'], ['pubspec.yaml', 'Dart'],
  ['Package.swift', 'Swift'], ['CMakeLists.txt', 'C/C++'], ['Makefile', 'Make'],
]);

// Only skip these inside a discovered project. They are source files worth
// copying, but their manifests usually belong to examples or test fixtures,
// not independent Shelf destinations. An explicit scan root can opt back in.
const AUXILIARY_DIRECTORIES = new Set([
  'example', 'examples', 'sample', 'samples', 'demo', 'demos',
  'test', 'tests', '__tests__', 'testdata', 'fixtures', '__fixtures__',
]);

async function smallText(filename: string): Promise<string> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) return '';
    return await readFile(filename, 'utf8');
  } catch {
    return '';
  }
}

function validPort(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null;
}

export function inferPort(scripts: Record<string, string>, config = '', packageConfig?: unknown): number | null {
  for (const script of [scripts.dev, scripts.serve, scripts.start, scripts['start:prod'], scripts.preview].filter(Boolean)) {
    const match = script.match(/(?:--port(?:[=\s]+)|(?:^|\s)-p\s+|\bPORT\s*=\s*)["']?(\d{1,5})\b/i);
    if (match && validPort(match[1])) return validPort(match[1]);
  }
  if (packageConfig && typeof packageConfig === 'object' && 'port' in packageConfig) {
    const found = validPort((packageConfig as { port: unknown }).port);
    if (found) return found;
  }
  const explicit = config.match(/\b(?:port|serverPort)\s*:\s*["']?(\d{1,5})\b/)
    ?? config.match(/^\s*(?:PORT|VITE_PORT|NUXT_PORT)\s*=\s*["']?(\d{1,5})\b/m);
  if (explicit && validPort(explicit[1])) return validPort(explicit[1]);
  const command = scripts.dev || scripts.start || scripts.serve || scripts['start:prod'] || scripts.preview || '';
  if (/\bastro\b/.test(command)) return 4321;
  if (/^\s*vite\s+preview\b/.test(command)) return 4173;
  if (/\b(?:vite|svelte-kit)\b/.test(command)) return 5173;
  if (/\b(?:next|nuxt|react-scripts|remix)\b/.test(command)) return 3000;
  if (/\bng\s+serve\b/.test(command)) return 4200;
  if (/\bvue-cli-service\b/.test(command)) return 8080;
  if (/\bparcel\b/.test(command)) return 1234;
  return null;
}

interface ShellWord { raw: string; value: string }

/** Deliberately not a general shell parser. Anything executable/compound stays untouched. */
function simpleWords(script: string): ShellWord[] | null {
  if (/[;&|<>`$()\\\n\r*?{}~#]/.test(script)) return null;
  const words: ShellWord[] = [];
  let cursor = 0;
  for (const match of script.matchAll(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)) {
    if (script.slice(cursor, match.index).trim()) return null;
    words.push({ raw: match[0], value: match[0].replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double) });
    cursor = match.index! + match[0].length;
  }
  return script.slice(cursor).trim() ? null : words;
}

/** Add LAN binding only to a direct, recognizable framework server command. */
export function inferRunCommand(manager: string, name: string | undefined, script: string | undefined, port: number | null): string {
  if (!name || !script) return '';
  const original = `${manager} run ${name}`;
  const words = simpleWords(script);
  if (!words?.length || words.some((word) => ['--', '--help', '-h', '--version', '-v'].includes(word.value))) return original;
  const framework = words[0]!.value;
  const subcommand = words[1]?.value;
  const recognized = framework === 'vite'
    ? !subcommand || subcommand.startsWith('-') || ['dev', 'serve', 'preview'].includes(subcommand)
    : framework === 'astro' ? ['dev', 'preview'].includes(subcommand || '')
    : framework === 'next' && ['dev', 'start'].includes(subcommand || '');
  if (!recognized) return original;

  const args: ShellWord[] = [];
  let replacedBinding = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    const value = word.value;
    const portFlag = value === '--port' || (framework !== 'vite' && value === '-p');
    const hostFlag = value === '--host' || (framework === 'next' && ['--hostname', '-H'].includes(value));
    if (portFlag || hostFlag) {
      const argument = words[index + 1];
      if (argument && !argument.value.startsWith('-')) index++;
      else if (portFlag || (framework === 'next' && hostFlag)) return original;
      replacedBinding = true;
      continue;
    }
    if (/^--(?:port|host)=/.test(value) || (framework !== 'vite' && /^-p=?\d/.test(value))
      || (framework === 'next' && /^(?:--hostname=|-H=?[^-])/.test(value))) {
      replacedBinding = true;
      continue;
    }
    args.push(word);
  }

  const flags = [framework === 'next' ? '--hostname 0.0.0.0' : '--host 0.0.0.0'];
  if (port !== null) flags.push('--port "$PORT"');
  if (framework === 'vite') flags.push('--strictPort');
  if (!replacedBinding) {
    // npm consumes its own options until --; bun/pnpm/yarn forward arguments
    // following the script name directly. A literal -- breaks Bun forwarding.
    return `${original}${manager === 'npm' ? ' --' : ''} ${flags.join(' ')}`;
  }

  // Appending a second --port makes Vite receive an array, not an override.
  // For a simple script with fixed binding flags, invoke the local binary with
  // those flags replaced, retaining all other literal arguments. Never install.
  const binary = manager === 'npm' ? 'npm exec --offline --no --'
    : manager === 'pnpm' ? 'pnpm exec'
    : manager === 'bun' ? 'bun x --no-install' : 'yarn exec';
  return [binary, framework, ...args.map((word) => word.raw), ...flags].join(' ');
}

async function packageManager(directory: string, root: string, declared: unknown): Promise<string> {
  if (typeof declared === 'string') {
    const manager = declared.split('@')[0];
    if (['bun', 'npm', 'pnpm', 'yarn'].includes(manager)) return manager;
  }
  let current = directory;
  while (isWithin(root, current)) {
    const filenames = await readdir(current).catch(() => [] as string[]);
    if (filenames.includes('bun.lock') || filenames.includes('bun.lockb')) return 'bun';
    if (filenames.includes('pnpm-lock.yaml')) return 'pnpm';
    if (filenames.includes('yarn.lock')) return 'yarn';
    if (filenames.includes('package-lock.json') || filenames.includes('npm-shrinkwrap.json')) return 'npm';
    const ancestorPackage = await smallText(path.join(current, 'package.json'));
    try {
      const manager = JSON.parse(ancestorPackage).packageManager?.split('@')[0];
      if (['bun', 'npm', 'pnpm', 'yarn'].includes(manager)) return manager;
    } catch { /* An invalid manifest is reported by the scanner when visited. */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 'npm';
}

async function inferProject(directory: string, root: string, filenames: Set<string>): Promise<ProjectData | null> {
  const now = new Date().toISOString();
  const base: ProjectData = {
    id: crypto.randomUUID(), name: path.basename(directory), description: '', kind: 'project',
    directory, source: root, url: '', hostname: '', devCommand: '', buildCommand: '',
    prodCommand: '', port: null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now,
  };
  if (filenames.has('package.json')) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await smallText(path.join(directory, 'package.json')));
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Expected object');
    } catch {
      throw new Error(`Invalid or unreadable package.json: ${directory}`);
    }
    const scripts: Record<string, string> = {};
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [key, value] of Object.entries(pkg.scripts)) {
        if (typeof value === 'string') scripts[key] = value;
      }
    }
    const pm = await packageManager(directory, root, pkg.packageManager);
    // Names are chosen from a fixed list, never interpolated from executable manifest content.
    const devScript = ['dev', 'serve', 'start'].find((key) => scripts[key]);
    const prodScript = ['start:prod', 'start', 'preview', 'serve'].find((key) => scripts[key]);
    base.buildCommand = scripts.build ? `${pm} run build` : '';
    if (typeof pkg.name === 'string' && pkg.name.trim()) base.name = pkg.name.slice(0, 200);
    if (typeof pkg.description === 'string') base.description = pkg.description.slice(0, 8192);
    const configs: string[] = [];
    for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
      'vite.config.cts', 'vite.config.cjs', 'nuxt.config.ts', 'vue.config.js',
      'astro.config.mjs', 'astro.config.ts', '.env.local', '.env']) {
      if (filenames.has(file)) configs.push(await smallText(path.join(directory, file)));
    }
    base.port = inferPort(scripts, configs.join('\n'), pkg.config);
    base.devCommand = inferRunCommand(pm, devScript, devScript ? scripts[devScript] : undefined, base.port);
    base.prodCommand = inferRunCommand(pm, prodScript, prodScript ? scripts[prodScript] : undefined, base.port);
    if (base.port) base.url = `http://localhost:${base.port}/`;
    return base;
  }
  const manifest = [...filenames].find((file) => OTHER_MANIFESTS.has(file) || /\.(?:csproj|fsproj)$/.test(file));
  if (!manifest) return null;
  base.description = `${OTHER_MANIFESTS.get(manifest) || '.NET'} project · ${manifest}`;
  // Non-JavaScript projects intentionally have empty, user-editable commands.
  if (['pyproject.toml', 'Cargo.toml', 'composer.json', 'pubspec.yaml'].includes(manifest)) {
    const content = await smallText(path.join(directory, manifest));
    const match = content.match(/(?:^|\n)\s*["']?name["']?\s*[:=]\s*["']([^"'\n]+)["']/);
    if (match?.[1]) base.name = match[1].slice(0, 200);
  }
  return base;
}

export async function scanRoots(store: Store, roots = store.settings().roots): Promise<ScanResult> {
  const result: ScanResult = { added: 0, existing: 0, scanned: 0, errors: [] };
  const visited = new Set<string>();
  let directories = 0;
  const report = (message: string) => { if (result.errors.length < 100) result.errors.push(message); };
  for (const requested of roots) {
    let root: string;
    try {
      // Do not follow a supplied root that itself is a symlink, either.
      const info = await lstat(requested);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Root must be a directory, not a symlink');
      root = await realpath(requested);
    } catch (error) {
      report(`${requested}: ${errorMessage(error)}`);
      continue;
    }
    const queue: { directory: string; depth: number; insideProject: boolean }[] = [{ directory: root, depth: 0, insideProject: false }];
    while (queue.length) {
      const { directory, depth, insideProject } = queue.pop()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      if (++directories > 50_000) {
        report('Scan directory limit reached (50,000)');
        break;
      }
      if (depth > 30) { report(`Maximum scan depth reached: ${directory}`); continue; }
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const resolved = await realpath(directory);
        if (!isWithin(root, resolved)) continue;
        const entries = await readdir(resolved, { withFileTypes: true });
        const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
        const inferred = await inferProject(resolved, root, files).catch((error) => { report(errorMessage(error)); return null; });
        if (inferred) {
          result.scanned++;
          if (store.byDirectory(resolved)) result.existing++;
          else {
            inferred.hostname = store.settings().defaultHostname || 'beelinkk';
            store.insert(inferred);
            result.added++;
          }
        }
        const nestedProject = insideProject || inferred !== null;
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')
            && !(nestedProject && AUXILIARY_DIRECTORIES.has(entry.name.toLowerCase()))) {
            queue.push({ directory: path.join(resolved, entry.name), depth: depth + 1, insideProject: nestedProject });
          }
        }
      } catch (error) {
        report(`${directory}: ${errorMessage(error)}`);
      }
    }
    if (directories > 50_000) break;
  }
  store.setValue('settings', { ...store.settings(), lastScanAt: new Date().toISOString() });
  return result;
}
