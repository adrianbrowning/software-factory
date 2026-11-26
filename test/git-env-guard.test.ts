import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitEnvPreloadProblem } from './git-env-guard.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('gitEnvPreloadProblem', () => {
  it('is undefined when both variables hold the preload values', () => {
    assert.equal(gitEnvPreloadProblem({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), undefined);
  });

  for (const [name, env] of [
    ['GIT_CONFIG_GLOBAL is missing', { GIT_CONFIG_NOSYSTEM: '1' }],
    ['GIT_CONFIG_GLOBAL is another path', { GIT_CONFIG_GLOBAL: '/home/me/.gitconfig', GIT_CONFIG_NOSYSTEM: '1' }],
    ['GIT_CONFIG_NOSYSTEM is missing', { GIT_CONFIG_GLOBAL: '/dev/null' }],
  ] as const) {
    it(`names test/git-env.ts and the right command when ${name}`, () => {
      const message = gitEnvPreloadProblem(env);
      assert.match(message ?? '', /test\/git-env\.ts/);
      assert.match(message ?? '', /sh scripts\/test\.sh/);
    });
  }
});

describe('a test file that imports git-env-guard.ts', () => {
  let dir: string;
  let file: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-env-guard-'));
    file = join(dir, 'fixture.test.ts');
    writeFileSync(file, `import ${JSON.stringify(join(here, 'git-env-guard.ts'))};\nimport { test } from 'node:test';\ntest('fixture-body-ran', () => {});\n`);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    const r = spawnSync(process.execPath, [...args, '--test', file], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.error, undefined);
    return { status: r.status, out: r.stdout + r.stderr };
  }

  it('fails a raw node --test run with the guard message and runs no test', () => {
    const { status, out } = run([]);
    assert.notEqual(status, 0, out);
    assert.match(out, /test\/git-env\.ts/);
    assert.doesNotMatch(out, /✔ fixture-body-ran/);
  });

  it('passes under the git-env.ts preload', () => {
    const { status, out } = run(['--import', join(here, 'git-env.ts')]);
    assert.equal(status, 0, out);
    assert.match(out, /✔ fixture-body-ran/);
  });
});
