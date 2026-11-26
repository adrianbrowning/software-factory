import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun, ticketPath } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations, leaveObservations } from '../src/observations.ts';
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
    assert.match(ticket, /## Carried-in work\n[\s\S]*### From green review 01-r1 of slice 01 "Feature"\n\nAlso log the parse time\.\n\nCarried keys: \(none\)\n\n### From green review 01-r1 of slice 01 "Feature"\n\n#### \[observation\] thermo-naming\n\n- Location: ok:1/);
    assert.doesNotMatch(ticket, /comments-stale/);
    assert.match(ticket, /## Carried-in work[\s\S]*fixItems of factory_implementer_report as `<key> fixed in <sha>`/);
    assert.ok(ticket.indexOf('## Carried-in work') < ticket.indexOf('## Decisions the user already made'));
    assert.ok(ticket.indexOf('## Decisions the user already made') < ticket.indexOf('## For the advisor'));
    assert.equal(ticket.split('## For the advisor').length, 2);
    const after = readRun(ws, 'demo').slices[0];
    assert.deepEqual({ ...after, unplaced: [] }, { ...before, unplaced: [] }, 'the active slice keeps its green review');
    assert.deepEqual(after?.unplaced.map(entry => entry.finding.id), ['comments-stale'], 'only the carried observation is placed');
    await assert.rejects(step(ws, run => completeSlice(ws, run)), /unplaced observations: comments-stale/);
    await step(ws, run => leaveObservations(ws, run, { observations: ['comments-stale'] }));
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');

    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const { dataFile } = await step(ws, run => startReview(ws, run));
    assert.match(readFileSync(dataFile, 'utf8'), /## Carried-in work[\s\S]*Also log the parse time\.[\s\S]*#### \[observation\] thermo-naming/);
    assert.doesNotMatch(readFileSync(dataFile, 'utf8'), /## For the advisor/);
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

  it('carries the active slice\'s observations to the end of the run, records the carry on that slice, and lets the slice complete', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' }));
    const run = readRun(ws, 'demo');
    assert.equal(run.waiting.length, 1);
    assert.match(run.waiting[0] ?? '', /^### From green review 01-r1 of slice 01 "Feature"\n\n#### \[observation\] thermo-naming/);
    assert.match(run.waiting[0] ?? '', /\n\nCarried keys: `01-r1:thermo-naming`$/);
    assert.match(run.events.at(-1)?.detail ?? '', /01-r1 to the end of the run: thermo-naming/);
    assert.equal(run.events.at(-1)?.slice, '01');
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });
});
