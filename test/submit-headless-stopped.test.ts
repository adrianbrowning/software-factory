import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun } from '../src/run.ts';
import { nextSlice } from '../src/workflow.ts';
import { sh, tempRepo, withPrs, prCalls, submitFakeGh as fakeGh, HEADLESS_FILES, headlessSubmitRun, submitGreenWithObservation as greenWithObservation } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless submit: stopped stacks and gh failures', () => {
  it('submits the done slices below a slice that stays red, with bodies that say where and why the stack stopped, and not the red slice', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 3; round++) await call('factory_checks', {});
    assert.deepEqual(gh.calls(), [], 'nothing is submitted before the last fix round');
    const text = (await call('factory_checks', {})).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'paused');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json', ...prCalls(1)]);
    assert.match(text, /https:\/\/example\.test\/pull\/101/);
    assert.match(gh.bodies().get(101) ?? '', /stack stopped at slice 02 "S2".*still red after 3 fix rounds/);
    assert.equal(sh(repo.root, 'branch', '--show-current'), branches[1], 'the run is back on the red slice');
  });

  it('puts the checkout back on the red slice when a PR title or body PATCH fails during a stopped submit', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 4; round++) await call('factory_checks', {});
    assert.deepEqual(gh.calls().slice(0, 4), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json']);
    assert.ok(gh.calls().at(-1)?.startsWith('api -X PATCH'), gh.calls().join('\n'));
    assert.equal(readRun(ws, 'demo').status, 'paused');
    assert.equal(sh(repo.root, 'branch', '--show-current'), branches[1], 'the run is back on the red slice');
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    assert.ok(kinds.includes('autonomous') && kinds.includes('submit') && kinds.includes('submit-failed'), kinds.join());
  });

  it('keeps the submit event when the switch back to the red slice fails after a successful stopped submit', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    // `ok` is deleted on slice 02 and tracked on slice 01; a local change to it blocks the switch back.
    using _gh = fakeGh({ onSubmit: 'echo changed > ok', stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 4; round++) await call('factory_checks', {});
    const events = readRun(ws, 'demo').events;
    const kinds = events.map(event => event.kind);
    assert.ok(kinds.includes('submit') && kinds.includes('submit-failed'), kinds.join());
    assert.match(events.find(event => event.kind === 'submit-failed')?.detail ?? '', /Switching back to .* failed/);
  });

  it('keeps the saved result when gh fails: the reply names the failure and /factory submit, and ends with Next', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using gh = fakeGh({ fail: 'stack submit', onFail: 'echo "push rejected" >&2', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'done');
    assert.equal(run.slices[0]?.status, 'done');
    assert.ok(run.retroRecorded);
    assert.ok(gh.calls().includes('stack submit --auto'));
    assert.match(text, /Submission failed[\s\S]*push rejected[\s\S]*\/factory submit retries it/);
    assert.match(text, /\nNext: [^\n]*$/, 'the reply ends with the Next line');
    assert.ok(run.events.some(event => event.kind === 'submit-failed'));
  });

  it('saves the autonomous gate event and submit-failed, but no submit event, when gh stack submit fails', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ fail: 'stack submit', onFail: 'echo "push rejected" >&2', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    assert.ok(kinds.includes('autonomous'), kinds.join());
    assert.ok(kinds.includes('submit-failed'));
    assert.ok(!kinds.includes('submit'));
    await withRun(ws, 'demo', run => { run.retroRecorded = false; });
    await call('factory_retro', { findings: [] });
    const gateChoices = readRun(ws, 'demo').events.filter(event => event.kind === 'autonomous' && event.detail.startsWith('gate submission (auto)'));
    assert.equal(gateChoices.length, 1, 'a repeat submission lists the gate choice once');
  });

  it('saves the autonomous, submit and submit-failed events when a PATCH fails after gh stack submit succeeds', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    for (const kind of ['autonomous', 'submit', 'submit-failed']) assert.ok(kinds.includes(kind), `${kind} in ${kinds.join()}`);
  });
});
