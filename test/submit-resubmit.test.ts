import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { submitStack } from '../src/submit.ts';
import { readRun } from '../src/run.ts';
import { sh, step, workspace, withPrs, prCalls, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit: re-submit', () => {
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
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice');
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
      ...prCalls(6),
    ]);
    assert.ok(steps.includes(`adding 1 branch to the existing gh stack: ${branches[5]}`), steps.join('\n'));
    assert.equal(readRun(ws, 'demo').events.find(event => event.kind === 'submit')?.detail, `added ${branches[5]} to the existing gh stack and submitted; draft PRs opened or updated`);
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
      ...prCalls(3),
    ]);
    assert.ok(steps.includes(`adding 2 branches to the existing gh stack: ${branches[1]}, ${branches[2]}`), steps.join('\n'));
    assert.equal(readRun(ws, 'demo').events.find(event => event.kind === 'submit')?.detail, `added ${branches[1]}, ${branches[2]} to the existing gh stack and submitted; draft PRs opened or updated`);
  });

  it('only submits when the existing stack holds every slice branch', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice');
    using gh = fakeGh({ stack: branches, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto', 'stack view --json', ...prCalls(2)]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a full-stack re-submit ends on the top slice');
    assert.ok(steps.includes('the gh stack already holds all 2 slice branches'), steps.join('\n'));
    assert.equal(readRun(ws, 'demo').events.find(event => event.kind === 'submit')?.detail, 're-submitted the existing gh stack; draft PRs opened or updated');
  });
});
