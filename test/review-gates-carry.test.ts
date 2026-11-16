import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun, ticketPath } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations, fixObservations } from '../src/observations.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, green, greenWithObservation, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: carried observations', { concurrency: 4 }, () => {
  it('carries chosen observations and a note into a pending slice ticket, which its review data file shows, and leaves the active slice green', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    const before = readRun(ws, 'demo').slices[0];

    await step(ws, run => carryObservations(ws, run, { note: 'Also log the parse time.', observations: ['thermo-naming'], to: '02' }));
    const second = readRun(ws, 'demo').slices[1];
    assert.ok(second !== undefined);
    const ticket = readFileSync(ticketPath(ws, 'demo', second), 'utf8');
    assert.match(ticket, /## Carried-in work\n[\s\S]*### From green review 01-r1 of slice 01 "Feature"\n\nAlso log the parse time\.\n\n#### \[observation\] thermo-naming\n\n- Location: ok:1/);
    assert.doesNotMatch(ticket, /comments-stale/);
    assert.deepEqual(readRun(ws, 'demo').slices[0], before, 'the active slice keeps its green review');
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');

    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const { dataFile } = await step(ws, run => startReview(ws, run));
    assert.match(readFileSync(dataFile, 'utf8'), /## Carried-in work[\s\S]*Also log the parse time\.[\s\S]*#### \[observation\] thermo-naming/);
  });

  it('refuses a carry with nothing to carry, without a green review, with unknown observation ids, or to a slice that is not pending', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature']), slice('Third', ['Second'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => carryObservations(ws, run, { note: 'Later.', to: '02' })), /Slice 01 has no green review to carry observations or a note from/);
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [{ ...finding('thermo', 'observation', 'naming'), path: 'second.txt' }]);
    await step(ws, run => recordReview(ws, run));
    const before = readRun(ws, 'demo');

    for (const request of [{ to: '03' }, { note: ' ', observations: [], to: '03' }]) {
      await assert.rejects(step(ws, run => carryObservations(ws, run, request)), /factory_carry needs observation ids, a note, or both/);
    }
    await assert.rejects(
      step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming', 'bug-made-up'], to: '03' })),
      /Not observations of green review 02-r1: bug-made-up\. Its observations: thermo-naming/,
    );
    await assert.rejects(step(ws, run => carryObservations(ws, run, { note: 'Later.', to: '01' })), /Slice 01 is done; factory_carry takes a pending slice/);
    await assert.rejects(step(ws, run => carryObservations(ws, run, { note: 'Later.', to: '02' })), /Slice 02 is active; factory_carry takes a pending slice/);
    await assert.rejects(step(ws, run => carryObservations(ws, run, { note: 'Later.', to: '09' })), /No slice 09\. Slices: 01, 02, 03/);
    assert.deepEqual(readRun(ws, 'demo').slices, before.slices, 'a refused carry changes nothing');
  });

  it('carries observations of a done slice to the end of the run and records the carry on that slice, with no active slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    await step(ws, run => completeSlice(ws, run));

    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' }));
    const run = readRun(ws, 'demo');
    assert.equal(run.waiting.length, 1);
    assert.match(run.waiting[0] ?? '', /^### From green review 01-r1 of slice 01 "Feature"\n\n#### \[observation\] thermo-naming/);
    assert.match(run.events.at(-1)?.detail ?? '', /01-r1 to the end of the run: thermo-naming/);
    assert.equal(run.events.at(-1)?.slice, '01');
  });

  it('carries observations of a done slice into a pending slice while the next slice is already active', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature']), slice('Third', ['Second'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    const before = readRun(ws, 'demo');

    await assert.rejects(step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming', 'bug-made-up'], to: '03' })), /No green review lists these observations: thermo-naming, bug-made-up\. Done slices checked: 01 \(01-r1\)/);
    await assert.rejects(step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: '02' })), /Slice 02 is active; factory_carry takes a pending slice/);
    assert.deepEqual(readRun(ws, 'demo').slices, before.slices);

    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: '03' }));
    const after = readRun(ws, 'demo');
    assert.match(readFileSync(ticketPath(ws, 'demo', after.slices[2] ?? assert.fail('no slice')), 'utf8'), /### From green review 01-r1 of slice 01 "Feature"[\s\S]*thermo-naming/);
    assert.equal(after.slices[1]?.status, 'active');
  });

  it('refuses observation ids that no done slice lists, with or without an active slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    await step(ws, run => completeSlice(ws, run));
    await assert.rejects(step(ws, run => carryObservations(ws, run, { observations: ['bug-made-up'], to: 'end' })), /No green review lists these observations: bug-made-up\. Done slices checked: 01 \(01-r1\)/);
    await assert.rejects(step(ws, run => carryObservations(ws, run, { note: 'Later.', to: 'end' })), /No active slice/);
    assert.deepEqual(readRun(ws, 'demo').waiting, []);
  });

  it('refuses a fix of observations of a done slice, naming the slice, the review, and the next steps', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    await step(ws, run => completeSlice(ws, run));
    const message = /Slice 01 is done \(green review 01-r1\); factory_complete_slice already ran\. .*factory_reopen.*factory_follow_up/;
    await assert.rejects(step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy')), message);
    assert.equal(readRun(ws, 'demo').slices[0]?.status, 'done');
  });
});
