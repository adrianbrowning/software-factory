import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, ticketPath, withRun } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, review, slice, tempRepo, CHECKS_OK, retroDoneRun as doneRun, acceptUnresolved } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless retro: a split Record slice accepted unresolved', () => {
  /** Splits the active Record slice in two, completes the first child clean and accepts the second unresolved. `legacy` first drops the batch label, as a state file from before it has none. */
  async function failSecondChild(legacy: boolean) {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    if (legacy) {
      await withRun(ws, 'demo', run => {
        (run.slices[1] ?? assert.fail('no record slice')).recordBatch = undefined;
      });
    }
    await call('factory_reslice', { slices: [slice('Record part one'), slice('Record part two', ['Record part one'])] });
    commit(ws, 'ok', 'part one\n');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'second child');
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.equal(run.slices[1]?.unresolved, undefined, 'the first child is clean');
    assert.ok((run.slices[2]?.unresolved ?? []).length > 0, 'the second child is accepted unresolved');
    assert.equal(run.status, 'running');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record part one', 'Record part two', 'Record deferred items 2'], 'the split Record slice is one batch, so the next one is numbered 2');
    assert.equal(run.deferred[0]?.retried, true);
    assert.equal(run.deferred[0]?.recorded, run.slices[3]?.id);
    assert.match(readFileSync(ticketPath(ws, 'demo', run.slices[3] ?? assert.fail('no retry slice')), 'utf8'), /naming/);
  }

  it('a later child of a resliced Record slice accepted unresolved sends its items to the one retry Record slice; the clean first child alone does not', () => failSecondChild(false));

  it('the same holds when the split Record slice came from a state file with no batch label', () => failSecondChild(true));
});
