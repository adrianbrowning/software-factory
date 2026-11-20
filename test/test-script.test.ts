import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Seam: the command line of scripts/test.sh (what `pnpm run test [files...]` runs): exit code and node test summary.
// Runs in a temp project (copy of the script, a stub preload, fixture tests) so a no-argument run never recurses into the real suite.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'test.sh');

const passing = (name: string) =>
  `import { test } from 'node:test';\ntest('${name}', () => {});\n`;

let root: string;

function runScript(args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the nested node --test reports as a child of this run
  const r = spawnSync('sh', ['scripts/test.sh', ...args], { cwd: root, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'test-script-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test'));
  copyFileSync(script, join(root, 'scripts', 'test.sh'));
  writeFileSync(join(root, 'test', 'git-env.ts'), "process.env.PRELOAD_MARKER = 'on';\n");
  writeFileSync(join(root, 'test', 'a.test.ts'), passing('alpha-test'));
  writeFileSync(join(root, 'test', 'b.test.ts'), passing('beta-test'));
  writeFileSync(
    join(root, 'test', 'preload.test.ts'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('preload-active', () => { assert.equal(process.env.PRELOAD_MARKER, 'on'); });\n",
  );
  writeFileSync(
    join(root, 'test', 'fail.test.ts'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('failing-test', () => { assert.fail('boom'); });\n",
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('scripts/test.sh', () => {
  it('runs only the named file, with the preload active', () => {
    const { status, out } = runScript(['test/preload.test.ts']);
    assert.equal(status, 0, out);
    assert.match(out, /tests 1\b/);
    assert.match(out, /preload-active/);
    assert.doesNotMatch(out, /alpha-test|beta-test/);
  });

  it('runs several named files and nothing else', () => {
    const { status, out } = runScript(['test/a.test.ts', 'test/b.test.ts']);
    assert.equal(status, 0, out);
    assert.match(out, /tests 2\b/);
  });

  it('exits non-zero when a named file fails', () => {
    const { status, out } = runScript(['test/fail.test.ts']);
    assert.notEqual(status, 0, out);
    assert.match(out, /fail 1\b/);
  });

  it('runs every test/*.test.ts file when given no arguments', () => {
    const { out } = runScript([]);
    assert.match(out, /tests 4\b/);
    for (const name of ['alpha-test', 'beta-test', 'preload-active', 'failing-test']) assert.match(out, new RegExp(name));
  });
});
