import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { forgetRun, readRun, statePath } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { fixAfterGreen } from '../src/observations.ts';
import { nextAction, nextSlice, resolveStall } from '../src/workflow.ts';
import { settleObservations, commit, finding, green, greenWithObservation, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: fixes', { concurrency: 4 }, () => {
  it('shows an observation with a symbol as symbol (path:line) in the fix file and one without as path:line', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [{ ...finding('thermo', 'observation', 'naming'), symbol: 'the factory_carry handler' }, finding('comments', 'observation', 'stale')]);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming', 'comments-stale'] }, 'tidy'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## \[observation\] thermo-naming\n\n- Location: the factory_carry handler \(ok:1\)\n/);
    assert.match(fix, /## \[observation\] comments-stale\n\n- Location: ok:1\n/);
    const ledger = readRun(ws, 'demo').observations.find(entry => entry.id === 'thermo-naming');
    assert.equal(ledger?.location, 'the factory_carry handler (ok:1)');
  });

  it('fixes observations the user chose from a green review in a tracked round that needs new checks and a new review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming'] }, 'tidy')), /Slice 01 has no green review/);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');

    await assert.rejects(
      step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming', 'bug-made-up'] }, 'tidy')),
      /Not observations of green review 01-r1: bug-made-up\. Its observations: thermo-naming, comments-stale/,
    );
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready', 'a refused call changes nothing');

    const fixed = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming'] }, 'The user wants the names fixed now.'));
    assert.equal(fixed.stalled, false);
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /Checks that factory_checks runs in full after your commit \(you run only the typecheck, the test files you touched and the test files that assert on output you changed\): test -f ok/);
    assert.doesNotMatch(fix, /Checks to run before committing/);
    assert.match(fix, /The user wants the names fixed now\./);
    assert.match(fix, /## \[observation\] thermo-naming\n\n- Location: ok:1/);
    assert.doesNotMatch(fix, /comments-stale/);
    const state = readRun(ws, 'demo').slices[0];
    assert.equal(state?.phase, 'fix');
    assert.equal(state?.fixRounds, 0);
    assert.equal(state?.green, undefined);
    assert.match(nextAction(readRun(ws, 'demo')), new RegExp(`fix mode with ${fixed.fixPath}`));
    await assert.rejects(step(ws, run => completeSlice(ws, run)), /no green review yet/);
    await assert.rejects(step(ws, run => fixAfterGreen(ws, run, { observations: ['comments-stale'] }, 'tidy')), /Slice 01 has no green review/);

    commit(ws, 'ok', 'renamed\n');
    await green(ws);
    await settleObservations(ws);
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('does not count a fix round for observations toward the fix budget, even at the round limit', async () => {
    using ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.ok(!(await step(ws, run => runChecks(ws, run))).passed);
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    await step(ws, run => recordReview(ws, run));

    const fixed = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-naming'] }, 'tidy'));
    assert.equal(fixed.stalled, false);
    const state = readRun(ws, 'demo').slices[0];
    assert.deepEqual([state?.stalled, state?.fixRounds, state?.phase], [false, 1, 'fix']);

    commit(ws, 'ok', 'renamed\n');
    await step(ws, run => runChecks(ws, run));
    const reopened = await step(ws, run => startReview(ws, run));
    await review(ws, reopened.reviewId, [finding('thermo', 'observation', 'again')]);
    await step(ws, run => recordReview(ws, run));
    const again = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-again'] }, 'tidy'));
    assert.equal(again.stalled, false);
    assert.notEqual(again.fixPath, fixed.fixPath, 'a second observation round does not overwrite the first fix file');
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 1);
  });

  it('numbers fix files from a per-slice counter: two observation rounds then a bug round are f1, f2, f3 and only the bug round counts', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const paths: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      const opened = await step(ws, run => startReview(ws, run));
      await review(ws, opened.reviewId, [finding('thermo', 'observation', name)]);
      await step(ws, run => recordReview(ws, run));
      const round = await step(ws, run => fixAfterGreen(ws, run, name === 'three' ? { bug: 'Crash.', observations: ['thermo-three'] } : { observations: [`thermo-${name}`] }, 'tidy'));
      paths.push(round.fixPath);
      commit(ws, 'ok', `${name}\n`);
      await step(ws, run => runChecks(ws, run));
    }
    assert.deepEqual(paths.map(path => path.slice(path.lastIndexOf('/') + 1)), ['01-f1.md', '01-f2.md', '01-f3.md']);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 1);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixFiles, 3);
    const path = statePath(ws, 'demo');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.slices[0].fixFiles;
    writeFileSync(path, JSON.stringify(saved));
    forgetRun(ws, 'demo');
    assert.equal(readRun(ws, 'demo').slices[0]?.fixFiles, 3, 'a slice saved without the counter starts from the retained fix file number, which is ahead of fixRounds');
  });

  it('numbers the fix file after a resumed stall past the stalled round in a state saved without the counter', async () => {
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
    const stalled = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Crash.', observations: ['thermo-naming'] }, 'tidy'));
    assert.equal(stalled.stalled, true);
    const path = statePath(ws, 'demo');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.slices[0].fixFiles;
    writeFileSync(path, JSON.stringify(saved));
    forgetRun(ws, 'demo');

    await step(ws, run => resolveStall(ws, run, 'continue'));
    commit(ws, 'ok', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const again = await step(ws, run => startReview(ws, run));
    await review(ws, again.reviewId, [finding('thermo', 'observation', 'again')]);
    await step(ws, run => recordReview(ws, run));
    const next = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Again.' }, 'tidy'));
    assert.match(next.fixPath, /01-f3\.md$/);
    assert.notEqual(next.fixPath, stalled.fixPath);
    assert.match(readFileSync(stalled.fixPath, 'utf8'), /Crash\./, 'the stalled round file is intact');
  });

  it('counts a fix round for a bug together with observations and stalls at the limit', async () => {
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

    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Crash.', observations: ['thermo-naming'] }, 'tidy'));
    assert.equal(fixed.stalled, true);
    assert.equal(readRun(ws, 'demo').slices[0]?.stalled, true);
  });

  it('fixes a bug the user found after a green review in a tracked round that needs new checks and a new review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug: '    at parse (src/p.ts:3): empty input crashes the parser.' }, 'Found while demoing.'));
    assert.equal(fixed.stalled, false);
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## Bug found after green review 01-r1\n\nFound while demoing\.\n\n {4}at parse \(src\/p\.ts:3\): empty input crashes the parser\./, 'the bug text is kept in full');
    assert.doesNotMatch(fix, /thermo-naming/);
    const state = readRun(ws, 'demo').slices[0];
    assert.deepEqual([state?.phase, state?.fixRounds, state?.green], ['fix', 1, undefined]);
    await assert.rejects(step(ws, run => fixAfterGreen(ws, run, { bug: 'Again.' }, 'tidy')), /Slice 01 has no green review/);

    commit(ws, 'ok', 'fixed\n');
    await green(ws);
    await settleObservations(ws);
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('keeps the whole long bug report in the fix file', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    const bug = `Saving a draft loses the title.\n${'log line\n'.repeat(600)}END-OF-BUG`;
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug }, 'Found while demoing.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /Found while demoing\.\n\nSaving a draft loses the title\./);
    assert.equal(fix.match(/^log line$/gm)?.length, 600);
    assert.ok(fix.indexOf('END-OF-BUG') > fix.lastIndexOf('log line'), 'the end marker follows the last log line');
    assert.doesNotMatch(fix, /\[truncated\]/);
  });

  it('redacts a credential in the bug text before it reaches the fix file', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Fails on https://user:secret@example.com/x' }, 'Found while demoing.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /https:\/\/<REDACTED>@example\.com\/x/);
    assert.doesNotMatch(fix, /secret/);
  });

  it('writes both the bug and the chosen observations into one fix file', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Empty input crashes.', observations: ['thermo-naming'] }, 'Fix both now.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## Bug found after green review 01-r1\n\nFix both now\.\n\nEmpty input crashes\./);
    assert.match(fix, /## Observations from green review 01-r1 the user chose to fix\n\nFix both now\./);
    assert.match(fix, /## \[observation\] thermo-naming/);
  });

  it('refuses a fix with neither a bug nor observations, and changes nothing', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    for (const request of [{}, { observations: [] }, { bug: '' }, { bug: '  \n ' }]) {
      await assert.rejects(step(ws, run => fixAfterGreen(ws, run, request, 'tidy')), /factory_fix needs a bug, observation ids, or both/);
    }
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
  });

  it('refuses a bug fix on a slice with no green review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixAfterGreen(ws, run, { bug: 'Crash.' }, 'tidy')), /Slice 01 has no green review/);
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

    const fixed = await step(ws, run => fixAfterGreen(ws, run, { bug: 'Crash.' }, 'tidy'));
    assert.equal(fixed.stalled, true);
    assert.equal(readRun(ws, 'demo').slices[0]?.stalled, true);
  });
});
