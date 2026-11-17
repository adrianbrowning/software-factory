import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun, ticketPath, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations } from '../src/observations.ts';
import { addFollowUp, applyReslice, nextAction, nextSlice, pauseRun, planReslice, resolveStall } from '../src/workflow.ts';
import { parseRetro, recordRetro } from '../src/retro.ts';
import { commit, finding, green, newRun, review, sh, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: queued follow-up work', { concurrency: 4 }, () => {
  it('queues carried work on the run for the end-of-run follow-up without changing any slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    const before = readRun(ws, 'demo');

    await step(ws, run => carryObservations(ws, run, { note: 'Also log the parse time.', observations: ['thermo-naming'], to: 'end' }));
    const after = readRun(ws, 'demo');
    assert.deepEqual(after.slices.map(item => ({ ...item, unplaced: [] })), before.slices.map(item => ({ ...item, unplaced: [] })), 'no slice changes');
    assert.equal(after.waiting.length, 1);
    assert.match(after.waiting[0] ?? '', /^### From green review 01-r1 of slice 01 "Feature"\n\nAlso log the parse time\.\n\n#### \[observation\] thermo-naming/);
    await step(ws, run => completeSlice(ws, run));
    assert.equal(nextAction(readRun(ws, 'demo')), 'Call factory_next to start the next slice.', 'a pending slice comes before the follow-up');
  });

  /** Starts a one-slice run in `ws` whose slice is green with a thermo-naming observation, carried with a note to the end of the run. */
  async function queuedRun(ws: Workspace) {
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => carryObservations(ws, run, { note: 'Also log the parse time.', to: 'end' }));
    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' }));
  }

  const followUp = { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' };

  it('takes every waiting item into the next follow-up slice ticket and empties the queue', async () => {
    using ws = workspace({ maxRounds: 2 });
    await queuedRun(ws);
    await step(ws, run => completeSlice(ws, run));
    const added = await step(ws, run => addFollowUp(ws, run, followUp));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.waiting, []);
    assert.equal(run.slices[1]?.carried.length, 2);
    const ticket = readFileSync(ticketPath(ws, 'demo', added), 'utf8');
    assert.match(ticket, /## Carried-in work[\s\S]*Also log the parse time\.[\s\S]*#### \[observation\] thermo-naming/);
  });

  it('points nextAction to factory_follow_up only while items wait and no slice is pending', async () => {
    using ws = workspace({ maxRounds: 2 });
    await queuedRun(ws);
    assert.match(nextAction(readRun(ws, 'demo')), /^Call factory_complete_slice for slice 01/);
    await step(ws, run => completeSlice(ws, run));
    assert.equal(
      nextAction(readRun(ws, 'demo')),
      'Carried items wait for the end of the run (2). Call factory_follow_up for them (title, what to build, acceptance, seams or noTestReason, estimate); its slice takes every waiting item. The retro waits until then.',
    );
    await step(ws, run => addFollowUp(ws, run, followUp));
    assert.equal(nextAction(readRun(ws, 'demo')), 'Call factory_next to start the next slice.');
  });

  it('refuses the retro while items wait, and runs it once the follow-up slice took them', async () => {
    using ws = workspace({ maxRounds: 2 });
    await queuedRun(ws);
    assert.throws(() => parseRetro(ws, readRun(ws, 'demo'), []), (error: Error) => /Finish the pending slices first/.test(error.message) && !/Call factory_follow_up/.test(error.message));
    await step(ws, run => completeSlice(ws, run));
    assert.throws(() => parseRetro(ws, readRun(ws, 'demo'), []), /Carried items wait for the end of the run \(2\)\. Call factory_follow_up for them/);
    await assert.rejects(step(ws, run => recordRetro(ws, run, { apply: [], file: [], findings: [], ordinal: 1 })), /Carried items wait for the end of the run \(2\)/);
    await step(ws, run => addFollowUp(ws, run, followUp));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'polish.txt');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    assert.equal(readRun(ws, 'demo').status, 'done');
  });

  it('refuses the retro on a stalled run with waiting items by pointing to /factory resume, not factory_follow_up', async () => {
    using ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature'), slice('Next', ['Feature'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => carryObservations(ws, run, { note: 'Also log the parse time.', to: 'end' }));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    sh(ws.root, 'rm', '-q', 'ok');
    sh(ws.root, 'commit', '-qm', 'drop ok');
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => resolveStall(ws, run, 'pause'));
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'stalled');
    assert.throws(
      () => parseRetro(ws, run, []),
      (error: Error) =>
        /Carried items wait for the end of the run \(1\)/.test(error.message) &&
        /fix budget of slice 02 "Next" is used up.*\/factory resume demo asks whether to raise it/.test(error.message) &&
        !/Call factory_follow_up/.test(error.message),
    );
  });

  it('refuses the retro on a paused, finished run with waiting items by pointing to /factory resume, not factory_follow_up', async () => {
    using ws = workspace({ maxRounds: 2 });
    await queuedRun(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => pauseRun(run, 'test'));
    assert.throws(
      () => parseRetro(ws, readRun(ws, 'demo'), []),
      (error: Error) => /Tell the user to \/factory resume demo first/.test(error.message) && !/Call factory_follow_up/.test(error.message),
    );
  });

  it('keeps a run with waiting items from settling after the retro slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run =>
      recordRetro(ws, run, parseRetro(ws, run, [{ action: 'apply', category: 'automated-checks', detail: 'Add a lint rule', severity: 'high', target: 'repo', title: 'Lint rule' }])),
    );
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'lint.txt');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [{ ...finding('thermo', 'observation', 'naming'), path: 'lint.txt' }]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' }));
    await step(ws, run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'running');
    assert.match(nextAction(run), /^Carried items wait for the end of the run \(1\)\. Call factory_follow_up/);
    assert.throws(() => parseRetro(ws, run, []), /^Error: Carried items wait for the end of the run \(1\)/, 'the queue refusal comes before "already recorded"');
  });

  it('keeps carried work through a re-slice: the first child takes the split slice items, later slices keep theirs', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Big', ['Feature']), slice('Last', ['Big'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => carryObservations(ws, run, { note: 'Big must log.', to: '02' }));
    await step(ws, run => carryObservations(ws, run, { note: 'Last must log.', to: '03' }));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));

    await step(ws, run => applyReslice(ws, run, planReslice(ws, run, [slice('Big A', ['Feature']), slice('Big B', ['Big A'])])));
    const slices = readRun(ws, 'demo').slices;
    const ticket = (index: number) => readFileSync(ticketPath(ws, 'demo', slices[index] ?? assert.fail('no slice')), 'utf8');
    assert.deepEqual(slices.map(item => item.title), ['Feature', 'Big A', 'Big B', 'Last']);
    assert.match(ticket(1), /## Carried-in work[\s\S]*Big must log\./);
    assert.doesNotMatch(ticket(2), /Carried-in work/);
    assert.match(ticket(3), /## Carried-in work[\s\S]*Last must log\./);
  });
});
