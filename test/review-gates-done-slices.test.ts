import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations, fixAfterGreen, leaveObservations } from '../src/observations.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: the same observation id in a done slice and the active slice', { concurrency: 4 }, () => {
  async function twoGreenSlices(ws: Workspace) {
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature']), slice('Third', ['Second'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => leaveObservations(ws, run, { observations: ['thermo-naming'] }));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const second = await step(ws, run => startReview(ws, run));
    await review(ws, second.reviewId, [{ ...finding('thermo', 'observation', 'naming'), path: 'second.txt' }]);
    await step(ws, run => recordReview(ws, run));
  }

  it('carries the active slice\'s observations when a done slice\'s review lists the same ids', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws);
    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: '03' }));
    const run = readRun(ws, 'demo');
    assert.equal(run.slices[2]?.carried.length, 1);
    assert.equal(run.events.some(event => event.kind === 'carry' && event.slice === '02'), true);
    assert.equal(run.events.some(event => event.kind === 'carry' && event.slice === '01'), false);
  });

  it('fixes the active slice\'s observations when a done slice\'s review lists the same ids', async () => {
    using ws = workspace({ maxRounds: 2 });
    await twoGreenSlices(ws);
    await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming'] }, 'tidy'));
    const run = readRun(ws, 'demo');
    assert.equal(run.events.some(event => event.kind === 'fix-after-green' && event.slice === '02'), true);
    assert.equal(run.events.some(event => event.kind === 'fix-after-green' && event.slice === '01'), false);
    assert.equal(run.slices[0]?.status, 'done');
    assert.equal(run.slices[1]?.fixItems.some(item => item.id === 'thermo-naming'), true);
  });
});
