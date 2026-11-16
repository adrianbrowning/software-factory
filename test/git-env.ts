import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Tests never read the developer's git config (signing, hooks, default branch).
// The test script preloads this with --import, so it runs before any test file and every git call (helpers.ts sh(), src/exec.ts) inherits the override. Test files do not import it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

// The suite starts thousands of git processes, so the git binary's start-up time sets its wall time. A git earlier on
// PATH than the system one can be an x86_64 build under Rosetta on an Apple Silicon Mac, which starts much slower.
// Tests run the system git when there is one.
// Only git is redirected: a directory holding just a `git` symlink goes first on PATH, so node, sh, pnpm and every
// other tool still resolve as they do outside the tests. One fixed directory serves every test process; they run in
// parallel, so a process that loses the race to create the symlink finds it already in place.
if (existsSync('/usr/bin/git') && spawnSync('/usr/bin/git', ['--version']).status === 0) {
  const gitDir = join(tmpdir(), 'test-git-shim');
  mkdirSync(gitDir, { recursive: true });
  try {
    symlinkSync('/usr/bin/git', join(gitDir, 'git'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  process.env.PATH = `${gitDir}${delimiter}${process.env.PATH ?? ''}`;
}
