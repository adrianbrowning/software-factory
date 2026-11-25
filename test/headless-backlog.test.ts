import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initRepo, sh, tempDir } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'headless-backlog.sh');
/** Stands for the commit the fixture repo's slice branches are green at; runBacklog swaps in the real sha. */
const GREEN = '@green';

/** The green commit of a lower slice: never on origin, and unlike the top slice's. */
const LOWER = '0'.repeat(40);

/** A run state: its status, its last submission event (if any), its slice branches (bottom first; the top is green at GREEN, a lower one at LOWER) and its baseBranch (if any); baseRef is the run's recorded base, by default the fixture's default base. */
const state = (status: string, kind?: string | string[], branches: string[] = [], baseBranch?: string, topGreen = true, baseRef = 'origin/main') =>
  JSON.stringify({
    baseBranch,
    baseRef,
    events: kind === undefined ? [] : [kind].flat().map(k => ({ kind: k })),
    slices: branches.map((branch, i) => {
      const top = i === branches.length - 1;
      return { branch, checked: { results: [], sha: top ? GREEN : LOWER }, ...(top && !topGreen ? {} : { green: {} }) };
    }),
    status,
  });

/** The shell line that makes the fake omp leave `body` as the state of issue `n`. */
const writeState = (n: number, body: string) => `mkdir -p work/issue-${n}; echo '${body}' > work/issue-${n}/state.json`;

/** Tools scripts/headless-backlog.sh and the fake omp run. gh is deliberately not among them. */
const NO_GH_TOOLS = ['sh', 'git', 'jq', 'sed', 'tr', 'cut', 'grep', 'sort', 'mktemp', 'rm', 'mkdir', 'cat'];

function linkTools(tools: string, names: readonly string[] = NO_GH_TOOLS): string {
  mkdirSync(tools);
  for (const name of names) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).stdout.trim();
    if (!found.startsWith('/')) throw new Error(`noGh setup: tool not found on PATH: ${name}`);
    symlinkSync(found, join(tools, name));
  }
  return tools;
}

/**
 * Runs the script in a temp repo with the scratch dir `work`. `existing` are the runs that exist before it starts
 * (issue number → state); `cases` is the body of the fake omp's `case "$last"`, which writes the run state each prompt
 * leads to and may print PR URLs. The fake logs the prompts it got.
 * The repo has a local origin and a fake gh: every slice branch named in `existing` or `cases` is on origin at the green
 * commit (GREEN) and has an open PR, except as `world` says: `noPr` has no PR, `closedPr` only a closed one, `mergedPr`
 * a merged one, `ghFails` makes `gh pr list` fail for it, `moved` is on origin at another commit and `unpushed` is not on origin. Every slice branch also exists locally at GREEN, except `localMoved` (at another commit) and `localMissing` (absent).
 * `options.noGh` leaves gh off PATH. `options.baseRef` sets baseRef in .omp/factory.json; `options.originHead` points refs/remotes/origin/HEAD at that branch. `options.ompArgs` sets OMP_ARGS and `options.maxRounds` sets MAX_ROUNDS (both empty by default).
 * Besides the prompts, the fake logs its whole argument list as `argv`.
 */
function runBacklog(existing: Record<number, string>, cases: string, args: string[], world: Partial<Record<'closedPr' | 'ghFails' | 'localMissing' | 'localMoved' | 'mergedPr' | 'moved' | 'noPr' | 'unpushed', readonly string[]>> = {}, options: { noGh?: boolean; ghStderr?: Record<string, string>; baseRef?: string; originHead?: string; ompArgs?: string; maxRounds?: string; worktreeScript?: boolean } = {}) {
  using dir = tempDir('backlog-');
  const repo = join(dir.root, 'repo');
  mkdirSync(repo);
  initRepo(repo, { '.omp/factory.json': JSON.stringify({ scratchDir: 'work', ...options.baseRef && { baseRef: options.baseRef } }) });
  const green = sh(repo, 'rev-parse', 'HEAD');
  const origin = join(dir.root, 'origin.git');
  sh(dir.root, 'init', '-q', '--bare', origin);
  sh(repo, 'remote', 'add', 'origin', origin);
  if (options.originHead) sh(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${options.originHead}`);
  const moved = sh(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved');
  const prs = join(dir.root, 'prs');
  mkdirSync(prs);
  const branches = new Set((JSON.stringify(existing) + cases).match(/issue-\d+\/\d+/g));
  for (const branch of branches) {
    if (!world.unpushed?.includes(branch)) sh(repo, 'push', '-q', 'origin', `${world.moved?.includes(branch) ? moved : 'HEAD'}:refs/heads/${branch}`);
    if (!world.localMissing?.includes(branch)) sh(repo, 'branch', '-f', branch, world.localMoved?.includes(branch) ? moved : 'HEAD');
    const prState = world.mergedPr?.includes(branch) ? 'MERGED' : world.closedPr?.includes(branch) ? 'CLOSED' : 'OPEN';
    if (!world.noPr?.includes(branch)) writeFileSync(join(prs, branch.replace('/', '_')), JSON.stringify([{ state: prState }]));
    if (world.ghFails?.includes(branch)) writeFileSync(join(prs, `${branch.replace('/', '_')}.fail`), '');
    if (options.ghStderr?.[branch]) writeFileSync(join(prs, `${branch.replace('/', '_')}.err`), options.ghStderr[branch]);
  }
  cases = cases.replaceAll(GREEN, green);
  for (const [n, body] of Object.entries(existing)) {
    mkdirSync(join(repo, 'work', `issue-${n}`), { recursive: true });
    writeFileSync(join(repo, 'work', `issue-${n}`, 'state.json'), body.replaceAll(GREEN, green));
  }
  const bin = join(dir.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, ',omp'), `#!/bin/sh\necho "$*" >> "$CALLS.args"\nfor a; do last=$a; done\necho "$last" >> "$CALLS"\ncase "$last" in\n${cases}\nesac\n`);
  chmodSync(join(bin, ',omp'), 0o755);
  // The fake gh answers only `gh pr list --head <branch> ...`, with the PRs the world gave that branch: only the OPEN ones
  // unless `--state all` is passed, as real gh does. A branch in `ghFails` makes it exit 1.
  const f = `${prs}/$(printf %s "$4" | tr / _)`;
  const gh = `#!/bin/sh\n[ "$1 $2" = 'pr list' ] || exit 1\nf="${f}"\n[ -f "$f.err" ] && cat "$f.err" >&2\n[ -f "$f.fail" ] && { [ -f "$f.err" ] || echo 'gh: not logged in' >&2; exit 1; }\n[ -f "$f" ] || { echo '[]'; exit 0; }\ncase " $* " in *' --state all '*) cat "$f" ;; *) jq -c '[.[] | select(.state == "OPEN")]' "$f" ;; esac\n`;
  let path = `${bin}:${process.env.PATH}`;
  if (options.noGh) {
    path = `${bin}:${linkTools(join(dir.root, 'tools'))}`;
  } else {
    writeFileSync(join(bin, 'gh'), gh);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const calls = join(dir.root, 'calls');
  // OMP stays pinned to the fake, so a local OMP or a changed script default can never start the real omp.
  // LOG_DIR is removed, so the test sees the default log dir.
  const { LOG_DIR: _log, ...inherited } = process.env;
  // With worktreeScript the script runs from a copy at scripts/headless-backlog.sh in the test worktree, which the fake omp may rewrite.
  let scriptPath = script;
  if (options.worktreeScript) {
    scriptPath = join(repo, 'scripts', 'headless-backlog.sh');
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(script, scriptPath);
  }
  const result = spawnSync('sh', [scriptPath, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...inherited, CALLS: calls, MAX_ROUNDS: options.maxRounds ?? '', OMP: join(bin, ',omp'), OMP_ARGS: options.ompArgs ?? '', PATH: path, PLUGIN_DIR: dir.root },
  });
  let prompts: string[] = [];
  let argv: string[] = [];
  try {
    prompts = readFileSync(calls, 'utf8').trim().split('\n');
    argv = readFileSync(`${calls}.args`, 'utf8').trim().split('\n');
  } catch {
    // The fake was never called.
  }
  return {
    argv,
    logs: existsSync(join(repo, '.git', 'headless-backlog')) ? readdirSync(join(repo, '.git', 'headless-backlog')) : [],
    prompts,
    status: result.status,
    stderr: result.stderr,
    summary: result.stdout.slice(result.stdout.indexOf('Summary:')),
    tree: sh(repo, 'status', '--porcelain', '--untracked-files=all'),
  };
}

/** A done run with a submit and the slice branches `issue-<n>/<id>` for each id, started on `baseBranch` (if any). */
const submitted = (n: number, ids: string[], baseBranch?: string, baseRef?: string) => state('done', 'submit', ids.map(id => `issue-${n}/${id}`), baseBranch, true, baseRef);

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

  it('with --separate, a bad ref fails the run but the next issue still runs without --base', () => {
    const fake = `  "/factory headless 4") ${writeState(4, submitted(4, ['01']))} ;;`;
    const result = runBacklog({}, fake, ['--separate', 'nope', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 4']);
    assert.match(result.summary, /^nope: skipped, not an issue number/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('with --separate, a skipped done run with no PRs fails the run but the next issue still runs', () => {
    const fake = `  "/factory headless 4") ${writeState(4, submitted(4, ['01']))} ;;`;
    const result = runBacklog({ 3: state('done', 'submit-failed') }, fake, ['--separate', '3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 4']);
    assert.match(result.summary, /^3: skipped, run done, no PRs/m);
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

  it('chains a resumed run after an earlier run set the base: the resume prompt has no --base and the next run gets the resumed top branch', () => {
    const fake = [
      `  "/factory resume issue-4") ${writeState(4, submitted(4, ['01'], 'issue-3/01'))} ;;`,
      `  "/factory headless 5 --base issue-4/01") ${writeState(5, submitted(5, ['01'], 'issue-4/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({ 3: submitted(3, ['01']), 4: state('paused', undefined, ['issue-4/01'], 'issue-3/01') }, fake, ['3', '4', '5']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory resume issue-4', '/factory headless 5 --base issue-4/01']);
  });

  it('adds --max-rounds from MAX_ROUNDS to a new run, not to a resumed one', () => {
    const fake = [
      `  "/factory resume issue-4") ${writeState(4, submitted(4, ['01'], 'issue-3/01'))} ;;`,
      `  "/factory headless 5 --base issue-4/01 --max-rounds 5") ${writeState(5, submitted(5, ['01'], 'issue-4/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({ 3: submitted(3, ['01']), 4: state('paused', undefined, ['issue-4/01'], 'issue-3/01') }, fake, ['3', '4', '5'], {}, { maxRounds: '5' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory resume issue-4', '/factory headless 5 --base issue-4/01 --max-rounds 5']);
  });

  it('puts OMP_ARGS before the prompt, and shows the pause reason of a paused run on one line', () => {
    const paused = JSON.stringify({ events: [{ kind: 'pause', detail: 'Checks red:\n  test x fails \\n' }], slices: [], status: 'paused' });
    // The fake leaves the state as it is, so the resumed run stays paused with this reason.
    const result = runBacklog({ 3: paused }, '', ['--separate', '3'], {}, { ompArgs: '--advisor --model m' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.argv[0]!, / --advisor --model m \/factory resume issue-3$/);
    assert.match(result.summary, /^3: exit 0, run paused\n {2}reason: Checks red: test x fails \\n$/m);
  });

  for (const [name, existing, reason] of [
    ['a baseBranch that is not the top branch of the run before it', { 3: submitted(3, ['01']), 4: state('paused', undefined, ['issue-4/01'], 'issue-9/01') }, 'issue-4 failed chain check 3 .*its baseBranch is issue-9\\/01, expected issue-3\\/01'],
    ['a baseBranch as the first run', { 4: state('paused', undefined, ['issue-4/01'], 'issue-9/01') }, 'issue-4 failed chain check 3 .*its baseBranch is issue-9\\/01, expected absent'],
    ['a baseRef that is not the default base as the first run', { 4: state('paused', undefined, ['issue-4/01'], undefined, true, 'origin/other') }, 'issue-4 failed chain check 3 .*its baseRef is origin\\/other, expected origin\\/main'],
  ] as const) {
    it(`chained, does not resume a paused run with ${name}, and starts nothing after it`, () => {
      const fake = `  "/factory resume issue-4") ${writeState(4, submitted(4, ['01'], 'issue-9/01'))} ;;`;
      const result = runBacklog(existing, fake, Object.keys(existing).concat('5'));
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, []);
      assert.match(result.summary, new RegExp(`^Stopped: ${reason}\\. No later issue is started`, 'm'));
    });
  }

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

  it('chained, stops at a listed run that is done with no submission event, naming none', () => {
    const result = runBacklog({ 3: state('done', undefined, ['issue-3/01']) }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^3: skipped, run done, no PRs \(not submitted;/m);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 \(last submission is a submit.*submission event is none, not submit/m);
  });

  it('chained, takes the last submission event of a done run: [submit, submit-failed, pause] is submit-failed', () => {
    const result = runBacklog({ 3: state('done', ['submit', 'submit-failed', 'pause'], ['issue-3/01']) }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^3: skipped, run done, no PRs \(submit-failed;/m);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 \(.*\): its last submission event is submit-failed, not submit/m);
  });

  it('chained, takes the last submission event of a done run: [submit-failed, submit, unrelated] is submitted', () => {
    const fake = `  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01'], 'issue-3/01'))} ;;`;
    const result = runBacklog({ 3: state('done', ['submit-failed', 'submit', 'pause'], ['issue-3/01']) }, fake, ['3', '4']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 4 --base issue-3/01']);
    assert.match(result.summary, /^3: skipped, run already done$/m);
    assert.doesNotMatch(result.summary, /Stopped/);
  });

  it('runs to the end when a run replaces scripts/headless-backlog.sh in the worktree with a longer text', () => {
    const longer = Array.from({ length: 400 }, (_, i) => `echo "replacement line ${i}" >&2`).join('\n');
    const rewrite = `printf '%s\\n' '#!/bin/sh' '${longer}' > scripts/headless-backlog.sh`;
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))}; ${rewrite} ;;`,
      `  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01'], 'issue-3/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['3', '4'], {}, { worktreeScript: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/01']);
    assert.match(result.summary, /^3: exit 0, run done$/m);
    assert.match(result.summary, /^4: exit 0, run done$/m);
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

  it('stops at a done run whose top slice has no green marker even when checked.sha matches origin', () => {
    const result = runBacklog({ 3: state('done', 'submit', ['issue-3/01'], undefined, false) }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 2 .*the green commit is missing\. No later issue is started/m);
  });

  it('stops at a failing gh pr list with a check 1 reason naming the gh failure, not a missing PR', () => {
    const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`;
    const result = runBacklog({}, fake, ['3', '4'], { ghFails: ['issue-3/01'] });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3']);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 .*: gh pr list failed for issue-3\/01: gh: not logged in\. No later issue is started/m);
    assert.doesNotMatch(result.summary, /no open or merged PR/);
  });

  it('continues past a successful gh pr list that also writes a warning to stderr', () => {
    const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;\n  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01']))} ;;`;
    const result = runBacklog({}, fake, ['3', '4'], {}, { ghStderr: { 'issue-3/01': 'A new release of gh is available' } });
    assert.deepEqual(result.prompts, ['/factory headless 3', '/factory headless 4 --base issue-3/01']);
    assert.doesNotMatch(result.summary, /Stopped: issue-3/);
  });

  it('reports a failing gh with multiline, backslash stderr as one literal summary line', () => {
    const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`;
    const result = runBacklog({}, fake, ['3', '4'], { ghFails: ['issue-3/01'] }, { ghStderr: { 'issue-3/01': 'bad\\nthing C:\\dir\nsecond line\n' } });
    assert.deepEqual(result.prompts, ['/factory headless 3']);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 1 .*: gh pr list failed for issue-3\/01: bad\\nthing C:\\dir second line\. No later issue is started\.$/m);
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
      assert.match(result.summary, /^Stopped: issue-3 failed chain check 2 \(top slice branch on origin and locally is at the top slice's green commit\): origin has \S* issue-3\/02, the green commit is [0-9a-f]{40}\. No later issue is started/m);
      if (name === 'is not on origin') assert.match(result.summary, /origin has no issue-3\/02/);
    });
  }

  for (const [name, world] of [
    ['is at another commit', { localMoved: ['issue-3/02'] }],
    ['is missing', { localMissing: ['issue-3/02'] }],
  ] as const) {
    it(`stops at a run whose local top branch ${name} while origin is still green, and starts nothing after it`, () => {
      const fake = `  "/factory headless 3") ${writeState(3, submitted(3, ['01', '02']))} ;;`;
      const result = runBacklog({}, fake, ['3', '4'], world);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.prompts, ['/factory headless 3']);
      assert.match(result.summary, /^Stopped: issue-3 failed chain check 2 .*local issue-3\/02 is at \S*, the green commit is [0-9a-f]{40}\. No later issue is started/m);
      if (name === 'is missing') assert.match(result.summary, /local issue-3\/02 is at missing/);
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

  it('stops at a first run whose recorded baseRef is not the configured default base', () => {
    const result = runBacklog({ 3: submitted(3, ['01'], undefined, 'origin/other') }, '', ['3', '4']);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.prompts, []);
    assert.match(result.summary, /^Stopped: issue-3 failed chain check 3 .*its baseRef is origin\/other, expected origin\/main\. No later issue is started/m);
  });

  describe('default base of the first run', () => {
    const sources = {
      'factory.json baseRef': { baseRef: 'origin/develop' },
      'origin/HEAD': { originHead: 'develop' },
      'factory.json baseRef over a different origin/HEAD': { baseRef: 'origin/develop', originHead: 'release' },
    };
    for (const [name, options] of Object.entries(sources)) {
      it(`takes it from ${name}: a first run recorded with it passes`, () => {
        const result = runBacklog({ 3: submitted(3, ['01'], undefined, 'origin/develop') }, '', ['3'], {}, options);
        assert.equal(result.status, 0, result.stderr);
      });

      it(`takes it from ${name}: a first run recorded with origin/main stops, naming origin/develop`, () => {
        const result = runBacklog({ 3: submitted(3, ['01'], undefined, 'origin/main') }, '', ['3', '4'], {}, options);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(result.prompts, []);
        assert.match(result.summary, /^Stopped: issue-3 failed chain check 3 .*its baseRef is origin\/main, expected origin\/develop\. No later issue is started/m);
      });
    }

    it('a first run recorded with the origin/HEAD branch stops when factory.json names another', () => {
      const result = runBacklog({ 3: submitted(3, ['01'], undefined, 'origin/release') }, '', ['3'], {}, { baseRef: 'origin/develop', originHead: 'release' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.summary, /its baseRef is origin\/release, expected origin\/develop/);
    });
  });

  it('does not compare the baseRef of a later run, which is pinned to the branch before it', () => {
    const fake = [
      `  "/factory headless 3") ${writeState(3, submitted(3, ['01']))} ;;`,
      `  "/factory headless 4 --base issue-3/01") ${writeState(4, submitted(4, ['01'], 'issue-3/01', 'issue-3/01'))} ;;`,
    ].join('\n');
    const result = runBacklog({}, fake, ['3', '4']);
    assert.equal(result.status, 0, result.stderr);
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

    for (const [name, check, resumed, world] of [
      ['has a slice branch with no PR', 1, submitted(4, ['01'], 'issue-3/01'), { noPr: ['issue-4/01'] }],
      ['has a top branch not at its green commit', 2, submitted(4, ['01'], 'issue-3/01'), { moved: ['issue-4/01'] }],
      ['has a baseBranch that is not the top branch of the run before it', 3, submitted(4, ['01'], 'issue-9/01'), {}],
    ] as const) {
      it(`stops at it when it ${name}`, () => {
        const fake = `  "/factory resume issue-4") ${writeState(4, resumed)} ;;\n${next}`;
        const result = runBacklog(existing, fake, ['3', '4', '5'], world);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(result.prompts, ['/factory resume issue-4']);
        assert.match(result.summary, new RegExp(`^Stopped: issue-4 failed chain check ${check} `, 'm'));
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

describe('scripts/headless-backlog.sh with a bad MAX_ROUNDS', () => {
  for (const bad of ['0', '05', 'x', '5 --base other', '1234567890123456']) {
    it(`exits 2 for "${bad}" before any run, also a resume`, () => {
      const paused = JSON.stringify({ events: [], slices: [], status: 'paused' });
      const result = runBacklog({ 3: paused }, '', ['--separate', '3', '4'], {}, { maxRounds: bad });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /MAX_ROUNDS must be a positive whole number/);
      assert.deepEqual(result.prompts, []);
    });
  }
});

describe('scripts/headless-backlog.sh without gh on PATH', () => {
  it('chained, exits 2 with the gh message and calls no omp', () => {
    const result = runBacklog({}, '', ['3'], {}, { noGh: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /gh is required/);
    assert.deepEqual(result.prompts, []);
  });

  it('with --separate, is not refused', () => {
    const fake = `  "/factory headless 3") ${writeState(3, state('done', 'submit'))} ;;`;
    const result = runBacklog({}, fake, ['--separate', '3'], {}, { noGh: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.prompts, ['/factory headless 3']);
  });
});

describe('linkTools', () => {
  it('throws naming a tool that is not found', () => {
    using dir = tempDir('tools-');
    assert.throws(() => linkTools(join(dir.root, 'tools'), ['sh', 'no-such-tool-xyz']), /tool not found on PATH: no-such-tool-xyz/);
  });

  it('links exactly NO_GH_TOOLS and no gh by default', () => {
    using dir = tempDir('tools-');
    const tools = linkTools(join(dir.root, 'tools'));
    assert.deepEqual(readdirSync(tools).sort(), [...NO_GH_TOOLS].sort());
    assert.ok(!readdirSync(tools).includes('gh'));
  });
});
