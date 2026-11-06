import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { forgetRun, readRun, REVIEW_DOMAINS, type Run, runDir, statePath, type Workspace } from '../src/run.ts';
import { renderHandoff } from '../src/handoff.ts';
import { completeSlice, recordDecisions, recordReview, runChecks, startReview } from '../src/review.ts';
import { planSubmit, submitStack } from '../src/submit.ts';
import { approvePlan, nextSlice, parseRetro, planSlices, recordRetro, resolveBase, startRun } from '../src/workflow.ts';
import { commit, finding, green, newRun, review, sh, slice, start, step, tempDir, workspace } from './helpers.ts';

/** A done run of `count` chained slices, each with a reviewed commit, checked out on `main` (off the top slice). */
async function doneRun(ws: Workspace, count: number) {
  const titles = Array.from({ length: count }, (_, index) => `S${index + 1}`);
  await newRun(ws, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])));
  for (const [index] of titles.entries()) {
    await step(ws, run => nextSlice(ws, run));
    commit(ws, index === 0 ? 'ok' : `s${index + 1}.txt`);
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
  }
  await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
  sh(ws.root, 'switch', '-q', 'main');
  return readRun(ws, 'demo').slices.map(item => item.branch);
}

/** A done run of two chained slices planned with `landOn`, each with a reviewed commit, checked out on `main`. */
async function doneLandOnRun(ws: Workspace, landOn: string) {
  await start(ws);
  const base = await resolveBase(ws, { landOn });
  await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('S1'), slice('S2', ['S1'])], base), base));
  for (const file of ['ok', 's2.txt']) {
    await step(ws, run => nextSlice(ws, run));
    commit(ws, file);
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
  }
  await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
  sh(ws.root, 'switch', '-q', 'main');
  return readRun(ws, 'demo').slices.map(item => item.branch);
}

/**
 * A done landOn run of two slices from a GitHub issue, with one recorded decision; slice 01's green review skipped
 * security, kept every other domain, and kept one thermo observation. Checked out on `main`.
 */
async function handoffRun(ws: Workspace) {
  await startRun(ws, {
    feature: 'demo',
    sessionId: 's',
    source: { body: 'Land it', kind: 'github', ref: '#149', title: 'Land the work on ext-953', url: 'https://github.com/acme/app/issues/149' },
  });
  const base = await resolveBase(ws, { landOn: 'ext-953' });
  await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('S1'), slice('S2', ['S1'])], base), base));
  await step(ws, run => recordDecisions(ws, run, ['Keep the old flag working']));
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 'ok');
  await step(ws, run => runChecks(ws, run));
  const kept = REVIEW_DOMAINS.filter(domain => domain !== 'security');
  const opened = await step(ws, run => startReview(ws, run, [{ domain: 'security', reason: 'no inputs' }], kept));
  await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
  await step(ws, run => recordReview(ws, run));
  await step(ws, run => completeSlice(ws, run));
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 's2.txt');
  await green(ws);
  await step(ws, run => completeSlice(ws, run));
  await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
  sh(ws.root, 'switch', '-q', 'main');
  return readRun(ws, 'demo').slices.map(item => item.branch);
}

const NO_STACK = { code: 2, stderr: '✗ no local or remote stack found for "$3"' };

interface FakeGh {
  /** The stack `stack view --json` serves (a raw string is served as is); undefined means no stack. */
  stack: string[] | string | undefined;
  /** How `stack checkout` fails without a stack; by default gh-stack's real "no stack" exit and stderr. */
  checkoutFailure?: { code: number; stderr: string };
  /** The subcommand (such as `stack submit`) that runs `onFail` and exits 1. */
  fail?: string;
  onFail?: string;
  /** The stack `stack view --json` serves after `stack submit`, with each branch's PR number (none: no `pr`); `noUrl` leaves the PR's url out. */
  submitted?: { name: string; noUrl?: boolean; pr?: number }[];
}

/** The branches as a submitted stack, with PRs numbered from 101. */
const withPrs = (branches: string[]) => branches.map((name, index) => ({ name, pr: 101 + index }));

/** The `gh api` calls that set the title of PR 101 onwards to `demo: NN Sn`. */
const titleCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f title=demo: 0${index + 1} S${index + 1}`);

/**
 * Puts a fake `gh` first on PATH until the `using` scope that holds it ends, then removes it; it records each call.
 * With a stack, `stack checkout <branch>` switches to that branch, as gh-stack does; `stack init` switches to its last
 * (top) branch, `stack top` to the stack's top branch, and `stack add <branch>` to the branch it adds.
 */
function fakeGh({ stack, checkoutFailure = NO_STACK, fail = '', onFail = ':', submitted }: FakeGh) {
  const temp = tempDir('factory-gh-');
  const dir = temp.root;
  const log = join(dir, 'calls');
  const view = join(dir, 'view.json');
  if (typeof stack === 'string') writeFileSync(view, stack);
  else if (stack !== undefined) {
    writeFileSync(view, JSON.stringify({ branches: stack.map(name => ({ name })), currentBranch: stack[0], trunk: 'main' }));
    writeFileSync(join(dir, 'top'), stack.at(-1) ?? '');
  }
  const after = join(dir, 'submitted.json');
  if (submitted !== undefined) {
    const items = submitted.map(({ name, noUrl = false, pr }) =>
      pr === undefined ? { name } : { name, pr: { number: pr, state: 'OPEN', ...(noUrl ? {} : { url: `https://example.test/pull/${pr}` }) } },
    );
    writeFileSync(after, JSON.stringify({ branches: items, currentBranch: submitted.at(-1)?.name, trunk: 'main' }));
  }
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    `if [ "$1 $2" = "stack checkout" ] && [ ! -f '${view}' ]; then echo "${checkoutFailure.stderr}" >&2; exit ${checkoutFailure.code}; fi`,
    `if [ "$1 $2" = "stack checkout" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = "stack view" ]; then cat '${view}' || exit 1; fi`,
    `if [ "$1 $2" = "stack init" ]; then eval "git switch -q \\"\\\${$#}\\"" || exit 1; fi`,
    `if [ "$1 $2" = "stack top" ]; then git switch -q "$(cat '${join(dir, 'top')}')" || exit 1; fi`,
    `if [ "$1 $2" = "stack add" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = '${fail}' ]; then ${onFail}; exit 1; fi`,
    `if [ "$1 $2" = "stack submit" ]; then echo 'gh stack submitted'; fi`,
    `if [ "$1 $2" = "stack submit" ] && [ -f '${after}' ]; then cp '${after}' '${view}'; fi`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    // Removes only this fake's PATH entry, so several fakes in one test clean up in any order.
    [Symbol.dispose]: () => {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
      temp[Symbol.dispose]();
    },
  };
}

describe('submit', () => {
  it('refuses to submit a branch that moved after its green review', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const started = await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));

    commit(ws, 'unreviewed.txt');
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`moved after their green review.*${started?.branch}`));
  });

  it('submits a landOn run as a gh stack onto the landOn branch, leaving that branch where it was', async () => {
    using ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-953');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: 'ext-953' }), /"ext-953" is not at or below main/);
    const branches = await doneLandOnRun(ws, 'ext-953');
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'plan')?.detail ?? '', /PRs target landOn branch ext-953/);
    const landOn = sh(ws.root, 'rev-parse', 'ext-953');
    // origin is this repository, so it holds ext-953.
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base ext-953 ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...titleCalls(2)]);
    assert.ok(steps.includes('adopting 2 branches into a gh stack onto ext-953'), steps.join('\n'));
    assert.equal(sh(ws.root, 'rev-parse', 'ext-953'), landOn, 'submit does not move the landOn branch');
  });

  it('writes a single-PR handoff to pr.md after a landOn submit and says how to land it', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await handoffRun(ws);
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const output = await step(ws, run => submitStack(ws, run));
    const path = join(runDir(ws, 'demo'), 'pr.md');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base ext-953 ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...titleCalls(2)], 'nothing is merged and no PR to the trunk is opened');
    const handoff = readFileSync(path, 'utf8');
    assert.match(handoff, /^# Land the work on ext-953\n/);
    for (const expected of [
      /## Issue\n\n- Ref: #149\n- Title: Land the work on ext-953\n- URL: https:\/\/github\.com\/acme\/app\/issues\/149\n/,
      /## Summary\n\n\S/,
      /### 01 S1 \(https:\/\/example\.test\/pull\/101\)\n\nS1\n\n- S1 works/,
      /### 02 S2 \(https:\/\/example\.test\/pull\/102\)\n\nS2\n\n- S2 works/,
      /## Checks\n\n- 01 S1: test -f ok: passed in \d+ms\n- 02 S2: test -f ok: passed in \d+ms\n/,
      /- 01 S1: 1 review round; domains: performance, react-ts, testing, test-validity, devops, holistic, thermo, bug, scope, comments\n/,
      /- 02 S2: 1 review round; domains: /,
      /## Decisions\n\n1\. Keep the old flag working\n/,
      /## Outstanding concerns\n\n- Slice 01 observation thermo-naming: naming \(ok:1\)\n/,
      /## Retro findings applied\n\nNone\n/,
      /## Factory\n\nFeature: demo\n/,
    ]) {
      assert.match(handoff, expected);
    }
    assert.match(output, /^gh stack submitted\n/);
    for (const expected of ['merge the stack into ext-953', 'push ext-953', 'open one PR from ext-953 to main', path, 'Land the work on ext-953']) {
      assert.ok(output.includes(expected), `${expected}\n---\n${output}`);
    }
  });

  it('submits a landOn run whose state stored a different trunk onto the landOn branch', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    // A state written before trunk followed landOn stored the old trunk.
    const state = JSON.parse(readFileSync(statePath(ws, 'demo'), 'utf8'));
    writeFileSync(statePath(ws, 'demo'), JSON.stringify({ ...state, trunk: 'main' }));
    forgetRun(ws, 'demo');
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await step(ws, run => submitStack(ws, run));
    assert.ok(gh.calls().includes(`stack init --base ext-953 ${branches.join(' ')}`), gh.calls().join('\n'));
  });

  it('refuses a landOn run whose branch is not on origin, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    using remote = tempDir('factory-origin-');
    sh(remote.root, 'init', '-q', '--bare');
    sh(ws.root, 'remote', 'add', 'origin', remote.root);
    sh(ws.root, 'push', '-q', 'origin', 'main');
    const before = sh(ws.root, 'for-each-ref', '--format=%(refname) %(objectname)');
    const checkedOut = sh(ws.root, 'branch', '--show-current');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is not on origin.*[Pp]ush it/s);
    assert.deepEqual(gh.calls(), []);
    assert.equal(sh(ws.root, 'for-each-ref', '--format=%(refname) %(objectname)'), before, 'no ref moved');
    assert.equal(sh(ws.root, 'branch', '--show-current'), checkedOut);
  });

  it('refuses a landOn run with no origin remote with the push-first message, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), (error: Error) => {
      assert.match(error.message, /could not read origin to check for ext-953.*git push origin ext-953/s);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.deepEqual(gh.calls(), []);
  });

  it('refuses at plan time a landOn that is a revision expression or not a local branch', async () => {
    using ws = workspace();
    sh(ws.root, 'update-ref', 'refs/remotes/origin/main', 'main');
    for (const name of ['main^{commit}', 'main~0', 'origin/main', 'refs/heads/main', '../main', '-main', 'missing']) {
      await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: name }), /is not an existing local branch/, name);
    }
    assert.equal((await resolveBase(ws, { baseRef: 'main', landOn: 'main' })).landOn, 'main');
  });

  it('adopts every slice branch with gh stack init on a first submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'only gh stack init can leave the top slice checked out');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const steps: string[] = [];
    const output = await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...titleCalls(3)]);
    assert.ok(steps.includes('adopting 3 branches into a gh stack onto main'), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a first submit ends on the top slice');
    assert.equal(output, 'gh stack submitted\n', 'a stacked submit without landOn returns the gh stack submit output only');
    assert.ok(!existsSync(join(runDir(ws, 'demo'), 'pr.md')), 'a stacked submit without landOn writes no pr.md');
  });

  it('fails without adopting when gh stack checkout fails for another reason than no stack', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ checkoutFailure: { code: 4, stderr: '✗ failed to list stacks: HTTP 401: Bad credentials' }, stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /Bad credentials/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`]);
  });

  it('adds only the slices the existing stack does not hold on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 6);
    using gh = fakeGh({ stack: branches.slice(0, 5), submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack view --json',
      'stack top',
      `stack add ${branches[5]}`,
      'stack submit --auto',
      'stack view --json',
      ...titleCalls(6),
    ]);
    assert.ok(steps.includes(`adding 1 branch to the existing gh stack: ${branches[5]}`), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'an add re-submit ends on the top slice');
  });

  it('adds every missing slice in run order on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack view --json',
      'stack top',
      `stack add ${branches[1]}`,
      `stack add ${branches[2]}`,
      'stack submit --auto',
      'stack view --json',
      ...titleCalls(3),
    ]);
    assert.ok(steps.includes(`adding 2 branches to the existing gh stack: ${branches[1]}, ${branches[2]}`), steps.join('\n'));
  });

  it('only submits when the existing stack holds every slice branch', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ stack: branches, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto', 'stack view --json', ...titleCalls(2)]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a full-stack re-submit ends on the top slice');
    assert.ok(steps.includes('the gh stack already holds all 2 slice branches'), steps.join('\n'));
  });

  it('fails naming each slice branch that has no PR after gh stack submit, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: [{ name: branches[0] ?? '', pr: 101 }, { name: branches[1] ?? '' }, { name: branches[2] ?? '', pr: 103 }] });
    const error = await step(ws, run => submitStack(ws, run)).then(() => assert.fail('submit should fail'), (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`submitted.*titles were not set.*${branches[1]}`, 's'));
    assert.match(error.message, /\/factory submit again sets them/);
    assert.doesNotMatch(error.message, /Already added/);
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice has no PR');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('fails saying the titles were not set when a title PATCH fails, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using _gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches), fail: 'api -X' });
    const error = await step(ws, run => submitStack(ws, run)).then(() => assert.fail('submit should fail'), (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, /submitted.*titles were not set.*\/factory submit again sets them/s);
    assert.doesNotMatch(error.message, /Already added/);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('refuses a stack with branches outside the run or out of run order, and changes nothing', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    const [one = '', two = '', three = ''] = branches;
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, one, 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [stack, message] of [
      [[one, 'stranger'], /outside the run: stranger/],
      [[one, three, two], new RegExp(`out of run order: ${three}, ${two}`)],
    ] as const) {
      using gh = fakeGh({ stack: [...stack] });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.deepEqual(gh.calls(), [`stack checkout ${one}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before, 'a refused submit checks out the branch it started on');
    }
  });

  it('returns to a detached HEAD at the same commit after a refused submit', async () => {
    using ws = workspace();
    const [one = ''] = await doneRun(ws, 3);
    sh(ws.root, 'switch', '-q', '--detach', 'HEAD');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    using _gh = fakeGh({ stack: [one, 'stranger'] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /outside the run/);
    assert.equal(sh(ws.root, 'branch', '--show-current'), '');
    assert.equal(sh(ws.root, 'rev-parse', 'HEAD'), sha);
  });

  it('checks out the branch it started on when the gh stack view fails or is malformed', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const view of ['not json', JSON.stringify({ stacks: [] })]) {
      using gh = fakeGh({ stack: view });
      await assert.rejects(step(ws, run => submitStack(ws, run)));
      assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack add or submit fails on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [fail, message] of [
      ['stack add', /^(?![\s\S]*Already added)/],
      ['stack submit', new RegExp(`Already added to the gh stack: ${branches[2]}; run /factory submit again`)],
    ] as const) {
      using gh = fakeGh({ fail, stack: branches.slice(0, 2) });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.equal(gh.calls().at(-1)?.startsWith(fail), true, gh.calls().join('\n'));
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack init fails on a first submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ fail: 'stack init', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });

  it('keeps the gh stack error when switching back to the starting branch also fails', async () => {
    using ws = workspace();
    await doneRun(ws, 2);
    // s2.txt exists only on slice 02; a local change to it blocks the switch back to main.
    using _gh = fakeGh({ fail: 'stack init', onFail: 'echo changed > s2.txt; echo "init exploded" >&2', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /init exploded[\s\S]*Switching back to main also failed/);
  });

  it('writes no pr.md for a landOn run when a PR title fails to set', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /titles were not set/);
    assert.ok(!existsSync(join(runDir(ws, 'demo'), 'pr.md')));
  });

  it('writes no pr.md for a landOn run when gh stack view gives a slice PR no URL', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches).map((item, index) => ({ ...item, noUrl: index === 1 })) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`titled, but the handoff \\(pr\\.md\\) was not written: .*no PR URL for ${branches[1]}`, 's'));
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), titleCalls(2), 'the titles are set before the handoff');
    assert.ok(!existsSync(join(runDir(ws, 'demo'), 'pr.md')));
  });

  it('names the configured trunk, not main, as the target of the one PR in the landOn handoff', async () => {
    using ws = workspace({ trunk: 'release' });
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneLandOnRun(ws, 'ext-953');
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using _gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const output = await step(ws, run => submitStack(ws, run));
    assert.ok(output.includes('open one PR from ext-953 to release.'), output);
  });
});

describe('renderHandoff', () => {
  /** Each slice's PR, numbered from 101 with an example URL. */
  const prsOf = (run: Run) => new Map(run.slices.map((item, index) => [item.branch, { number: 101 + index, url: `https://example.test/pull/${101 + index}` }]));

  it('refuses a slice with no recorded review or whose PR has no URL', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    await doneLandOnRun(ws, 'ext-953');
    const run = readRun(ws, 'demo');
    const [one, two] = run.slices;
    assert.throws(() => renderHandoff(run, new Map(), new Map([...prsOf(run)].map(([branch, pr]) => [branch, branch === two?.branch ? { number: pr.number } : pr]))), new RegExp(`no PR URL for ${two?.branch}`));
    if (one !== undefined) one.review = undefined;
    assert.throws(() => renderHandoff(run, new Map(), prsOf(run)), /Slice 01 has no recorded review/);
  });

  it('lists stalls, budget overruns and retro findings not applied as concerns, and applied repo findings apart', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    await doneLandOnRun(ws, 'ext-953');
    const run = readRun(ws, 'demo');
    run.events.push(
      { at: 'now', detail: 'fix budget of 1 rounds used', kind: 'stall', slice: '01' },
      { at: 'now', detail: 'peak 2000 tokens, 0 compactions', kind: 'budget-exceeded', slice: '02' },
    );
    run.retroFindings = [
      { action: 'apply', category: 'automated-checks', severity: 'high', target: 'repo', title: 'Add a lint rule' },
      { action: 'file-issue', category: 'tool-economy', severity: 'medium', target: 'factory', title: 'Faster checks' },
      { action: 'skip', category: 'navigation', severity: 'low', target: 'repo', title: 'Rename a folder' },
    ];
    const { body } = renderHandoff(run, new Map(), prsOf(run));
    assert.match(
      body,
      /## Outstanding concerns\n\n- Retro finding not applied \(factory, file-issue, medium\): Faster checks\n- Retro finding not applied \(repo, skip, low\): Rename a folder\n- Slice 01 stall: fix budget of 1 rounds used\n- Slice 02 budget-exceeded: peak 2000 tokens, 0 compactions\n\n## Retro findings applied\n\n- \[high\] Add a lint rule\n/,
    );
  });

  it('says None when there are no concerns, keeps a long title exactly, and redacts issue and finding text', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    await doneLandOnRun(ws, 'ext-953');
    const run = readRun(ws, 'demo');
    const long = `Make ${'the long title '.repeat(25)}work`;
    run.source.title = long;
    const calm = renderHandoff(run, new Map([['01', []]]), prsOf(run));
    assert.match(calm.body, /## Outstanding concerns\n\nNone\n/);
    assert.equal(calm.title, long);
    run.source.title = 'Rotate GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123';
    const leaky = { ...finding('thermo', 'observation', 'naming'), path: 'src/API_KEY=hunter2.ts' };
    const { body, title } = renderHandoff(run, new Map([['01', [leaky]]]), prsOf(run));
    assert.equal(title, 'Rotate GITHUB_TOKEN=<REDACTED>');
    assert.match(body, /- Slice 01 observation thermo-naming: naming \(src\/API_KEY=<REDACTED>\)\n/);
    assert.doesNotMatch(body, /ghp_|hunter2/);
  });

  it('collapses a multi-line source title to one line so it adds no sections', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    await doneLandOnRun(ws, 'ext-953');
    const run = readRun(ws, 'demo');
    run.source.title = 'Fix it\n## Outstanding concerns\nNone';
    const { body, title } = renderHandoff(run, new Map([['01', []]]), prsOf(run));
    assert.equal(title, 'Fix it ## Outstanding concerns None');
    assert.equal(body.match(/^## Outstanding concerns$/gm)?.length, 1);
  });
});

describe('planSubmit', () => {
  const branches = ['b1', 'b2', 'b3'];
  it('adopts every branch when slice 01 is in no stack', () => {
    assert.deepEqual(planSubmit(undefined, branches), { kind: 'init' });
  });
  it('adds the branches a prefix stack lacks', () => {
    assert.deepEqual(planSubmit(['b1'], branches), { kind: 'add', missing: ['b2', 'b3'] });
  });
  it('adds nothing when the stack holds every branch', () => {
    assert.deepEqual(planSubmit(['b1', 'b2', 'b3'], branches), { kind: 'add', missing: [] });
  });
  it('refuses a stack with a branch outside the run', () => {
    assert.deepEqual(planSubmit(['b1', 'x'], branches), { kind: 'refuse', outside: ['x'], unordered: [] });
  });
  it('refuses a stack holding run branches out of order', () => {
    assert.deepEqual(planSubmit(['b1', 'b3', 'b2'], branches), { kind: 'refuse', outside: [], unordered: ['b3', 'b2'] });
  });
  it('refuses a stack with a stranger below slice 01', () => {
    assert.deepEqual(planSubmit(['x', 'b1'], branches), { kind: 'refuse', outside: ['x'], unordered: ['b1'] });
  });
});

