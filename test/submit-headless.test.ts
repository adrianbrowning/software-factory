import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, review, sh, slice, tempRepo, withPrs, prCalls, submitFakeGh as fakeGh, type Reply } from './helpers.ts';

beforeEach(() => resetModuleState());

const HEADLESS_FILES = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };

/** A headless run planned with `titles` (each blocked by the one before), whose UI throws on any dialog; slice 01 is active with `ok` committed. */
async function headlessSubmitRun(root: string, titles: string[], policy: Record<string, string> = {}) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], headless: policy }));
  sh(root, 'commit', '-qam', 'policy');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const noDialog = async (title: string) => {
    throw new Error(`dialog: ${title}`);
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])))));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  return { branches: readRun(ws, 'demo').slices.map(item => item.branch), call, ws };
}

/** Takes the active slice to a green review. */
async function greenWithObservation(ws: Workspace) {
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
  await withRun(ws, 'demo', run => recordReview(ws, run));
}

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
