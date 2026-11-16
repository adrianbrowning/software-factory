import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun, ticketPath, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { carryObservations, fixObservations } from '../src/observations.ts';
import { addFollowUp, nextAction, nextSlice } from '../src/workflow.ts';
import { commit, finding, green, greenWithObservation, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: fixes and carried observations', { concurrency: 4 }, () => {
  it('fixes observations the user chose from a green review in a tracked round that needs new checks and a new review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy')), /Slice 01 has no green review/);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');

    await assert.rejects(
      step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming', 'bug-made-up'] }, 'tidy')),
      /Not observations of green review 01-r1: bug-made-up\. Its observations: thermo-naming, comments-stale/,
    );
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready', 'a refused call changes nothing');

    const fixed = await step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'The user wants the names fixed now.'));
    assert.equal(fixed.stalled, false);
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /Checks to run before committing: test -f ok/);
    assert.match(fix, /The user wants the names fixed now\./);
    assert.match(fix, /## \[observation\] thermo-naming\n\n- Location: ok:1/);
    assert.doesNotMatch(fix, /comments-stale/);
    const state = readRun(ws, 'demo').slices[0];
    assert.equal(state?.phase, 'fix');
    assert.equal(state?.fixRounds, 1);
    assert.equal(state?.green, undefined);
    assert.match(nextAction(readRun(ws, 'demo')), new RegExp(`fix mode with ${fixed.fixPath}`));
    await assert.rejects(step(ws, run => completeSlice(ws, run)), /no green review yet/);
    await assert.rejects(step(ws, run => fixObservations(ws, run, { observations: ['comments-stale'] }, 'tidy')), /Slice 01 has no green review/);

    commit(ws, 'ok', 'renamed\n');
    await green(ws);
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('counts a fix round for observations toward the fix budget', async () => {
    using ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.ok(!(await step(ws, run => runChecks(ws, run))).passed);
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));

    const fixed = await step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy'));
    assert.equal(fixed.stalled, true);
    assert.equal(readRun(ws, 'demo').slices[0]?.stalled, true);
  });

  it('fixes a bug the user found after a green review in a tracked round that needs new checks and a new review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    const fixed = await step(ws, run => fixObservations(ws, run, { bug: '    at parse (src/p.ts:3): empty input crashes the parser.' }, 'Found while demoing.'));
    assert.equal(fixed.stalled, false);
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## Bug found after green review 01-r1\n\nFound while demoing\.\n\n {4}at parse \(src\/p\.ts:3\): empty input crashes the parser\./, 'the bug text is kept in full');
    assert.doesNotMatch(fix, /thermo-naming/);
    const state = readRun(ws, 'demo').slices[0];
    assert.deepEqual([state?.phase, state?.fixRounds, state?.green], ['fix', 1, undefined]);
    await assert.rejects(step(ws, run => fixObservations(ws, run, { bug: 'Again.' }, 'tidy')), /Slice 01 has no green review/);

    commit(ws, 'ok', 'fixed\n');
    await green(ws);
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('keeps the start of a long bug report in the fix file', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    const bug = `Saving a draft loses the title.\n${'log line\n'.repeat(600)}`;
    const fixed = await step(ws, run => fixObservations(ws, run, { bug }, 'Found while demoing.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /Found while demoing\.\n\nSaving a draft loses the title\./);
    assert.doesNotMatch(fix, /\[truncated\]/);
  });

  it('writes both the bug and the chosen observations into one fix file', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    const fixed = await step(ws, run => fixObservations(ws, run, { bug: 'Empty input crashes.', observations: ['thermo-naming'] }, 'Fix both now.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## Bug found after green review 01-r1\n\nFix both now\.\n\nEmpty input crashes\./);
    assert.match(fix, /## Observations from green review 01-r1 the user chose to fix\n\nFix both now\./);
    assert.match(fix, /## \[observation\] thermo-naming/);
  });

  it('refuses a fix with neither a bug nor observations, and changes nothing', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    for (const request of [{}, { observations: [] }, { bug: '' }]) {
      await assert.rejects(step(ws, run => fixObservations(ws, run, request, 'tidy')), /factory_fix needs a bug, observation ids, or both/);
    }
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
  });

  it('refuses a bug fix on a slice with no green review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixObservations(ws, run, { bug: 'Crash.' }, 'tidy')), /Slice 01 has no green review/);
  });

  it('counts a fix round for a bug toward the fix budget', async () => {
    using ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.ok(!(await step(ws, run => runChecks(ws, run))).passed);
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, []);
    await step(ws, run => recordReview(ws, run));

    const fixed = await step(ws, run => fixObservations(ws, run, { bug: 'Crash.' }, 'tidy'));
    assert.equal(fixed.stalled, true);
    assert.equal(readRun(ws, 'demo').slices[0]?.stalled, true);
  });

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
