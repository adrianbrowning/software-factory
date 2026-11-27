import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices, reopenSlice } from '../src/workflow.ts';
import { CHECKS_OK, commit, review, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

/** A headless run with slices 01 and 02, 01 active with a green review, and 02's branch cut from 01's head; `moveHead` commits on 01 afterwards. */
async function stacked(root: string, moveHead: boolean) {
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {}, select: async () => undefined } };
  const call = async (name: string) => {
    const tool = tools.get(name) ?? assert.fail(`tool ${name} is not registered`);
    return ((await tool.execute('id', {}, undefined, undefined, caller)) as { content: { text: string }[] }).content[0]?.text ?? '';
  };
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature'), slice('Second', ['Feature'])])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  const second = readRun(ws, 'demo').slices[1]?.branch ?? assert.fail('no slice 02');
  sh(root, 'branch', second);
  if (moveHead) commit(ws, 'more.txt');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, []);
  await withRun(ws, 'demo', run => recordReview(ws, run));
  return { call, second, ws };
}

describe('factory_complete_slice reply', () => {
  it('says every later slice branch is rebased when completing a never-reopened slice moved one', async () => {
    using repo = tempRepo('factory-restack-', CHECKS_OK);
    const { call } = await stacked(repo.root, true);
    assert.match(await call('factory_complete_slice'), /Every later slice branch is rebased onto it/);
  });

  it('does not say it when no later branch moved', async () => {
    using repo = tempRepo('factory-restack-', CHECKS_OK);
    const { call } = await stacked(repo.root, false);
    assert.doesNotMatch(await call('factory_complete_slice'), /Every later slice branch is rebased onto it/);
  });

  it('says the later slices earn their checks again, and not that a branch was rebased, when a reopened slice had its later branch rebased by hand', async () => {
    using repo = tempRepo('factory-restack-', CHECKS_OK);
    const { call, second, ws } = await stacked(repo.root, false);
    await call('factory_complete_slice');
    await withRun(ws, 'demo', run => reopenSlice(ws, run, '01', 'bug'));
    const first = sh(repo.root, 'branch', '--show-current');
    const oldTip = sh(repo.root, 'rev-parse', first);
    commit(ws, 'fix.txt');
    sh(repo.root, 'rebase', '-q', '--onto', first, oldTip, second);
    sh(repo.root, 'switch', '-q', first);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    const reply = await call('factory_complete_slice');
    assert.match(reply, /is done on/);
    assert.match(reply, /The later slices earn their checks and review again/);
    assert.doesNotMatch(reply, /Every later slice branch is rebased onto it/);
  });
});
