import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun } from '../src/run.ts';
import { submitStack } from '../src/submit.ts';
import { sh, step, workspace, withPrs, prCalls, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit: re-submit and failed stack calls', () => {
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
      ...prCalls(6),
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
      ...prCalls(3),
    ]);
    assert.ok(steps.includes(`adding 2 branches to the existing gh stack: ${branches[1]}, ${branches[2]}`), steps.join('\n'));
  });

  it('only submits when the existing stack holds every slice branch', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ stack: branches, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto', 'stack view --json', ...prCalls(2)]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a full-stack re-submit ends on the top slice');
    assert.ok(steps.includes('the gh stack already holds all 2 slice branches'), steps.join('\n'));
  });

  it('fails naming each slice branch that has no PR after gh stack submit, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: [{ name: branches[0] ?? '', pr: 101 }, { name: branches[1] ?? '' }, { name: branches[2] ?? '', pr: 103 }] });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, new RegExp(`submitted.*titles were not set.*${branches[1]}`, 's'));
    assert.match(failure.message, /\/factory submit again sets them/);
    assert.doesNotMatch(failure.message, /Already added/);
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice has no PR');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('fails saying the titles were not set when a title PATCH fails, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using _gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches), fail: 'api -X' });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, /submitted.*titles were not set.*\/factory submit again sets them/s);
    assert.doesNotMatch(failure.message, /Already added/);
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'submit'), 'the submit event is saved with the run');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('keeps the submit event, and reports the failure, when interactive /factory submit cannot set a PR title or body', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    const commands = new Map<string, Command>();
    load({ commands });
    const caller = { ...ctx('main', 'main'), cwd: ws.root, hasUI: true, ui: { confirm: async () => true, notify() {}, setStatus() {} } };
    await assert.rejects(commands.get('factory')?.handler('submit demo', caller) ?? Promise.resolve(), /titles were not set/);
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'submit').length, 1, 'the PRs are on GitHub, so the run records the submit');
  });
});
