import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mainCheckoutPath, owningProject } from '../server/project-owner';
import { cleanup, files, fixture } from './helpers';

// A main checkout with a linked worktree laid out the way `git worktree add` writes it.
describe('owning project for agent previews', () => {
  let root: string;
  let main: string;
  let worktree: string;
  beforeEach(async () => {
    root = await fixture();
    main = path.join(root, 'main');
    worktree = path.join(root, 'worktrees', 'feature');
    await files(root, {
      'main/.git/HEAD': 'ref: refs/heads/main\n',
      'main/.git/worktrees/feature/commondir': '../..\n',
      'main/apps/web/package.json': '{}',
      'worktrees/feature/.git': `gitdir: ${path.join(main, '.git/worktrees/feature')}\n`,
      'worktrees/feature/apps/web/src/index.ts': '',
      'submodule/.git': `gitdir: ${path.join(main, '.git/modules/lib')}\n`,
      'elsewhere/readme.md': '',
    });
  });
  afterEach(async () => { await cleanup(root); });

  const projects = () => [
    { id: 'root', kind: 'project', directory: main },
    { id: 'web', kind: 'project', directory: path.join(main, 'apps/web') },
    { id: 'link', kind: 'service', directory: path.join(main, 'apps/web/src') },
  ];

  test('maps a worktree location to the same place in the main checkout', async () => {
    expect(await mainCheckoutPath(path.join(worktree, 'apps/web/src'))).toBe(path.join(main, 'apps/web/src'));
    expect(await mainCheckoutPath(worktree)).toBe(main);
    expect(await mainCheckoutPath(path.join(main, 'apps/web'))).toBeNull();
    expect(await mainCheckoutPath(path.join(root, 'submodule'))).toBeNull();
    expect(await mainCheckoutPath(path.join(root, 'elsewhere'))).toBeNull();
  });

  test('picks the deepest registered project, directly or through the worktree', async () => {
    expect((await owningProject(path.join(main, 'apps/web/src'), projects()))?.id).toBe('web');
    expect((await owningProject(path.join(worktree, 'apps/web/src'), projects()))?.id).toBe('web');
    expect((await owningProject(worktree, projects()))?.id).toBe('root');
    expect(await owningProject(path.join(root, 'elsewhere'), projects())).toBeNull();
    // A sibling whose name only shares a prefix is not inside the project.
    expect(await owningProject(`${main}-copy`, projects())).toBeNull();
  });
});
