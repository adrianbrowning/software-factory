import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations, fixObservations } from '../src/observations.ts';
import { addFollowUp, nextSlice } from '../src/workflow.ts';
import { commit, finding, green, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: observations of done slices', { concurrency: 4 }, () => {
  async function twoGreenSlices(ws: Workspace, completeSecond: boolean) {
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature']), slice('Third', ['Second'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const second = await step(ws, run => startReview(ws, run));
    await review(ws, second.reviewId, [{ ...finding('thermo', 'observation', 'naming'), path: 'second.txt' }]);
    await step(ws, run => recordReview(ws, run));
    if (completeSecond) await step(ws, run => completeSlice(ws, run));
  }

  it('carries the active slice\'s observations when a done slice\'s review lists the same ids', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws, false);
    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: '03' }));
    const run = readRun(ws, 'demo');
    assert.equal(run.slices[2]?.carried.length, 1);
    assert.equal(run.events.some(event => event.kind === 'carry' && event.slice === '02'), true);
    assert.equal(run.events.some(event => event.kind === 'carry' && event.slice === '01'), false);
  });

  it('fixes the active slice\'s observations when a done slice\'s review lists the same ids', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws, false);
    await step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy'));
    const run = readRun(ws, 'demo');
    assert.equal(run.events.some(event => event.kind === 'fix-observations' && event.slice === '02'), true);
    assert.equal(run.events.some(event => event.kind === 'fix-observations' && event.slice === '01'), false);
    assert.equal(run.slices[0]?.status, 'done');
    assert.equal(run.slices[1]?.fixItems.some(item => item.id === 'thermo-naming'), true);
  });

  it('refuses a carry when two done slices list the observation ids, naming both', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws, true);
    await assert.rejects(
      step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' })),
      (error: Error) => {
        assert.match(error.message, /Slices 01, 02 all have green reviews that list these observations.*Build them in a factory_follow_up slice\./);
        assert.doesNotMatch(error.message, /free-text note/);
        return true;
      },
    );
    assert.deepEqual(readRun(ws, 'demo').waiting, []);
    await step(ws, run => addFollowUp(ws, run, { acceptance: ['x'], estimateTokens: 500, seams: ['cli'], title: 'Naming', whatToBuild: 'Fix thermo-naming' }));
    assert.equal(readRun(ws, 'demo').slices.at(-1)?.title, 'Naming');
  });

  it('suggests a free-text note when the active slice is green without the ids and two done slices list them, and a note-only carry then works', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws, true);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'third.txt');
    await green(ws);
    await assert.rejects(
      step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' })),
      /Slices 01, 02 all have green reviews that list these observations.*factory_follow_up slice, or carry the items as a free-text note/,
    );
    await step(ws, run => carryObservations(ws, run, { note: 'Rename things', to: 'end' }));
    const waiting = readRun(ws, 'demo').waiting;
    assert.equal(waiting.length, 1);
    assert.match(waiting[0] ?? '', /Rename things/);
    assert.doesNotMatch(waiting[0] ?? '', /thermo-naming/);
  });

  it('refuses a fix of a done slice\'s observations while a later slice is green, naming the done slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await green(ws);
    await assert.rejects(step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy')), /Slice 01 is done \(green review 01-r1\); factory_complete_slice already ran/);
    assert.equal(readRun(ws, 'demo').slices[1]?.phase, 'ready');
  });
});
