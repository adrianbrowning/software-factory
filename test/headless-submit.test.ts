import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { fakeGh, prCalls, withPrs } from './fake-gh.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, review, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

const FILES = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
type Reply = { content: { text: string }[] };

/** A headless run planned with `titles` (each blocked by the one before), whose UI throws on any dialog; slice 01 is active with `ok` committed. */
async function headlessRun(root: string, titles: string[], policy: Record<string, string> = {}) {
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
async function green(ws: Workspace) {
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
  await withRun(ws, 'demo', run => recordReview(ws, run));
}

describe('headless submit', () => {
  it('opens draft PRs when the stack becomes ready, with no /factory submit, and the reply names the PR URLs', async () => {
    using repo = tempRepo('factory-hsubmit-', FILES);
    const { branches, call, ws } = await headlessRun(repo.root, ['S1']);
    await green(ws);
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

  it('does not submit and leaves the run ready when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', FILES);
    const { branches, call, ws } = await headlessRun(repo.root, ['S1'], { submission: 'stop' });
    await green(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'done');
    assert.deepEqual(gh.calls(), []);
    assert.match(text, /submission to stop/);
  });

  it('submits the done slices below a slice that stays red, with bodies that say where and why the stack stopped, and not the red slice', async () => {
    using repo = tempRepo('factory-hsubmit-', FILES);
    const { branches, call, ws } = await headlessRun(repo.root, ['S1', 'S2']);
    await green(ws);
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

  it('keeps the saved result when gh fails: the reply names the failure and /factory submit, and ends with Next', async () => {
    using repo = tempRepo('factory-hsubmit-', FILES);
    const { branches, call, ws } = await headlessRun(repo.root, ['S1']);
    await green(ws);
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
});
