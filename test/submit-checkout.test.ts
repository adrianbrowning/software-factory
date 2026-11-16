import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { submitStack } from '../src/submit.ts';
import { sh, step, workspace, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit: refused stacks and the starting checkout', () => {
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
});
