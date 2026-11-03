import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

// Tests never read the developer's git config (signing, hooks, default branch).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

export function sh(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Turns `root` into a git repository on `main` whose base commit holds `files` (path → content). */
export function initRepo(root: string, files: Record<string, string>) {
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  return root;
}

/** A temp git repository with a base commit of `files`, removed when the test `t` ends. */
export function tempRepo(t: TestContext, prefix: string, files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return initRepo(root, files);
}
