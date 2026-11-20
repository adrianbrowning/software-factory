import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initRepo, tempDir } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'headless-backlog.sh');
const state = (status: string, kind?: string) => JSON.stringify({ events: kind === undefined ? [] : [{ kind }], status });

// The fake omp writes the run state each prompt leads to and logs the prompts it got.
const fakeOmp = `#!/bin/sh
for a; do last=$a; done
echo "$last" >> "$CALLS"
case "$last" in
  "/factory headless 3") mkdir -p work/issue-3; echo '${state('done', 'submit')}' > work/issue-3/state.json; echo "https://github.com/o/r/pull/11" ;;
  "/factory headless https://github.com/o/other/issues/4") mkdir -p work/issue-4; echo '${state('done', 'submission-stop')}' > work/issue-4/state.json ;;
  "/factory resume issue-7") echo '${state('running')}' > work/issue-7/state.json; exit 1 ;;
esac
`;

describe('scripts/headless-backlog.sh', () => {
  it('starts, skips and resumes runs in the configured scratch dir, and stops at a run left running', () => {
    using dir = tempDir('backlog-');
    const repo = join(dir.root, 'repo');
    mkdirSync(repo);
    initRepo(repo, { '.omp/factory.json': '{"scratchDir":"work"}' });
    for (const [n, body] of [['5', state('done', 'submit')], ['6', state('done', 'submit-failed')], ['7', state('paused')]] as const) {
      mkdirSync(join(repo, 'work', `issue-${n}`), { recursive: true });
      writeFileSync(join(repo, 'work', `issue-${n}`, 'state.json'), body);
    }
    const bin = join(dir.root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, ',omp'), fakeOmp);
    chmodSync(join(bin, ',omp'), 0o755);
    const calls = join(dir.root, 'calls');
    const result = spawnSync('sh', [script, '3', 'https://github.com/o/other/issues/4', '#5', '6', '7', '9'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CALLS: calls, PATH: `${bin}:${process.env.PATH}`, PLUGIN_DIR: dir.root },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
      '/factory headless 3',
      '/factory headless https://github.com/o/other/issues/4',
      '/factory resume issue-7',
    ]);
    const summary = result.stdout.slice(result.stdout.indexOf('Summary:'));
    assert.match(summary, /^3: exit 0, run done, PRs: https:\/\/github\.com\/o\/r\/pull\/11 $/m);
    assert.match(summary, /issues\/4: exit 0, run done, no PRs \(submission-stop;/);
    assert.match(summary, /^#5: skipped, run already done$/m);
    assert.match(summary, /^6: skipped, run done, no PRs \(submit-failed;/m);
    assert.match(summary, /^Stopped: issue-7 is still running/m);
    assert.doesNotMatch(summary, /^9:/m);
  });
});
