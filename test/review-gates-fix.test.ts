import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { fixObservations } from '../src/observations.ts';
import { nextAction, nextSlice } from '../src/workflow.ts';
import { commit, finding, green, greenWithObservation, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: fixes', { concurrency: 4 }, () => {
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
    assert.match(fix, /Checks that factory_checks runs in full after your commit \(you run only the typecheck and the test files you touched\): test -f ok/);
    assert.doesNotMatch(fix, /Checks to run before committing/);
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
});
