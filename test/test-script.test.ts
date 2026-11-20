import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Seam: `pnpm run test [files...]` (package.json script -> scripts/test.sh): exit code and node test summary.
// Named-file cases run pnpm in the real repo (real package.json, real git-env.ts preload) against temp fixture files.
// The no-argument case runs pnpm in a temp copy of package.json + scripts/test.sh with a small test/ tree, so it never recurses into the real suite.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const pass = (name: string) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
const fail = (name: string) =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('${name}', () => { assert.fail('boom'); });\n`;
const preloadCheck = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('preload-active', () => { assert.equal(process.env.GIT_CONFIG_GLOBAL, '/dev/null'); });
`;

let fixtures: string;
let project: string;

function pnpmTest(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the nested node --test reports as a child of this run
  delete env.GIT_CONFIG_GLOBAL; // only the git-env.ts preload may set it
  const r = spawnSync('pnpm', ['run', 'test', ...args], { cwd, encoding: 'utf8', env });
  assert.equal(r.error, undefined);
  return { status: r.status, out: r.stdout + r.stderr };
}

before(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'test-script-fixtures-'));
  writeFileSync(join(fixtures, 'a.test.ts'), pass('alpha-test'));
  writeFileSync(join(fixtures, 'b.test.ts'), pass('beta-test'));
  writeFileSync(join(fixtures, 'preload.test.ts'), preloadCheck);
  writeFileSync(join(fixtures, 'fail.test.ts'), fail('failing-test'));

  project = mkdtempSync(join(tmpdir(), 'test-script-project-'));
  mkdirSync(join(project, 'scripts'));
  mkdirSync(join(project, 'test'));
  copyFileSync(join(repo, 'package.json'), join(project, 'package.json'));
  copyFileSync(join(repo, 'scripts', 'test.sh'), join(project, 'scripts', 'test.sh'));
  writeFileSync(join(project, 'test', 'git-env.ts'), "process.env.GIT_CONFIG_GLOBAL = '/dev/null';\n");
  writeFileSync(join(project, 'test', 'one.test.ts'), pass('one-test'));
  writeFileSync(join(project, 'test', 'two.test.ts'), pass('two-test'));
  writeFileSync(join(project, 'test', 'preload.test.ts'), preloadCheck);
});

after(() => {
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('pnpm run test', () => {
  it('runs only the named file, with the real git-env.ts preload active', () => {
    const { status, out } = pnpmTest(repo, [join(fixtures, 'preload.test.ts')]);
    assert.equal(status, 0, out);
    assert.match(out, /tests 1\b/);
    assert.match(out, /preload-active/);
  });

  it('runs several named files and nothing else', () => {
    const { status, out } = pnpmTest(repo, [join(fixtures, 'a.test.ts'), join(fixtures, 'b.test.ts')]);
    assert.equal(status, 0, out);
    assert.match(out, /tests 2\b/);
  });

  it('exits non-zero when a named file fails', () => {
    const { status, out } = pnpmTest(repo, [join(fixtures, 'fail.test.ts')]);
    assert.notEqual(status, 0, out);
    assert.match(out, /fail 1\b/);
  });

  it('runs every test/*.test.ts file when given no arguments', () => {
    const { status, out } = pnpmTest(project, []);
    assert.equal(status, 0, out);
    assert.match(out, /tests 3\b/);
    for (const name of ['one-test', 'two-test', 'preload-active']) assert.match(out, new RegExp(name));
  });
});
