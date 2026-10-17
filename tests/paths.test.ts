import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { confinedFile, copyProject, isWithin, safeRelative } from '../server/paths';
import { findLogos, serveLogo } from '../server/logos';
import { cleanup, files, fixture } from './helpers';

describe('filesystem boundaries and file copying', () => {
  let root: string;
  beforeEach(async () => { root = await fixture(); });
  afterEach(async () => { await cleanup(root); });

  test('rejects traversal, absolute paths, backslashes and symlinks escaping a project', async () => {
    await files(root, { 'project/public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'secret.svg': '<svg>secret</svg>' });
    const project = path.join(root, 'project');
    await symlink(path.join(root, 'secret.svg'), path.join(project, 'escape.svg'));
    for (const input of ['../secret.svg', '/secret.svg', 'public/../../secret.svg', 'public\\logo.svg', './public/logo.svg', 'public//logo.svg', 'x\0.svg']) {
      expect(() => safeRelative(input)).toThrow();
    }
    await expect(confinedFile(project, 'escape.svg')).rejects.toMatchObject({ status: 403 });
    expect(await confinedFile(project, 'public/logo.svg')).toBe(path.join(project, 'public/logo.svg'));
    expect(isWithin('/tmp/app', '/tmp/application/file')).toBe(false);
  });

  test('real duplicate copies useful files, skips generated folders and symlinks, never overwrites', async () => {
    await files(root, {
      'source/package.json': '{"name":"fixture"}', 'source/src/app.ts': 'console.log("fixture")',
      'source/node_modules/library/index.js': 'generated', 'source/.git/config': 'git data',
      'source/dist/output.js': 'generated', 'source/.next/cache/file': 'generated', 'secret.txt': 'secret',
    });
    await symlink(path.join(root, 'secret.txt'), path.join(root, 'source/link'));
    const destination = path.join(root, 'duplicate');
    expect(await copyProject(path.join(root, 'source'), destination)).toBe(destination);
    expect(await readFile(path.join(destination, 'src/app.ts'), 'utf8')).toContain('fixture');
    for (const excluded of ['node_modules/library/index.js', '.git/config', 'dist/output.js', '.next/cache/file', 'link']) {
      expect(await Bun.file(path.join(destination, excluded)).exists()).toBe(false);
    }
    await expect(copyProject(path.join(root, 'source'), destination)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(destination, 'package.json'), 'utf8')).toBe('{"name":"fixture"}');
    await expect(copyProject(path.join(root, 'source'), path.join(root, 'source/nested-copy'))).rejects.toMatchObject({ status: 400 });
  });

  test('symlinked destination parents are resolved before checking copy recursion', async () => {
    await mkdir(path.join(root, 'source'));
    await symlink(path.join(root, 'source'), path.join(root, 'alias'));
    await expect(copyProject(path.join(root, 'source'), path.join(root, 'alias/copy'))).rejects.toMatchObject({ status: 400 });
  });

  test('logo discovery ignores symlinks and caches; serving requires real image content and sandboxes SVG', async () => {
    await files(root, {
      'project/public/brand-logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'project/public/fake.png': '<html>not an image</html>',
      'project/node_modules/hidden-logo.svg': '<svg></svg>',
      'project/notes.txt': 'private text', 'outside.svg': '<svg></svg>',
    });
    const project = path.join(root, 'project');
    await symlink(path.join(root, 'outside.svg'), path.join(project, 'outside-logo.svg'));
    const logos = await findLogos(project, 'fixture-id');
    expect(logos.map((item) => item.path)).toContain('public/brand-logo.svg');
    expect(logos.some((item) => item.path.includes('node_modules') || item.path.includes('outside'))).toBe(false);
    const response = await serveLogo(project, 'public/brand-logo.svg');
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    await expect(serveLogo(project, 'public/fake.png')).rejects.toMatchObject({ status: 400 });
    await expect(serveLogo(project, 'notes.txt')).rejects.toMatchObject({ status: 400 });
    await expect(serveLogo(project, 'outside-logo.svg')).rejects.toMatchObject({ status: 403 });
  });
});
