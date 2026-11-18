import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Tests never read the developer's git config (signing, hooks, default branch).
// The test script preloads this with --import, so it runs before any test file and every git call (helpers.ts sh(), src/exec.ts) inherits the override. Test files do not import it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Git 2.56 (and other recent versions) starts a detached `git maintenance run --auto` after each commit. It locks and unlinks
// .git/objects/maintenance.lock after the commit returns, so a cpSync of a just-built template repo (helpers.ts
// tempRepo) can fail with ENOENT on .git/objects. No test needs auto maintenance.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'maintenance.auto';
process.env.GIT_CONFIG_VALUE_0 = 'false';

// The suite starts thousands of git processes, so the git binary's start-up time sets its wall time. A git earlier on
// PATH than the system one can be an x86_64 build under Rosetta on an Apple Silicon Mac, which starts much slower.
// Tests run the system git when there is one.
// Only git is redirected: a directory holding just a `git` symlink goes first on PATH, so node, sh, pnpm and every
// other tool still resolves as it does outside the tests. Each test process makes its own private (0700) directory and removes it on exit, so no shared tmp path is trusted.
if (existsSync('/usr/bin/git') && spawnSync('/usr/bin/git', ['--version']).status === 0) {
  const gitDir = mkdtempSync(join(tmpdir(), 'test-git-shim-'));
  symlinkSync('/usr/bin/git', join(gitDir, 'git'));
  process.once('exit', () => rmSync(gitDir, { recursive: true, force: true }));
  process.env.PATH = `${gitDir}${delimiter}${process.env.PATH ?? ''}`;
}
