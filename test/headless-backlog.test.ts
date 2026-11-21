import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initRepo, sh, tempDir } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'headless-backlog.sh');
/** A run state: its status, its last submission event (if any) and its slice branches, bottom first. */
const state = (status: string, kind?: string, ...branches: string[]) =>
  JSON.stringify({ events: kind === undefined ? [] : [{ kind }], slices: branches.map(branch => ({ branch })), status });

/** The shell line that makes the fake omp leave `body` as the state of issue `n`. */
const writeState = (n: number, body: string) => `mkdir -p work/issue-${n}; echo '${body}' > work/issue-${n}/state.json`;

/**
 * Runs the script in a temp repo with the scratch dir `work`. `existing` are the runs that exist before it starts
 * (issue number → state); `cases` is the body of the fake omp's `case "$last"`, which writes the run state each prompt
 * leads to and may print PR URLs. The fake logs the prompts it got.
 */
function runBacklog(existing: Record<number, string>, cases: string, args: string[]) {
  using dir = tempDir('backlog-');
  const repo = join(dir.root, 'repo');
  mkdirSync(repo);
  initRepo(repo, { '.omp/factory.json': '{"scratchDir":"work"}' });
  for (const [n, body] of Object.entries(existing)) {
    mkdirSync(join(repo, 'work', `issue-${n}`), { recursive: true });
    writeFileSync(join(repo, 'work', `issue-${n}`, 'state.json'), body);
  }
  const bin = join(dir.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, ',omp'), `#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "$CALLS"\ncase "$last" in\n${cases}\nesac\n`);
  chmodSync(join(bin, ',omp'), 0o755);
  const calls = join(dir.root, 'calls');
  // OMP stays pinned to the fake, so a local OMP or a changed script default can never start the real omp.
  // LOG_DIR is removed, so the test sees the default log dir.
  const { LOG_DIR: _log, ...inherited } = process.env;
  const result = spawnSync('sh', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...inherited, CALLS: calls, OMP: join(bin, ',omp'), PATH: `${bin}:${process.env.PATH}`, PLUGIN_DIR: dir.root },
  });
  let prompts: string[] = [];
  try {
    prompts = readFileSync(calls, 'utf8').trim().split('\n');
  } catch {
    // The fake was never called.
  }
  return {
    logs: readdirSync(join(repo, '.git', 'headless-backlog')),
    prompts,
    status: result.status,
    stderr: result.stderr,
    summary: result.stdout.slice(result.stdout.indexOf('Summary:')),
    tree: sh(repo, 'status', '--porcelain', '--untracked-files=all'),
  };
}

const submitted = (n: number, ...branches: string[]) => state('done', 'submit', ...branches.map(b => `issue-${n}/${b}`));

describe('scripts/headless-backlog.sh', () => {
  it('with --separate, starts, skips and resumes runs in the configured scratch dir without --base, and stops at a run left running', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, state('done', 'submit'))}; echo "https://github.com/o/r/pull/11" ;;`,
      `  "/factory headless https://github.com/o/other/issues/4") ${writeState(4, state('done', 'submission-stop'))} ;;`,
      `  "/factory resume issue-7") ${writeState(7, state('running'))}; exit 1 ;;`,
    ].join('\n');
    const existing = { 5: state('done', 'submit'), 6: state('done', 'submit-failed'), 7: state('paused') };
    const result = runBacklog(existing, fake, ['--separate', '3', 'https://github.com/o/other/issues/4', '#5', '6', '7', '9']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, [
      '/factory headless 3',
      '/factory headless https://github.com/o/other/issues/4',
      '/factory resume issue-7',
    ]);
    assert.match(result.summary, /^3: exit 0, run done, PRs: https:\/\/github\.com\/o\/r\/pull\/11 $/m);
    assert.match(result.summary, /issues\/4: exit 0, run done, no PRs \(submission-stop;/);
    assert.match(result.summary, /^#5: skipped, run already done$/m);
    assert.match(result.summary, /^6: skipped, run done, no PRs \(submit-failed;/m);
    assert.match(result.summary, /^Stopped: issue-7 is still running/m);
    assert.doesNotMatch(result.summary, /^9:/m);
    assert.ok(result.logs.some(f => f.endsWith('.log')));
    assert.doesNotMatch(result.tree, /\.log$/m);
  });

  it('with --separate, a paused run does not stop the next run, and no run gets --base', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, state('paused'))} ;;`,
      `  "/factory headless 4") ${writeState(4, submitted(4, '01'))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['--separate', '3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4']);
    assert.match(result.summary, /^3: exit 0, run paused$/m);
    assert.match(result.summary, /^4: exit 0, run done$/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('chains runs: the first has no --base, a skipped done run hands its top branch on, and each new run gets the top branch before it', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, '01', '02'))} ;;`,
      `  "/factory headless 4 --base issue-3/02") ${writeState(4, submitted(4, '01'))} ;;`,
      `  "/factory headless 6 --base issue-5/03") ${writeState(6, submitted(6, '01', '02'))} ;;`,
    ].join('\n');
    const result = runBacklog({ 5: submitted(5, '01', '02', '03') }, fake, ['3', '4', '5', '6']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/02', '/factory headless 6 --base issue-5/03']);
    assert.match(result.summary, /^5: skipped, run already done$/m);
    assert.match(result.summary, /^6: exit 0, run done$/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('chains a resumed run without --base, then hands its top branch to the next run', () => {
    const fake = [
      `  "/factory resume issue-3") ${writeState(3, submitted(3, '01', '02'))} ;;`,
      `  "/factory headless 4 --base issue-3/02") ${writeState(4, submitted(4, '01'))} ;;`,
    ].join('\n');
    const result = runBacklog({ 3: state('paused', undefined, 'issue-3/01') }, fake, ['3', '4']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory resume issue-3', '/factory headless 4 --base issue-3/02']);
  });

  for (const [name, outcome, reason] of [
    ['paused', state('paused', undefined, 'issue-4/01'), 'run paused'],
    ['done with no PRs', state('done', 'submission-stop', 'issue-4/01'), 'run done, no PRs \\(submission-stop;'],
  ] as const) {
    it(`chained, stops the batch at a run that ends ${name}: later issues are not started and the exit is 1`, () => {
      const fake = [
        `  "/factory headless 3") ${writeState(3, submitted(3, '01'))} ;;`,
        `  "/factory headless 4 --base issue-3/01") ${writeState(4, outcome)} ;;`,
      ].join('\n');
      const result = runBacklog({}, fake, ['3', '4', '5']);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/01']);
      assert.match(result.summary, new RegExp(`^4: exit 0, ${reason}`, 'm'));
      assert.match(result.summary, /^Stopped: issue-4 did not end done with a submit, so no later issue is started/m);
      assert.doesNotMatch(result.summary, /^5:/m);
    });
  }

  it('chained, stops at a listed run that is done with no PRs, and starts nothing after it', () => {
    const result = runBacklog({ 3: state('done', 'submit-failed', 'issue-3/01') }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^3: skipped, run done, no PRs \(submit-failed;/m);
    assert.match(result.summary, /^Stopped: issue-3 did not end done with a submit, so no later issue is started/m);
  });
});

describe('scripts/headless-backlog.sh with a ref that is no issue', () => {
  it('chained, stops at it and starts nothing after it', () => {
    const result = runBacklog({}, '', ['nope', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^nope: skipped, not an issue number/m);
    assert.match(result.summary, /^Stopped: nope did not end done with a submit/m);
  });
});
