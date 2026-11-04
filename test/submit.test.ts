import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { greenCommit, readRun, type Workspace } from '../src/run.ts';
import { completeSlice } from '../src/review.ts';
import { planSubmit, submitStack } from '../src/submit.ts';
import { approvePlan, nextSlice, parseRetro, planSlices, recordRetro, resolveBase } from '../src/workflow.ts';
import { commit, green, newRun, roots, sh, slice, start, step, workspace } from './helpers.ts';

/** A done run of `count` chained slices, each with a reviewed commit. */
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
}

/**
 * Puts a fake `gh` first on PATH until test `t` ends; it records each call. With a stack, `stack checkout <branch>`
 * switches to that branch, as gh-stack does; `stack init` switches to its last (top) branch, `stack top` to the
 * stack's top branch, and `stack add <branch>` to the branch it adds.
 */
function fakeGh(t: TestContext, { stack, checkoutFailure = NO_STACK, fail = '', onFail = ':' }: FakeGh) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gh-'));
  roots.push(dir);
  const log = join(dir, 'calls');
  const view = join(dir, 'view.json');
  if (typeof stack === 'string') writeFileSync(view, stack);
  else if (stack !== undefined) {
    writeFileSync(view, JSON.stringify({ branches: stack.map(name => ({ name })), currentBranch: stack[0], trunk: 'main' }));
    writeFileSync(join(dir, 'top'), stack.at(-1) ?? '');
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
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  // Removes only this fake's directory, so several fakes in one test clean up in any order.
  t.after(() => {
    process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
  });
  return { calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('submit', () => {
  it('refuses to submit a branch that moved after its green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const started = await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));

    commit(ws, 'unreviewed.txt');
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`moved after their green review.*${started?.branch}`));
  });

  it('lands a multi-slice run on an existing branch by fast-forwarding it to the top slice, without checkout', async () => {
    const ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-953');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: 'ext-953' }), /"ext-953" is not at or below main/);
    await start(ws);
    const base = await resolveBase(ws, { landOn: 'ext-953' });
    assert.equal(base.baseRef, 'ext-953');
    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('One'), slice('Two', ['One'])], base), base));
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'plan')?.detail ?? '', /lands on ext-953/);
    for (const file of ['ok', 'two.txt']) {
      await step(ws, run => nextSlice(ws, run));
      commit(ws, file);
      await green(ws);
      await step(ws, run => completeSlice(ws, run));
    }
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    const top = readRun(ws, 'demo').slices[1];
    const checkedOut = sh(ws.root, 'branch', '--show-current');

    sh(ws.root, 'switch', '-q', 'ext-953');
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is checked out/);
    sh(ws.root, 'switch', '-q', checkedOut);
    const linked = mkdtempSync(join(tmpdir(), 'factory-wt-'));
    roots.push(linked);
    sh(ws.root, 'worktree', 'add', '-q', linked, 'ext-953');
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is checked out in .*factory-wt-/);
    sh(ws.root, 'worktree', 'remove', linked);

    const steps: string[] = [];
    const output = await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(steps, ['checking the working tree and the slice branches', 'fast-forwarding ext-953 to the top slice']);
    assert.match(output, /ext-953 fast-forwarded to .*No PRs were opened/);
    assert.equal(sh(ws.root, 'rev-parse', 'ext-953'), top === undefined ? undefined : greenCommit(top));
    assert.equal(sh(ws.root, 'branch', '--show-current'), checkedOut, 'the checkout is unchanged');
    assert.equal(sh(ws.root, 'rev-list', '--merges', '--count', 'ext-953'), '0');
  });

  it('refuses at plan time a landOn that is a revision expression or not a local branch', async () => {
    const ws = workspace();
    sh(ws.root, 'update-ref', 'refs/remotes/origin/main', 'main');
    for (const name of ['main^{commit}', 'main~0', 'origin/main', 'refs/heads/main', '../main', '-main', 'missing']) {
      await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: name }), /is not an existing local branch/, name);
    }
    assert.equal((await resolveBase(ws, { baseRef: 'main', landOn: 'main' })).landOn, 'main');
  });

  it('refuses to land when the target branch moved off the stack', async () => {
    const ws = workspace();
    sh(ws.root, 'branch', 'target');
    await start(ws);
    const base = await resolveBase(ws, { landOn: 'target' });
    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')], base), base));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    const slices = sh(ws.root, 'branch', '--show-current');
    sh(ws.root, 'switch', '-q', 'target');
    commit(ws, 'elsewhere.txt');
    const moved = sh(ws.root, 'rev-parse', 'HEAD');
    sh(ws.root, 'switch', '-q', slices);
    await assert.rejects(step(ws, run => submitStack(ws, run)), /target is gone or moved off the stack's base/);
    assert.equal(sh(ws.root, 'rev-parse', 'target'), moved);
  });

  it('adopts every slice branch with gh stack init on a first submit', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 3);
    sh(ws.root, 'switch', '-q', 'main');
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'only gh stack init can leave the top slice checked out');
    const gh = fakeGh(t, { stack: undefined });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`, 'stack submit --auto']);
    assert.ok(steps.includes('adopting 3 branches into a gh stack onto main'), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a first submit ends on the top slice');
  });

  it('fails without adopting when gh stack checkout fails for another reason than no stack', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 2);
    const gh = fakeGh(t, { checkoutFailure: { code: 4, stderr: '✗ failed to list stacks: HTTP 401: Bad credentials' }, stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /Bad credentials/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`]);
  });

  it('adds only the slices the existing stack does not hold on a re-submit', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 6);
    const gh = fakeGh(t, { stack: branches.slice(0, 5) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', `stack add ${branches[5]}`, 'stack submit --auto']);
    assert.ok(steps.includes(`adding 1 branch to the existing gh stack: ${branches[5]}`), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'an add re-submit ends on the top slice');
  });

  it('adds every missing slice in run order on a re-submit', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 3);
    const gh = fakeGh(t, { stack: branches.slice(0, 1) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack view --json',
      'stack top',
      `stack add ${branches[1]}`,
      `stack add ${branches[2]}`,
      'stack submit --auto',
    ]);
    assert.ok(steps.includes(`adding 2 branches to the existing gh stack: ${branches[1]}, ${branches[2]}`), steps.join('\n'));
  });

  it('only submits when the existing stack holds every slice branch', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 2);
    const gh = fakeGh(t, { stack: branches });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto']);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a full-stack re-submit ends on the top slice');
    assert.ok(steps.includes('the gh stack already holds all 2 slice branches'), steps.join('\n'));
  });

  it('refuses a stack with branches outside the run or out of run order, and changes nothing', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 3);
    const [one = '', two = '', three = ''] = branches;
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, one, 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [stack, message] of [
      [[one, 'stranger'], /outside the run: stranger/],
      [[one, three, two], new RegExp(`out of run order: ${three}, ${two}`)],
    ] as const) {
      const gh = fakeGh(t, { stack: [...stack] });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.deepEqual(gh.calls(), [`stack checkout ${one}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before, 'a refused submit checks out the branch it started on');
    }
  });

  it('returns to a detached HEAD at the same commit after a refused submit', async t => {
    const ws = workspace();
    const [one = ''] = await doneRun(ws, 3);
    sh(ws.root, 'switch', '-q', '--detach', 'HEAD');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    fakeGh(t, { stack: [one, 'stranger'] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /outside the run/);
    assert.equal(sh(ws.root, 'branch', '--show-current'), '');
    assert.equal(sh(ws.root, 'rev-parse', 'HEAD'), sha);
  });

  it('checks out the branch it started on when the gh stack view fails or is malformed', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 2);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const view of ['not json', JSON.stringify({ stacks: [] })]) {
      const gh = fakeGh(t, { stack: view });
      await assert.rejects(step(ws, run => submitStack(ws, run)));
      assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack add or submit fails on a re-submit', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 3);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [fail, message] of [
      ['stack add', /^(?![\s\S]*Already added)/],
      ['stack submit', new RegExp(`Already added to the gh stack: ${branches[2]}; run /factory submit again`)],
    ] as const) {
      const gh = fakeGh(t, { fail, stack: branches.slice(0, 2) });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.equal(gh.calls().at(-1)?.startsWith(fail), true, gh.calls().join('\n'));
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack init fails on a first submit', async t => {
    const ws = workspace();
    const branches = await doneRun(ws, 2);
    sh(ws.root, 'switch', '-q', 'main');
    const gh = fakeGh(t, { fail: 'stack init', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });

  it('keeps the gh stack error when switching back to the starting branch also fails', async t => {
    const ws = workspace();
    await doneRun(ws, 2);
    sh(ws.root, 'switch', '-q', 'main');
    // s2.txt exists only on slice 02; a local change to it blocks the switch back to main.
    fakeGh(t, { fail: 'stack init', onFail: 'echo changed > s2.txt; echo "init exploded" >&2', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /init exploded[\s\S]*Switching back to main also failed/);
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

