import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { submitStack } from '../src/submit.ts';
import { sh, step, workspace } from './helpers.ts';
import { doneRun, fakeGh } from './submit-fixtures.ts';

describe('submit refusals', () => {
  it('fails without adopting when gh stack checkout fails for another reason than no stack', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ checkoutFailure: { code: 4, stderr: '✗ failed to list stacks: HTTP 401: Bad credentials' }, stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /Bad credentials/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`]);
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
});
