import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initRepo, sh, tempDir } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'headless-backlog.sh');
/** Stands for the commit the fixture repo's slice branches are green at; runBacklog swaps in the real sha. */
const GREEN = '@green';

/** A run state: its status, its last submission event (if any), its slice branches (bottom first, each green at GREEN) and its baseBranch (if any). */
const state = (status: string, kind?: string, branches: string[] = [], baseBranch?: string) =>
  JSON.stringify({
    baseBranch,
    events: kind === undefined ? [] : [{ kind }],
    slices: branches.map(branch => ({ branch, checked: { results: [], sha: GREEN }, green: {} })),
    status,
  });

/** The shell line that makes the fake omp leave `body` as the state of issue `n`. */
const writeState = (n: number, body: string) => `mkdir -p work/issue-${n}; echo '${body}' > work/issue-${n}/state.json`;

/**
 * Runs the script in a temp repo with the scratch dir `work`. `existing` are the runs that exist before it starts
 * (issue number → state); `cases` is the body of the fake omp's `case "$last"`, which writes the run state each prompt
 * leads to and may print PR URLs. The fake logs the prompts it got.
 * The repo has a local origin and a fake gh: every slice branch named in `existing` or `cases` is on origin at the green
 * commit (GREEN) and has an open PR, except as `world` says: `noPr` has no PR, `closedPr` only a closed one, `mergedPr`
 * a merged one, `moved` is on origin at another commit and `unpushed` is not on origin.
 */
function runBacklog(existing: Record<number, string>, cases: string, args: string[], world: Partial<Record<'closedPr' | 'mergedPr' | 'moved' | 'noPr' | 'unpushed', readonly string[]>> = {}) {
  using dir = tempDir('backlog-');
  const repo = join(dir.root, 'repo');
  mkdirSync(repo);
  initRepo(repo, { '.omp/factory.json': '{"scratchDir":"work"}' });
  const green = sh(repo, 'rev-parse', 'HEAD');
  const origin = join(dir.root, 'origin.git');
  sh(dir.root, 'init', '-q', '--bare', origin);
  sh(repo, 'remote', 'add', 'origin', origin);
  const moved = sh(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved');
  const prs = join(dir.root, 'prs');
  mkdirSync(prs);
  const branches = new Set((JSON.stringify(existing) + cases).match(/issue-\d+\/\d+/g));
  for (const branch of branches) {
    if (!world.unpushed?.includes(branch)) sh(repo, 'push', '-q', 'origin', `${world.moved?.includes(branch) ? moved : 'HEAD'}:refs/heads/${branch}`);
    const prState = world.mergedPr?.includes(branch) ? 'MERGED' : world.closedPr?.includes(branch) ? 'CLOSED' : 'OPEN';
    if (!world.noPr?.includes(branch)) writeFileSync(join(prs, branch.replace('/', '_')), JSON.stringify([{ state: prState }]));
  }
  cases = cases.replaceAll(GREEN, green);
  for (const [n, body] of Object.entries(existing)) {
    mkdirSync(join(repo, 'work', `issue-${n}`), { recursive: true });
    writeFileSync(join(repo, 'work', `issue-${n}`, 'state.json'), body.replaceAll(GREEN, green));
  }
  const bin = join(dir.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, ',omp'), `#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "$CALLS"\ncase "$last" in\n${cases}\nesac\n`);
  chmodSync(join(bin, ',omp'), 0o755);
  // The fake gh answers only `gh pr list --head <branch> ...`, with the PRs the world gave that branch.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = 'pr list' ] || exit 1\nf="${prs}/$(printf %s "$4" | tr / _)"\nif [ -f "$f" ]; then cat "$f"; else echo '[]'; fi\n`);
  chmodSync(join(bin, 'gh'), 0o755);
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

/** A done run with a submit and the slice branches `issue-<n>/<id>` for each id, started on `baseBranch` (if any). */
const submitted = (n: number, ids: string[], baseBranch?: string) => state('done', 'submit', ids.map(id => `issue-${n}/${id}`), baseBranch);

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

  it('with --separate, a paused run does not stop the next run, no run gets --base, and no chain check runs', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, state('paused'))} ;;`,
      `  "/factory headless 4") ${writeState(4, submitted(4, ['01'], 'issue-9/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['--separate', '3', '4'], { noPr: ['issue-4/01'], unpushed: ['issue-4/01'] });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4']);
    assert.match(result.summary, /^3: exit 0, run paused$/m);
    assert.match(result.summary, /^4: exit 0, run done$/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('chains runs: the first has no --base, a skipped done run hands its top branch on, and each new run gets the top branch before it', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, ['01', '02']))} ;;`,
      `  "/factory headless 4 --base issue-3/02") ${writeState(4, submitted(4, ['01'], 'issue-3/02'))} ;;`,
      `  "/factory headless 6 --base issue-5/03") ${writeState(6, submitted(6, ['01', '02'], 'issue-5/03'))} ;;`,
    ].join('\n');
    const existing = { 5: submitted(5, ['01', '02', '03'], 'issue-4/01') };
    const result = runBacklog(existing, fake, ['3', '4', '5', '6'], { mergedPr: ['issue-5/01', 'issue-5/02'] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/02', '/factory headless 6 --base issue-5/03']);
    assert.match(result.summary, /^5: skipped, run already done$/m);
    assert.match(result.summary, /^6: exit 0, run done$/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('chains a resumed run without --base, then hands its top branch to the next run', () => {
    const fake = [
      `  "/factory resume issue-3") ${writeState(3, submitted(3, ['01', '02']))} ;;`,
      `  "/factory headless 4 --base issue-3/02") ${writeState(4, submitted(4, ['01'], 'issue-3/02'))} ;;`,
    ].join('\n');
    const result = runBacklog({ 3: state('paused', undefined, ['issue-3/01']) }, fake, ['3', '4']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory resume issue-3', '/factory headless 4 --base issue-3/02']);
  });

  for (const [name, outcome, reason] of [
    ['paused', state('paused', undefined, ['issue-4/01']), 'run paused'],
    ['done with no PRs', state('done', 'submission-stop', ['issue-4/01']), 'run done, no PRs \\(submission-stop;'],
  ] as const) {
    it(`chained, stops the batch at a run that ends ${name}: later issues are not started and the exit is 1`, () => {
      const fake = [
        `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`,
        `  "/factory headless 4 --base issue-3/01") ${writeState(4, outcome)} ;;`,
      ].join('\n');
      const result = runBacklog({}, fake, ['3', '4', '5']);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/01']);
      assert.match(result.summary, new RegExp(`^4: exit 0, ${reason}`, 'm'));
      assert.match(result.summary, name === 'paused' ? /^Stopped: issue-4 did not end done with a submit, so no later issue is started/m : /^Stopped: issue-4 failed chain check 1 \(last submission is a submit.*submission event is submission-stop, not submit/m);
      assert.doesNotMatch(result.summary, /^5:/m);
    });
  }

  it('chained, stops at a listed run that is done with no PRs, and starts nothing after it', () => {
    const result = runBacklog({ 3: state('done', 'submit-failed', ['issue-3/01']) }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^3: skipped, run done, no PRs \(submit-failed;/m);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 \(last submission is a submit.*submission event is submit-failed, not submit/m);
  });
});

describe('scripts/headless-backlog.sh chain checks', () => {
  it('stops at a just-finished run with a slice branch that has no PR, or only a closed one, and starts nothing after it', () => {
    for (const world of [{ noPr: ['issue-3/02'] }, { closedPr: ['issue-3/02'] }]) {
      const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01', '02']))} ;;`;
      const result = runBacklog({}, fake, ['3', '4'], world);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, ['/factory headless 3']);
      assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 \(last submission is a submit and each slice branch has an open or merged PR\): issue-3\/02 has no open or merged PR\. No later issue is started/m);
    }
  });

  it('stops at a skipped done run with a slice branch that has no PR', () => {
    const result = runBacklog({ 3: submitted(3, ['01']) }, '', ['3', '4'], { noPr: ['issue-3/01'] });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 .*issue-3\/01 has no open or merged PR/m);
  });

  for (const [name, world] of [
    ['is at another commit', { moved: ['issue-3/02'] }],
    ['is not on origin', { unpushed: ['issue-3/02'] }],
  ] as const) {
    it(`stops at a run whose top branch on origin ${name}, and starts nothing after it`, () => {
      const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01', '02']))} ;;`;
      const result = runBacklog({}, fake, ['3', '4'], world);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, ['/factory headless 3']);
      assert.match(result.summary, /^Stopped: issue-3 failed chain check 2 \(top slice branch on origin is at the top slice's green commit\): origin has \S* issue-3\/02, the green commit is [0-9a-f]{40}\. No later issue is started/m);
      if (name === 'is not on origin') assert.match(result.summary, /origin has no issue-3\/02/);
    });
  }

  it('checks the top branch, not a lower slice branch, against the green commit', () => {
    const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01', '02']))} ;;\n  "/factory headless 4 --base issue-3/02") ${writeState(4, submitted(4, ['01'], 'issue-3/02'))} ;;`;
    const result = runBacklog({}, fake, ['3', '4'], { moved: ['issue-3/01'] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/02']);
  });

  it('stops at a new run whose baseBranch is not the top branch of the run before it', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`,
      `  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01'], 'issue-9/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['3', '4', '5']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/01']);
    assert.match(result.summary, /^Stopped: issue-4 failed chain check 3 \(baseBranch is the top slice branch of the run before it in the list, absent for the first\): its baseBranch is issue-9\/01, expected issue-3\/01\. No later issue is started/m);
  });

  it('stops at a new run with no baseBranch after the first run', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`,
      `  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01']))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['3', '4', '5']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.summary, /^Stopped: issue-4 failed chain check 3 .*its baseBranch is absent, expected issue-3\/01/m);
    assert.doesNotMatch(result.summary, /^5:/m);
  });

  it('stops at a first run that has a baseBranch', () => {
    const result = runBacklog({ 3: submitted(3, ['01'], 'issue-9/01') }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 3 .*its baseBranch is issue-9\/01, expected absent\. No later issue is started/m);
  });

  it('stops at a skipped run whose baseBranch is not the top branch of the run before it', () => {
    const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`;
    const result = runBacklog({ 4: submitted(4, ['01'], 'issue-8/01') }, fake, ['3', '4', '5']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3']);
    assert.match(result.summary, /^Stopped: issue-4 failed chain check 3 .*its baseBranch is issue-8\/01, expected issue-3\/01/m);
  });

  describe('after a middle run is resumed', () => {
    const existing = { 3: submitted(3, ['01']), 4: state('paused', undefined, ['issue-4/01'], 'issue-3/01') };
    const next = `  "/factory headless 5 --base issue-4/01") ${writeState(5, submitted(5, ['01'], 'issue-4/01'))} ;;`;

    it('continues past it when it passes the checks', () => {
      const fake = `  "/factory resume issue-4") ${writeState(4, submitted(4, ['01'], 'issue-3/01'))} ;;\n${next}`;
      const result = runBacklog(existing, fake, ['3', '4', '5']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.prompts, ['/factory resume issue-4', '/factory headless 5 --base issue-4/01']);
    });

    for (const [name, resumed, world] of [
      ['has a slice branch with no PR', submitted(4, ['01'], 'issue-3/01'), { noPr: ['issue-4/01'] }],
      ['has a top branch not at its green commit', submitted(4, ['01'], 'issue-3/01'), { moved: ['issue-4/01'] }],
      ['has a baseBranch that is not the top branch of the run before it', submitted(4, ['01'], 'issue-9/01'), {}],
    ] as const) {
      it(`stops at it when it ${name}`, () => {
        const fake = `  "/factory resume issue-4") ${writeState(4, resumed)} ;;\n${next}`;
        const result = runBacklog(existing, fake, ['3', '4', '5'], world);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(result.prompts, ['/factory resume issue-4']);
        assert.match(result.summary, /^Stopped: issue-4 failed chain check [123] /m);
        assert.doesNotMatch(result.summary, /^5:/m);
      });
    }
  });
});

describe('scripts/headless-backlog.sh with a done run that has no slice branch', () => {
  it('chained, stops at a skipped done run with no slice branch instead of starting the next run without --base', () => {
    const result = runBacklog({ 3: state('done', 'submit') }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^Stopped: issue-3 has no slice branch to stack the next run on/m);
  });

  it('chained, stops at a run that ends done with no slice branch instead of starting the next run without --base', () => {
    const fake = `  "/factory headless 3") ${writeState(3, state('done', 'submit'))} ;;`;
    const result = runBacklog({}, fake, ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3']);
    assert.match(result.summary, /^Stopped: issue-3 has no slice branch to stack the next run on/m);
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
