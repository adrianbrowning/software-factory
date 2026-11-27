import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { CHECKS_OK, commit, review, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

/** A headless run with slices 01 and 02, 01 active with a green review, and 02's branch cut from 01's head; `moveHead` commits on 01 afterwards. */
async function stacked(root: string, moveHead: boolean) {
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {}, select: async () => undefined } };
  const call = async (name: string) => ((await tools.get(name)?.execute('id', {}, undefined, undefined, caller)) as { content: { text: string }[] }).content[0]?.text ?? '';
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
  return call;
}

describe('factory_complete_slice reply', () => {
  it('says every later slice branch is rebased when completing a never-reopened slice moved one', async () => {
    using repo = tempRepo('factory-restack-', CHECKS_OK);
    const call = await stacked(repo.root, true);
    assert.match(await call('factory_complete_slice'), /Every later slice branch is rebased onto it/);
  });

  it('does not say it when no later branch moved', async () => {
    using repo = tempRepo('factory-restack-', CHECKS_OK);
    const call = await stacked(repo.root, false);
    assert.doesNotMatch(await call('factory_complete_slice'), /Every later slice branch is rebased onto it/);
  });
});
