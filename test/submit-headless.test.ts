import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun } from '../src/run.ts';
import { nextSlice } from '../src/workflow.ts';
import { sh, tempRepo, withPrs, prCalls, submitFakeGh as fakeGh, HEADLESS_FILES, headlessSubmitRun, submitGreenWithObservation as greenWithObservation } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless submit', () => {
  it('records one submission-stop event, not an autonomous one, when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1'], { submission: 'stop' });
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => { run.retroRecorded = false; });
    await call('factory_retro', { findings: [] });
    const { events } = readRun(ws, 'demo');
    const stops = events.filter(event => event.kind === 'submission-stop');
    assert.equal(stops.length, 1, 'a repeated submission records the stop once');
    assert.match(stops[0]?.detail ?? '', /gate submission \(stop\): no PRs opened/);
    assert.ok(!events.some(event => event.kind === 'autonomous' && /submission/.test(event.detail)), 'the PR bodies list autonomous events only');
    assert.deepEqual(gh.calls(), []);
  });

  for (const policy of [{}, { submission: 'stop' }]) {
    it(`opens nothing and records no gate event when no done slice is below the slice a stopped run is red at (policy ${JSON.stringify(policy)})`, async () => {
      using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
      const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2'], policy);
      sh(repo.root, 'rm', '-q', 'ok');
      sh(repo.root, 'commit', '-qm', 'break the check');
      using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
      let text = '';
      for (let round = 0; round < 4; round++) text = (await call('factory_checks', {})).content[0]?.text ?? '';
      assert.equal(readRun(ws, 'demo').status, 'paused');
      assert.match(text, /No done slice is below slice 01, so no PRs were opened/);
      assert.deepEqual(gh.calls(), []);
      const { events } = readRun(ws, 'demo');
      assert.ok(!events.some(event => /gate submission/.test(event.detail)), 'a submission that was never eligible leaves no gate event');
      assert.ok(!events.some(event => event.kind === 'submission-stop'), 'the no-done-slice check comes before the submission policy');
    });
  }

  it('opens draft PRs when the stack becomes ready, with no /factory submit, and the reply names the PR URLs', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const completed = await call('factory_complete_slice', {});
    assert.deepEqual(gh.calls(), [], 'the stack is not ready until the retro is recorded');
    assert.doesNotMatch(completed.content[0]?.text ?? '', /pull/);
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'done');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json', ...prCalls(1)]);
    assert.match(text, /https:\/\/example\.test\/pull\/101/);
    assert.match(gh.bodies().get(101) ?? '', /S1/);
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'submit'));
  });

  it('lists the Related lines in the draft PR bodies of a headless run', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await withRun(ws, 'demo', run => { run.source = { ...run.source, url: 'https://github.com/o/r/issues/7', related: [{ ref: '8', title: 'Eighth', url: 'https://github.com/o/r/issues/8' }] }; });
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    const lines = (gh.bodies().get(101) ?? '').split('\n');
    assert.match(lines[0] ?? '', /^Issue: https:\/\/github\.com\/o\/r\/issues\/7 \(/);
    assert.equal(lines[1], 'Related: https://github.com/o/r/issues/8 (Eighth)');
  });

  it('does not tell the user to run /factory submit after a headless run opened its PRs', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.match(text, /Next: The draft PRs are open; merging stays manual\./);
    assert.doesNotMatch(text, /Next:[^\n]*\/factory submit/);
  });

  it('does not submit and leaves the run ready when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1'], { submission: 'stop' });
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'done');
    assert.deepEqual(gh.calls(), []);
    assert.match(text, /submission to stop/);
  });

  it('tells a paused stopped stack to resume before submitting when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2'], { submission: 'stop' });
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    let text = '';
    for (let round = 0; round < 4; round++) text = (await call('factory_checks', {})).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'paused');
    assert.deepEqual(gh.calls(), []);
    assert.match(text, /submission to stop[\s\S]*After \/factory resume finishes the stack/);
  });
});
