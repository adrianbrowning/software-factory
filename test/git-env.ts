import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

// Tests never read the developer's git config (signing, hooks, default branch).
// The test script preloads this with --import, so it runs before any test file and every git call (helpers.ts sh(), src/exec.ts) inherits the override. Test files do not import it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

// The suite starts thousands of git processes, so the git binary's start-up time sets its wall time. A git earlier on
// PATH than the system one can be an x86_64 build under Rosetta on an Apple Silicon Mac, which starts about 2.5 times
// slower: the full suite took 122 s with it and 62 s with /usr/bin/git. Tests run the system git when there is one.
if (existsSync('/usr/bin/git')) process.env.PATH = `/usr/bin${delimiter}${process.env.PATH ?? ''}`;
