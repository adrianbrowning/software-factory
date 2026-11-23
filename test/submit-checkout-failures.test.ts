import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { submitStack } from '../src/submit.ts';
import { sh, step, workspace, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit: returning to the starting branch after a gh failure', () => {
  it('checks out the branch it started on when the gh stack view fails or is malformed', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [view, message] of [
      ['not json', /JSON/],
      [JSON.stringify({ stacks: [] }), /branches/],
    ] as const) {
      using gh = fakeGh({ stack: view });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
    using gh = fakeGh({ fail: 'stack view', stack: branches });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /Command failed: gh stack view --json/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
    assert.equal(sh(ws.root, 'branch', '--show-current'), before);
  });

  it('checks out the branch it started on when gh stack add or submit fails on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    assert.notEqual(before, branches.at(-1), 'the submit starts off the top slice, so a checkout left behind shows');
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
    await assert.rejects(step(ws, run => submitStack(ws, run)), /gh stack init/);
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
});
