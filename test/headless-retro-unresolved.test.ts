import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, review, slice, tempRepo, CHECKS_OK, type Reply, retroDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless retro: Record slices accepted unresolved', () => {
  /** Runs the active Record slice through its fix budget with blocking findings, so a headless run accepts it unresolved. */
  async function acceptUnresolved(ws: Workspace, call: (name: string, params: unknown) => Promise<Reply>, tag: string) {
    for (const round of ['one', 'two', 'three', 'four']) {
      commit(ws, 'ok', `${tag}${round}\n`);
      await withRun(ws, 'demo', run => runChecks(ws, run));
      const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
      await review(ws, reviewId, [finding('scope', 'high', 'a'), finding('bug', 'high', 'b')]);
      await call('factory_review_record', {});
    }
  }

  it('a Record slice accepted unresolved defers none of its findings, and its items get one new Record slice listing them', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'first');
    const accepted = readRun(ws, 'demo');
    assert.equal(accepted.slices[1]?.record, true);
    assert.equal(accepted.deferred.length, 1);
    assert.ok((accepted.slices[1]?.unresolved ?? []).length > 0);
    assert.ok(accepted.events.some(event => event.kind === 'accepted-unresolved' && /not deferred/.test(event.detail)));
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Record deferred items 2']);
    assert.equal(run.status, 'running');
    assert.equal(run.deferred[0]?.recorded, run.slices[2]?.id);
    assert.match(readFileSync(ticketPath(ws, 'demo', run.slices[2] ?? assert.fail('no retry slice')), 'utf8'), /naming/);
  });

  it('a retry Record slice also accepted unresolved adds no third one, the run becomes done, and factory_status shows the items as not written', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'first');
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'second');
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Record deferred items 2']);
    assert.equal(run.status, 'done');
    const status = JSON.parse((await call('factory_status', {})).content[0]?.text ?? '{}') as { deferred: { id: string; status?: string }[] };
    assert.deepEqual(status.deferred.map(item => item.status), ['not written to the file after a retry']);
  });

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
