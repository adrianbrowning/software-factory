import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { planSubmit, submitStack } from '../src/submit.ts';
import { sh, step, workspace, withPrs, prCalls, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';
import type { Workspace } from '../src/run.ts';

beforeEach(() => resetModuleState());

/** A done run of `count` slices that was started on the base branch `base`. */
async function baseRun(ws: Workspace, count: number, base: string) {
  const branches = await doneRun(ws, count);
  sh(ws.root, 'branch', base, 'main');
  await step(ws, run => void (run.baseBranch = base));
  return branches;
}

/** The PATCH calls for the run's own PRs: the run's PRs follow the PRs of the stack below it, so they are numbered from `first`. */
const runPrCalls = (count: number, first: number) =>
  prCalls(count).map((call, index) => call.replace(`pulls/${101 + index} `, `pulls/${first + index} `));

describe('planSubmit with a base branch', () => {
  const branches = ['b1', 'b2', 'b3'];
  it('adds every run branch on top of the base branch when slice 01 is in no stack and the base is the top of its stack', () => {
    assert.deepEqual(planSubmit(undefined, branches, { branch: 'B', stack: ['A', 'B'] }), { kind: 'add', missing: branches, onto: 'B' });
  });
  it('refuses a base branch that is in no stack', () => {
    assert.deepEqual(planSubmit(undefined, branches, { branch: 'B', stack: undefined }), {
      kind: 'refuse-base',
      reason: 'the base branch B is in no gh stack, so the run cannot be stacked on it',
    });
  });
  it('refuses a base branch that is not the top of its stack', () => {
    assert.deepEqual(planSubmit(undefined, branches, { branch: 'B', stack: ['A', 'B', 'C'] }), {
      kind: 'refuse-base',
      reason: 'the base branch B is not the top of its gh stack (A, B, C); the run can only be stacked on the top branch',
    });
  });
  it('accepts a stack that ends with the base branch below slice 01 and adds the run branches it lacks', () => {
    assert.deepEqual(planSubmit(['A', 'B', 'b1'], branches, { branch: 'B', stack: undefined }), { kind: 'add', missing: ['b2', 'b3'] });
  });
  it('adds nothing when the stack holds the base branch and every run branch', () => {
    assert.deepEqual(planSubmit(['B', ...branches], branches, { branch: 'B', stack: undefined }), { kind: 'add', missing: [] });
  });
  it('refuses a stack whose branches below slice 01 do not end with the base branch', () => {
    assert.deepEqual(planSubmit(['A', 'X', 'b1'], branches, { branch: 'B', stack: undefined }), { kind: 'refuse', outside: [], unordered: [], base: 'B' });
  });
  it('refuses a stack with an outside branch above slice 01', () => {
    assert.deepEqual(planSubmit(['B', 'b1', 'X'], branches, { branch: 'B', stack: undefined }), { kind: 'refuse', outside: ['X'], unordered: [] });
  });
  it('refuses a run branch below slice 01 and run branches out of order', () => {
    assert.deepEqual(planSubmit(['B', 'b3', 'b1', 'b2'], branches, { branch: 'B', stack: undefined }), { kind: 'refuse', outside: [], unordered: ['b3'], base: 'B' });
  });
  it('plans a run without a base branch as before', () => {
    assert.deepEqual(planSubmit(undefined, branches), { kind: 'init' });
    assert.deepEqual(planSubmit(['x', 'b1'], branches), { kind: 'refuse', outside: ['x'], unordered: ['b1'] });
  });
});

describe('submit: a run on a base branch', () => {
  it('adds the slice branches on top of the base branch with gh stack add, runs no gh stack init, and sets only the run PRs', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({
      stack: ['A', 'B'],
      unstacked: [branches[0] ?? ''],
      submitted: [{ name: 'A', pr: 7 }, { name: 'B', pr: 8 }, ...withPrs(branches).map(item => ({ ...item, pr: item.pr + 100 }))],
    });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack checkout B',
      'stack view --json',
      'stack top',
      `stack add ${branches[0]}`,
      `stack add ${branches[1]}`,
      'stack submit --auto',
      'stack view --json',
      ...runPrCalls(2, 201),
    ]);
    assert.ok(steps.includes(`adding 2 branches onto the gh stack whose top is B: ${branches.join(', ')}`), steps.join('\n'));
    assert.deepEqual(gh.stackAtSubmit(), ['A', 'B', ...branches]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1));
  });

  it('builds the stack A, B, then the slices on a first submit, and adds no branch and does not refuse on a second submit', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({ stack: ['A', 'B'], unstacked: [branches[0] ?? ''], submitted: [{ name: 'A', pr: 7 }, { name: 'B', pr: 8 }, ...withPrs(branches).map(item => ({ ...item, pr: item.pr + 100 }))] });
    await step(ws, run => submitStack(ws, run));
    assert.deepEqual(gh.stackAtSubmit(), ['A', 'B', ...branches]);
    const first = gh.calls().length;
    sh(ws.root, 'switch', '-q', 'main');
    await step(ws, run => submitStack(ws, run));
    assert.deepEqual(gh.calls().slice(first), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto', 'stack view --json', ...runPrCalls(2, 201)]);
    assert.deepEqual(gh.stackAtSubmit(), ['A', 'B', ...branches]);
  });

  it('refuses a stack with a branch between the base branch and slice 01, and submits nothing', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({ stack: ['A', 'X', ...branches] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /base branch B/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });

  it('refuses a stack with a branch outside the run above slice 01', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({ stack: ['A', 'B', ...branches, 'X'] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /outside the run: X/);
    assert.ok(!gh.calls().some(call => call.startsWith('stack submit')));
  });

  it('refuses a base branch that is in no stack and returns the checkout to where it started', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({ stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /base branch B is in no gh stack/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack checkout B']);
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });

  it('refuses a base branch that is not the top of its stack and returns the checkout to where it started', async () => {
    using ws = workspace();
    const branches = await baseRun(ws, 2, 'B');
    using gh = fakeGh({ stack: ['A', 'B', 'C'], unstacked: [branches[0] ?? ''] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /base branch B is not the top of its gh stack/);
    assert.ok(!gh.calls().some(call => call.startsWith('stack add') || call.startsWith('stack init') || call.startsWith('stack submit')));
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });
});
