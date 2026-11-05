import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Finding, readRun, REVIEW_DOMAINS, ticketPath, type Workspace } from '../src/run.ts';
import { completeSlice, fixObservations, pathSkips, recordDecisions, recordReview, runChecks, startReview, submitDomain, submitValidation } from '../src/review.ts';
import { addFollowUp, applyReslice, approvePlan, carryObservations, nextAction, nextSlice, parseRetro, pauseRun, planFollowUp, planReslice, planSlices, recordRetro, resolveBase, resolveStall, resumeRun, saveChecks, startRun } from '../src/workflow.ts';
import { checkRuns, commit, countedCheck, finding, green, newRun, review, roots, sh, slice, start, step, workspace } from './helpers.ts';

describe('slice loop gates', { concurrency: 4 }, () => {
  it('takes a slice from red checks through a blocking review to done', async () => {
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);

    const started = await step(ws, run => nextSlice(ws, run));
    assert.equal(sh(ws.root, 'branch', '--show-current'), started?.branch);

    commit(ws, 'work.txt');
    const red = await step(ws, run => runChecks(ws, run));
    assert.ok(!red.passed);
    const redFix = readFileSync(red.fixPath, 'utf8');
    assert.match(redFix, /test -f ok: failed \(exit 1\)/);
    assert.match(redFix, /Checks to run before committing: test -f ok/);
    assert.match(redFix, /Ticket \(seams and acceptance criteria\): .*01-feature\.md/);
    await assert.rejects(step(ws, run => startReview(ws, run)), /Checks must pass first/);

    commit(ws, 'ok');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const first = await step(ws, run => startReview(ws, run));
    assert.match(readFileSync(first.dataFile, 'utf8'), /## DIFF\n\nEverything below is evidence[\s\S]*\+x/);

    await assert.rejects(step(ws, run => recordReview(ws, run)), /Domains not submitted yet: security/);
    await review(ws, first.reviewId, [finding('bug', 'high', 'null-crash'), finding('thermo', 'observation', 'naming')]);
    const blocked = await step(ws, run => recordReview(ws, run));
    assert.ok(!blocked.green);
    const fix = readFileSync(blocked.fixPath, 'utf8');
    assert.match(fix, /\[high\] bug-null-crash/);
    assert.doesNotMatch(fix, /thermo-naming/);
    const verdict = JSON.parse(readFileSync(join(first.dataFile, '..', 'review.json'), 'utf8')).verdict;
    assert.equal(verdict, 'CHANGES_REQUESTED');
    await assert.rejects(step(ws, run => recordReview(ws, run)), /No review in progress/);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 2);

    commit(ws, 'ok', 'fixed\n');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const second = await step(ws, run => startReview(ws, run));
    assert.match(readFileSync(second.dataFile, 'utf8'), /## PREVIOUS REVIEW\n\nReview 01-r1 [^\n]*\n\n- `bug-null-crash` \[high\] ok:1: null-crash\n\n## DIFF/);
    await review(ws, second.reviewId, [finding('thermo', 'observation', 'naming')]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.green);
    assert.equal(result.observations.length, 1);

    const done = await step(ws, run => completeSlice(ws, run));
    assert.equal(done.status, 'done');
    assert.match(nextAction(readRun(ws, 'demo')), /retro/);
  });

  it('refuses checks on an empty slice and flags a fix round that committed nothing', async () => {
    const ws = workspace({ maxRounds: 5 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    await assert.rejects(step(ws, run => runChecks(ws, run)), /Slice 01 has no commits past main/);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0);

    commit(ws, 'work.txt');
    const red = await step(ws, run => runChecks(ws, run));
    assert.deepEqual([red.passed, red.unchanged], [false, false]);
    const stillRed = await step(ws, run => runChecks(ws, run));
    assert.deepEqual([stillRed.passed, stillRed.unchanged], [false, true]);

    commit(ws, 'ok');
    const fixed = await step(ws, run => runChecks(ws, run));
    assert.deepEqual([fixed.passed, fixed.unchanged], [true, false]);
    const { reviewId } = await step(ws, run => startReview(ws, run));
    await review(ws, reviewId, [finding('bug', 'high', 'null-crash')]);
    assert.ok(!(await step(ws, run => recordReview(ws, run))).green);
    const afterReview = await step(ws, run => runChecks(ws, run));
    assert.deepEqual([afterReview.passed, afterReview.unchanged], [true, true]);
  });

  it('starts each later slice from the slice below it and reviews only its own diff', async () => {
    const ws = workspace();
    await newRun(ws, [slice('First'), slice('Second', ['First'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    commit(ws, 'first.txt');
    await green(ws);
    const first = await step(ws, run => completeSlice(ws, run));

    await step(ws, run => nextSlice(ws, run));
    execFileSync('git', ['merge-base', '--is-ancestor', first.branch, 'HEAD'], { cwd: ws.root });
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const { dataFile } = await step(ws, run => startReview(ws, run));
    const data = readFileSync(dataFile, 'utf8');
    assert.match(data, /second\.txt/);
    assert.doesNotMatch(data, /first\.txt/);
  });

  it('stacks slice 01 on the pinned commit of a user-chosen base branch', async () => {
    const ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-950');
    commit(ws, 'ext.txt');
    const pinned = sh(ws.root, 'rev-parse', 'HEAD');
    sh(ws.root, 'switch', '-q', 'main');
    await start(ws);
    const base = await resolveBase(ws, { baseRef: 'ext-950' });
    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')], base), base));

    sh(ws.root, 'switch', '-q', 'ext-950');
    commit(ws, 'later.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await step(ws, run => nextSlice(ws, run));
    assert.equal(sh(ws.root, 'rev-parse', 'HEAD'), pinned, 'later commits on the base branch stay out');
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const { dataFile } = await step(ws, run => startReview(ws, run));
    const data = readFileSync(dataFile, 'utf8');
    assert.match(data, /\+\+\+ b\/ok/);
    assert.doesNotMatch(data, /ext\.txt|later\.txt/);
    assert.equal(readRun(ws, 'demo').trunk, 'ext-950');
  });

  it('refuses checks on a slice that fast-forwarded onto another branch', async () => {
    const ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-950');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    sh(ws.root, 'merge', '-q', '--ff-only', 'ext-950');
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => runChecks(ws, run)), /holds 1 commits from other branches[\s\S]*add ext\.txt/);
  });

  it('lists the slice commits and changed files in the checks result and the numbered user decisions in the review data', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => recordDecisions(ws, run, ['The tsx runner stays; replacing it is out of scope.']));
    const checks = await step(ws, run => runChecks(ws, run));
    assert.ok(checks.passed);
    assert.match(checks.commits, /add ok/);
    assert.match(checks.changed, /ok \| 1 \+\n 1 file changed, 1 insertion/);
    const { dataFile } = await step(ws, run => startReview(ws, run));
    const data = readFileSync(dataFile, 'utf8');
    assert.match(data, /## Decisions the user already made\n\n1\. The tsx runner stays/);
    assert.match(data, /## CHECKS\n\n.*all passed\. Do not run them again\.\n\n- test -f ok: passed in \d+ms\n/);
  });

  it('drops the stored check results whenever the checked commit stops being current', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const results = () => readRun(ws, 'demo').slices[0]?.checked?.results;
    await step(ws, run => runChecks(ws, run));
    assert.match(results()?.join() ?? '', /test -f ok: passed/);
    commit(ws, 'later.txt');
    await assert.rejects(step(ws, run => startReview(ws, run)), /HEAD moved/);
    assert.equal(results(), undefined);

    await step(ws, run => runChecks(ws, run));
    sh(ws.root, 'rm', '-q', 'ok');
    sh(ws.root, 'commit', '-qm', 'drop ok');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    assert.equal(results(), undefined);
  });

  it('reuses the passing checks of the current commit without running a check command, and leaves the slice in review', async () => {
    using ws = workspace({ checks: [countedCheck('run', 'test -f ok')] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const first = await step(ws, run => runChecks(ws, run));
    const stored = readRun(ws, 'demo').slices[0]?.checked;
    const again = await step(ws, run => runChecks(ws, run));
    assert.ok(again.passed);
    assert.deepEqual(checkRuns(ws), ['run']);
    assert.deepEqual(again.summary, first.summary);
    assert.equal(again.reused, true);
    assert.equal(again.sha, sh(ws.root, 'rev-parse', 'HEAD'));
    const after = readRun(ws, 'demo').slices[0];
    assert.deepEqual([after?.phase, after?.checked], ['review', stored]);
    assert.equal(stored?.sha, again.sha);
    assert.ok(first.passed && !first.reused);
  });

  it('reuses the checks of a green slice on its green commit, and sends it back to review', async () => {
    using ws = workspace({ checks: [countedCheck('run', 'test -f ok')] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
    const again = await step(ws, run => runChecks(ws, run));
    assert.ok(again.passed);
    assert.equal(again.reused, true);
    assert.equal(again.sha, sh(ws.root, 'rev-parse', 'HEAD'));
    assert.deepEqual(checkRuns(ws), ['run']);
    const reviewing = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reviewing?.phase, reviewing?.checked?.sha, reviewing?.green], ['review', again.sha, undefined]);
  });

  it('runs every check again after a new commit, and after a fix round on the same commit', async () => {
    using ws = workspace({ checks: [countedCheck('run', 'test -f ok'), 'test -f ok'], maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    commit(ws, 'later.txt');
    const moved = await step(ws, run => runChecks(ws, run));
    assert.ok(moved.passed && !moved.reused);
    assert.deepEqual(checkRuns(ws), ['run', 'run']);

    const { reviewId } = await step(ws, run => startReview(ws, run));
    await review(ws, reviewId, [finding('bug', 'high', 'null-crash')]);
    assert.ok(!(await step(ws, run => recordReview(ws, run))).green);
    const fixing = readRun(ws, 'demo').slices[0];
    assert.deepEqual([fixing?.phase, fixing?.checked], ['fix', undefined]);
    const fixed = await step(ws, run => runChecks(ws, run));
    assert.ok(fixed.passed && !fixed.reused);
    assert.deepEqual(checkRuns(ws), ['run', 'run', 'run']);
    assert.equal(fixed.summary.length, 2);
  });

  it('fails checks that leave the working tree changed', async () => {
    const ws = workspace({ checks: ['touch ok stray.txt'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.match(readFileSync(result.fixPath, 'utf8'), /Checks changed the working tree[\s\S]*stray\.txt/);
  });

  it('refuses a check whose command is not found as an environment error, not a fix round', async () => {
    const ws = workspace({ checks: ['factory-missing-tool --run'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    await assert.rejects(step(ws, run => runChecks(ws, run)), /factory-missing-tool --run[\s\S]*PATH used:[\s\S]*environment error[\s\S]*checkPath/);
    const after = readRun(ws, 'demo').slices[0];
    assert.equal(after?.fixRounds, 0);
    assert.equal(after?.phase, 'implement');
    assert.equal(after?.fixPath, undefined);
    assert.equal(existsSync(join(ws.root, '.scratch', 'demo', 'fixes')), false);

    const bin = mkdtempSync(join(tmpdir(), 'factory-bin-'));
    roots.push(bin);
    writeFileSync(join(bin, 'factory-missing-tool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'factory-missing-tool'), 0o755);
    ws.config.checkPath = [bin];
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
  });

  it('refuses a wrapped command-not-found that exits with another code, in bash and dash wording', async () => {
    for (const line of ['sh: pnpm: command not found', 'sh: 1: pnpm: not found', '/bin/sh: line 1: pnpm: command not found']) {
      const ws = workspace({ checks: [`printf '%s\\n' '${line}' >&2; exit 1`] });
      await newRun(ws, [slice('Feature')]);
      await step(ws, run => nextSlice(ws, run));
      commit(ws, 'work.txt');
      await assert.rejects(step(ws, run => runChecks(ws, run)), /environment error[\s\S]*command -v pnpm[\s\S]*install the dependencies/, line);
      assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0, line);
    }
  });

  it('counts an ordinary failure that mentions "not found" as a fix round', async () => {
    const ws = workspace({ checks: [`printf 'error: module not found\\n' >&2; exit 1`] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 1);
  });

  it('reports a check that runs past its timeout', async () => {
    const ws = workspace({ checks: ['sleep 5'], checkTimeoutMs: 100 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.match(readFileSync(result.fixPath, 'utf8'), /sleep 5: timed out/);
  });

  it('gates a run on the checks it started with; changed saved checks reach new runs only', async () => {
    const ws = workspace({ checks: undefined });
    await assert.rejects(start(ws), /Choose at least one check command/);
    await saveChecks(ws, ['test -f ok']);
    assert.equal(sh(ws.root, 'status', '--porcelain'), '');
    await newRun(ws, [slice('Feature')]);
    await saveChecks(ws, ['false']);
    await startRun(ws, { feature: 'later', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    assert.deepEqual(readRun(ws, 'later').checks, ['false']);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
  });

  it('stalls when the fix budget is used, and each continue grants maxRounds more fixes', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');

    const failChecks = () => step(ws, run => runChecks(ws, run));
    assert.ok(!(await failChecks()).passed);
    const stalled = await failChecks();
    assert.ok(!stalled.passed && stalled.stalled);
    await assert.rejects(failChecks(), /fix budget of slice 01 "Feature" is used up/);

    await step(ws, run => resolveStall(ws, run, 'pause'));
    assert.equal(readRun(ws, 'demo').status, 'stalled');
    await step(ws, run => resolveStall(ws, run, 'continue'));
    assert.equal(readRun(ws, 'demo').status, 'running');
    const again = await failChecks();
    assert.ok(!again.passed && again.stalled, 'the continue round is used by the first failure after it');
  });

  it('tells the user a stalled run asks on resume whether to raise the used-up fix budget', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => resolveStall(ws, run, 'pause'));
    const next = nextAction(readRun(ws, 'demo'));
    assert.match(next, /fix budget of slice 01 "Feature" is used up/);
    assert.match(next, /\/factory resume demo asks whether to raise it/);
    assert.doesNotMatch(next, /The run is stalled/);
    const notice = /fix budget of slice 01 "Feature" is used up.*\/factory resume demo asks whether to raise it/;
    await assert.rejects(step(ws, run => runChecks(ws, run)), notice);
  });

  it('refuses a follow-up slice with the stall notice, on an interrupted stall and on a paused one', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => runChecks(ws, run));
    const followUp = () => step(ws, run => planFollowUp(ws, run, { acceptance: ['x'], estimateTokens: 500, seams: ['cli'], title: 'More', whatToBuild: 'More' }));
    const notice = /fix budget of slice 01 "Feature" is used up.*\/factory resume demo asks whether to raise it/;
    assert.equal(readRun(ws, 'demo').status, 'running');
    await assert.rejects(followUp(), notice);
    await step(ws, run => resolveStall(ws, run, 'pause'));
    await assert.rejects(followUp(), notice);
  });

  it('keeps the plain resume wording for a paused run that is not stalled', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => pauseRun(run, 'test'));
    assert.equal(nextAction(readRun(ws, 'demo')), 'The run is paused. The user resumes it with /factory resume demo.');
  });

  it('raises the budget by maxRounds, not by the used rounds, when a stalled run resumes', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    for (let i = 0; i < 2; i += 1) await step(ws, run => runChecks(ws, run));
    await step(ws, run => resolveStall(ws, run, 'continue'));
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => resolveStall(ws, run, 'pause'));
    assert.equal(readRun(ws, 'demo').slices[0]?.roundLimit, 2);
    await step(ws, run => resumeRun(ws, run, 'session-2'));
    const run = readRun(ws, 'demo');
    assert.deepEqual([run.status, run.slices[0]?.stalled, run.slices[0]?.roundLimit], ['running', false, 3]);
  });

  it('invalidates a review when the working tree or HEAD changes during it', async () => {
    for (const change of ['untracked', 'commit'] as const) {
      const ws = workspace();
      await newRun(ws, [slice('Feature')]);
      await step(ws, run => nextSlice(ws, run));
      commit(ws, 'ok');
      await step(ws, run => runChecks(ws, run));
      const opened = await step(ws, run => startReview(ws, run));
      await review(ws, opened.reviewId, []);

      if (change === 'untracked') writeFileSync(join(ws.root, 'stray.txt'), 'reviewer edit\n');
      else commit(ws, 'reviewer.txt');
      await assert.rejects(step(ws, run => recordReview(ws, run)), /changed during review/);
      const invalidated = readRun(ws, 'demo').slices[0];
      assert.equal(invalidated?.phase, 'checks', change);
      assert.equal(invalidated?.checked, undefined, change);
    }
  });

  it('refuses to complete a slice whose HEAD moved after the green review, and requires new checks', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);

    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => completeSlice(ws, run)), /HEAD moved after the green review/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks');
  });

  it('discards an open review when a decision lands during it, and reopens review on the same commit', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const checked = readRun(ws, 'demo').slices[0]?.checked?.sha;
    const opened = await step(ws, run => startReview(ws, run));
    await step(ws, run => submitDomain(ws, run, { agentId: 'r-bug', domain: 'bug', findings: [], reviewId: opened.reviewId }));

    const recorded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(recorded.discarded, opened.reviewId);
    const invalidated = readRun(ws, 'demo');
    assert.equal(invalidated.slices[0]?.phase, 'review');
    assert.equal(invalidated.slices[0]?.review, undefined);
    assert.equal(invalidated.slices[0]?.checked?.sha, checked);
    assert.match(invalidated.events.at(-1)?.detail ?? '', new RegExp(`${opened.reviewId}: decisions recorded during review`));
    assert.equal(invalidated.events.at(-1)?.kind, 'review-invalidated');
    assert.match(nextAction(invalidated), /factory_review_start/);

    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r-scope', domain: 'scope', findings: [], reviewId: opened.reviewId })),
      /is not the active review/,
    );
    await assert.rejects(
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep: [], reviewId: opened.reviewId })),
      /is not the active review/,
    );
    await assert.rejects(step(ws, run => recordReview(ws, run)), /No review in progress/);

    const again = await step(ws, run => startReview(ws, run));
    assert.notEqual(again.reviewId, opened.reviewId);
    assert.equal(readRun(ws, 'demo').slices[0]?.review?.decisions, 1);
    assert.match(readFileSync(again.dataFile, 'utf8'), /Late decision\./);
    await review(ws, again.reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).green, true);
  });

  it('keeps the last recorded blocking findings in the next review after a decision discards the review in between', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('bug', 'high', 'null-crash')]);
    assert.ok(!(await step(ws, run => recordReview(ws, run))).green);

    commit(ws, 'ok', 'fixed\n');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const second = await step(ws, run => startReview(ws, run));
    const discarded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(discarded.discarded, second.reviewId);

    const third = await step(ws, run => startReview(ws, run));
    assert.equal(third.reviewId, '01-r3');
    assert.match(readFileSync(third.dataFile, 'utf8'), /## PREVIOUS REVIEW\n\nReview 01-r1 [^\n]*\n\n- `bug-null-crash` \[high\] ok:1: null-crash\n\n## DIFF/);
  });

  it('refuses to complete a slice when a decision lands after its green review, until a new review goes green', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => recordDecisions(ws, run, ['Late decision.']));

    await assert.rejects(step(ws, run => completeSlice(ws, run)), /no green review yet/);
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, []);
    await step(ws, run => recordReview(ws, run));
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  /** A state file an older factory wrote: a decision recorded without the decide-time review reset. */
  const olderDecision = (ws: Workspace) => step(ws, run => void run.decisions.push('Decision an older factory recorded.'));

  it('reopens review on the green commit at completion when an older state file holds a decision newer than the green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    const greenSha = readRun(ws, 'demo').slices[0]?.checked?.sha;
    await olderDecision(ws);
    assert.match(nextAction(readRun(ws, 'demo')), /factory_review_start/);

    await assert.rejects(step(ws, run => completeSlice(ws, run)), /Decision 1 is newer than the green review/);
    const reopened = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reopened?.phase, reopened?.checked?.sha, reopened?.review], ['review', greenSha, undefined]);
  });

  it('opens a new review of the green commit without checks when an older state file holds a decision newer than the green review', async () => {
    const again = workspace();
    await newRun(again, [slice('Feature')]);
    await step(again, run => nextSlice(again, run));
    commit(again, 'ok');
    await green(again);
    const greenState = readRun(again, 'demo');
    const checked = greenState.slices[0]?.checked?.sha;
    const greenId = `${greenState.slices[0]?.id}-r${greenState.slices[0]?.reviews}`;
    const checkRuns = greenState.events.filter(event => event.kind.startsWith('checks')).length;
    await olderDecision(again);
    const opened = await step(again, run => startReview(again, run));
    const started = readRun(again, 'demo');
    const state = started.slices[0];
    assert.deepEqual([state?.phase, state?.checked?.sha, state?.review?.id, state?.review?.decisions], ['review', checked, opened.reviewId, 1]);
    assert.notEqual(opened.reviewId, greenId);
    assert.match(readFileSync(opened.dataFile, 'utf8'), /Decision an older factory recorded\./);
    assert.equal(started.events.filter(event => event.kind.startsWith('checks')).length, checkRuns);
  });

  it('discards a review at record time when an older state file holds a decision newer than it', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, []);
    await olderDecision(ws);

    await assert.rejects(step(ws, run => recordReview(ws, run)), /Decision 1 is newer than review/);
    const state = readRun(ws, 'demo');
    assert.equal(state.slices[0]?.review, undefined);
    assert.equal(state.slices[0]?.phase, 'review');
    assert.equal(state.events.at(-1)?.kind, 'review-invalidated');
  });

  it('opens a new review on the green commit without checks when a decision lands after the green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => recordDecisions(ws, run, ['Early decision.']));
    await green(ws);
    const first = readRun(ws, 'demo').slices[0];
    const greenId = `${first?.id}-r${first?.reviews}`;
    const greenSha = first?.checked?.sha;
    assert.equal(first?.phase, 'ready');
    assert.ok(greenSha && first?.green);
    const checkRuns = readRun(ws, 'demo').events.filter(event => event.kind.startsWith('checks')).length;
    const recorded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(recorded.discarded, undefined, 'no review is running, so no reviewer needs stopping');
    const reopened = readRun(ws, 'demo');
    assert.equal(reopened.slices[0]?.phase, 'review');
    assert.equal(reopened.slices[0]?.checked?.sha, greenSha);
    assert.equal(reopened.slices[0]?.green, undefined);
    assert.equal(reopened.slices[0]?.review, undefined);
    assert.equal(reopened.events.at(-1)?.kind, 'review-invalidated');
    assert.match(nextAction(reopened), /factory_review_start/);

    const opened = await step(ws, run => startReview(ws, run));
    const state = readRun(ws, 'demo');
    assert.notEqual(opened.reviewId, greenId);
    assert.equal(state.slices[0]?.phase, 'review');
    assert.equal(state.slices[0]?.checked?.sha, greenSha);
    assert.equal(state.slices[0]?.green, undefined);
    assert.equal(state.slices[0]?.review?.decisions, 2);
    assert.equal(state.events.filter(event => event.kind.startsWith('checks')).length, checkRuns);
    const data = readFileSync(opened.dataFile, 'utf8');
    assert.match(data, /Early decision\./);
    assert.match(data, /Late decision\./);
    await review(ws, opened.reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).green, true);
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('still refuses a review of a green slice with no newer decision, and sends a moved HEAD back to checks', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await assert.rejects(step(ws, run => startReview(ws, run)), /Checks must pass first/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');

    await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    const reopened = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reopened?.phase, reopened?.green], ['review', undefined]);
    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => startReview(ws, run)), /HEAD moved after checks passed/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks');
  });

  it('sends a ready slice from an older state file back to checks when HEAD moved from the green commit', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await olderDecision(ws);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => startReview(ws, run)), /HEAD moved after checks passed/);
    const reset = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reset?.phase, reset?.checked, reset?.green], ['checks', undefined, undefined]);
  });

  it('leaves the slice untouched when a decision lands with no open or green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const before = readRun(ws, 'demo').slices[0];
    const recorded = await step(ws, run => recordDecisions(ws, run, ['Early decision.']));
    assert.equal(recorded.discarded, undefined);
    assert.deepEqual(readRun(ws, 'demo').slices[0], before);
  });

  it('fixes observations the user chose from a green review in a tracked round that needs new checks and a new review', async () => {
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixObservations(ws, run, { observations: ['thermo-naming'] }, 'tidy')), /Slice 01 has no green review/);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);

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
    const ws = workspace({ maxRounds: 1 });
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

  /** Takes a slice that commits `ok` to a green review with one thermo observation. */
  async function greenWithObservation(ws: Workspace) {
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);
  }

  it('fixes a bug the user found after a green review in a tracked round that needs new checks and a new review', async () => {
    const ws = workspace({ maxRounds: 2 });
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
    const ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);

    const bug = `Saving a draft loses the title.\n${'log line\n'.repeat(600)}`;
    const fixed = await step(ws, run => fixObservations(ws, run, { bug }, 'Found while demoing.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /Found while demoing\.\n\nSaving a draft loses the title\./);
    assert.doesNotMatch(fix, /\[truncated\]/);
  });

  it('writes both the bug and the chosen observations into one fix file', async () => {
    const ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    const fixed = await step(ws, run => fixObservations(ws, run, { bug: 'Empty input crashes.', observations: ['thermo-naming'] }, 'Fix both now.'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fix, /## Bug found after green review 01-r1\n\nFix both now\.\n\nEmpty input crashes\./);
    assert.match(fix, /## Observations from green review 01-r1 the user chose to fix\n\nFix both now\./);
    assert.match(fix, /## \[observation\] thermo-naming/);
  });

  it('refuses a fix with neither a bug nor observations, and changes nothing', async () => {
    const ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    for (const request of [{}, { observations: [] }, { bug: '' }]) {
      await assert.rejects(step(ws, run => fixObservations(ws, run, request, 'tidy')), /factory_fix needs a bug, observation ids, or both/);
    }
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
  });

  it('refuses a bug fix on a slice with no green review', async () => {
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => fixObservations(ws, run, { bug: 'Crash.' }, 'tidy')), /Slice 01 has no green review/);
  });

  it('counts a fix round for a bug toward the fix budget', async () => {
    const ws = workspace({ maxRounds: 1 });
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
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Second', ['Feature'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming'), finding('comments', 'observation', 'stale')]);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);
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
    const ws = workspace({ maxRounds: 2 });
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

  it('queues carried work on the run for the end-of-run follow-up without changing any slice', async () => {
    const ws = workspace({ maxRounds: 2 });
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
    assert.deepEqual(after.slices, before.slices, 'no slice changes');
    assert.equal(after.waiting.length, 1);
    assert.match(after.waiting[0] ?? '', /^### From green review 01-r1 of slice 01 "Feature"\n\nAlso log the parse time\.\n\n#### \[observation\] thermo-naming/);
    await step(ws, run => completeSlice(ws, run));
    assert.equal(nextAction(readRun(ws, 'demo')), 'Call factory_next to start the next slice.', 'a pending slice comes before the follow-up');
  });

  /** A one-slice run whose slice is green with a thermo-naming observation, carried with a note to the end of the run. */
  async function queuedRun() {
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    await step(ws, run => recordReview(ws, run));
    await step(ws, run => carryObservations(ws, run, { note: 'Also log the parse time.', to: 'end' }));
    await step(ws, run => carryObservations(ws, run, { observations: ['thermo-naming'], to: 'end' }));
    return ws;
  }

  const followUp = { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' };

  it('takes every waiting item into the next follow-up slice ticket and empties the queue', async () => {
    const ws = await queuedRun();
    await step(ws, run => completeSlice(ws, run));
    const added = await step(ws, run => addFollowUp(ws, run, followUp));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.waiting, []);
    assert.equal(run.slices[1]?.carried.length, 2);
    const ticket = readFileSync(ticketPath(ws, 'demo', added), 'utf8');
    assert.match(ticket, /## Carried-in work[\s\S]*Also log the parse time\.[\s\S]*#### \[observation\] thermo-naming/);
  });

  it('points nextAction to factory_follow_up only while items wait and no slice is pending', async () => {
    const ws = await queuedRun();
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
    const ws = await queuedRun();
    assert.throws(() => parseRetro(ws, readRun(ws, 'demo'), []), (error: Error) => /Finish the pending slices first/.test(error.message) && !/Call factory_follow_up/.test(error.message));
    await step(ws, run => completeSlice(ws, run));
    assert.throws(() => parseRetro(ws, readRun(ws, 'demo'), []), /Carried items wait for the end of the run \(2\)\. Call factory_follow_up for them/);
    await assert.rejects(step(ws, run => recordRetro(ws, run, { apply: [], file: [], findings: [] })), /Carried items wait for the end of the run \(2\)/);
    await step(ws, run => addFollowUp(ws, run, followUp));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'polish.txt');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    assert.equal(readRun(ws, 'demo').status, 'done');
  });

  it('refuses the retro on a stalled run with waiting items by pointing to /factory resume, not factory_follow_up', async () => {
    const ws = workspace({ maxRounds: 1 });
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
    const ws = await queuedRun();
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => pauseRun(run, 'test'));
    assert.throws(
      () => parseRetro(ws, readRun(ws, 'demo'), []),
      (error: Error) => /Tell the user to \/factory resume demo first/.test(error.message) && !/Call factory_follow_up/.test(error.message),
    );
  });

  it('keeps a run with waiting items from settling after the retro slice', async () => {
    const ws = workspace({ maxRounds: 2 });
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
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature'), slice('Big', ['Feature']), slice('Last', ['Big'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => carryObservations(ws, run, { note: 'Big must log.', to: '02' }));
    await step(ws, run => carryObservations(ws, run, { note: 'Last must log.', to: '03' }));
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));

    await step(ws, async run => applyReslice(ws, run, planReslice(ws, run, [slice('Big A', ['Feature']), slice('Big B', ['Big A'])]).slices));
    const slices = readRun(ws, 'demo').slices;
    const ticket = (index: number) => readFileSync(ticketPath(ws, 'demo', slices[index] ?? assert.fail('no slice')), 'utf8');
    assert.deepEqual(slices.map(item => item.title), ['Feature', 'Big A', 'Big B', 'Last']);
    assert.match(ticket(1), /## Carried-in work[\s\S]*Big must log\./);
    assert.doesNotMatch(ticket(2), /Carried-in work/);
    assert.match(ticket(3), /## Carried-in work[\s\S]*Last must log\./);
  });
});

describe('review submissions', { concurrency: 4 }, () => {
  /** Opens a review of a slice that commits `ok`. By default it keeps the path-ruled domains, so every domain reviews. */
  async function openReview(
    decisions: string[] = [],
    skip: { domain: Finding['domain']; reason: string }[] = [],
    input = slice('Feature'),
    keep: Finding['domain'][] = (['react-ts', 'test-validity', 'devops'] as const).filter(domain => !skip.some(entry => entry.domain === domain)),
  ) {
    const ws = workspace();
    await newRun(ws, [input]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    if (decisions.length > 0) await step(ws, run => recordDecisions(ws, run, decisions));
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run, skip, keep));
    return { ws, ...opened };
  }

  it('checks domain and id prefix separately, and lets the validator only select', async () => {
    const { reviewId, ws } = await openReview();
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId }));

    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), domain: 'security' }]), /must have domain "bug"/);
    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), id: 'security-x' }]), /id starting "bug-"/);
    for (const domain of REVIEW_DOMAINS) {
      await submit(domain, domain === 'bug' ? [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')] : []);
    }
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'someone-else', domain: 'bug', findings: [], reviewId })),
      /submitted by another agent/,
    );

    const validate = (keep: string[], dropped: { id: string; reason: string }[] = []) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
    await assert.rejects(validate(['bug-a', 'bug-invented']), /Unknown finding ids: bug-invented/);
    await assert.rejects(validate(['bug-a']), /Undecided: bug-b/);
    await validate(['bug-a'], [{ id: 'bug-b', reason: 'not in diff' }]);

    const result = await step(ws, run => recordReview(ws, run));
    assert.equal(result.green ? 0 : result.blocking, 1);
  });

  it('lets a reviewer replace its findings any number of times until validation', async () => {
    const { findingsDir, reviewId, ws } = await openReview();
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId }));
    for (const domain of REVIEW_DOMAINS) await submit(domain, []);

    await submit('bug', [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')]);
    await submit('bug', [finding('bug', 'high', 'a'), finding('bug', 'high', 'c')]);
    await submit('bug', [finding('bug', 'high', 'a')]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(findingsDir, 'bug.json'), 'utf8')).map((item: Finding) => item.id),
      ['bug-a'],
    );

    const validate = (keep: string[]) => step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep, reviewId }));
    await assert.rejects(validate(['bug-a', 'bug-c']), /Unknown finding ids: bug-c/);
    await validate(['bug-a']);
    await assert.rejects(submit('bug', []), /already validated/);

    const result = await step(ws, run => recordReview(ws, run));
    assert.equal(result.green ? 0 : result.blocking, 1);
  });

  it('accepts a finding only on a changed path and inside a new-side hunk', async () => {
    const ws = workspace();
    commit(ws, 'long.txt', Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join(''));
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    writeFileSync(join(ws.root, 'long.txt'), Array.from({ length: 20 }, (_, index) => `line ${index === 9 ? 'ten' : index + 1}\n`).join(''));
    writeFileSync(join(ws.root, 'a b.txt'), 'spaced\n');
    writeFileSync(join(ws.root, 'bin'), Buffer.from([0, 1, 2, 0]));
    rmSync(join(ws.root, 'README.md'));
    commit(ws, 'ok');
    sh(ws.root, 'add', '-A');
    sh(ws.root, 'commit', '-qm', 'slice work');
    await step(ws, run => runChecks(ws, run));
    const { reviewId } = await step(ws, run => startReview(ws, run));
    const at = (name: string, path: string, line?: number): Finding => {
      const { line: _line, ...rest } = finding('bug', 'high', name);
      return { ...rest, path, ...(line === undefined ? {} : { line }) };
    };
    const submit = (findings: Finding[]) => step(ws, run => submitDomain(ws, run, { agentId: 'r-bug', domain: 'bug', findings, reviewId }));

    await assert.rejects(submit([at('above', 'long.txt', 6)]), /line 6 of long\.txt, outside the diff\. Its new-side hunk lines: 7-13\./);
    await assert.rejects(submit([at('below', 'long.txt', 14)]), /outside the diff/);
    await assert.rejects(submit([at('unchanged', 'other.txt')]), /names other\.txt, which the diff does not change/);
    await assert.rejects(submit([at('binary-line', 'bin', 1)]), /file-level findings only: omit line/);
    await assert.rejects(submit([at('deleted-line', 'README.md', 1)]), /file-level findings only/);
    const valid = [at('first', 'long.txt', 7), at('last', 'long.txt', 13), at('spaced', 'a b.txt', 1), at('binary', 'bin'), at('deleted', 'README.md')];
    assert.equal(await submit(valid), valid.length);
  });

  it('skips a path-ruled domain only when no changed file could hold its subject', async () => {
    const contents: Record<string, string> = {
      'src/plain.js': "const fs = require('fs');\nmodule.exports = () => fs.readFileSync('reactor.txt');\n",
      'src/View.js': "import React from 'react';\nexport const View = () => React.createElement('div');\n",
      'src/client.mjs': 'import { createRoot } from "react-dom/client";\n',
      'src/legacy.cjs': "const { jsx } = require('react/jsx-runtime');\n",
    };
    const skipsFor = async (files: string[]) => (await pathSkips(files, async file => contents[file])).map(entry => entry.domain);
    assert.deepEqual(await skipsFor(['README.md', 'docs/guide.md']), ['react-ts', 'test-validity', 'devops']);
    for (const file of ['src/app.ts', 'ui/View.tsx', 'lib/a.mts', 'b.cts', 'c.jsx', 'src/View.js', 'src/client.mjs', 'src/legacy.cjs']) {
      assert.ok(!(await skipsFor([file])).includes('react-ts'), file);
    }
    for (const file of ['src/plain.js', 'lib/a.mjs', 'b.cjs']) assert.ok((await skipsFor([file])).includes('react-ts'), file);
    assert.deepEqual(
      (await pathSkips(['src/plain.js'], async file => contents[file])).find(entry => entry.domain === 'react-ts')?.reason,
      'no TypeScript, JSX, or React file changed (factory path rule)',
    );
    for (const file of ['test/a.ts', 'src/__tests__/b.ts', 'a.test.ts', 'b.spec.js', 'pkg/c_test.go', 'tests/test_d.py', 'spec/e.rb']) {
      assert.ok(!(await skipsFor([file])).includes('test-validity'), file);
    }
    for (const file of ['.github/workflows/ci.yml', 'Dockerfile', 'api/Dockerfile.prod', 'docker-compose.yml', 'Jenkinsfile', 'Makefile', 'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.build.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements-dev.txt', 'infra/main.tf', 'vite.config.ts', 'helm/chart.yaml']) {
      assert.ok(!(await skipsFor([file])).includes('devops'), file);
    }
    assert.deepEqual(await skipsFor(['src/contest.md', 'src/latest.ts']), ['test-validity', 'devops']);
  });

  it('keeps react-ts for a JavaScript file that imports React at the checked commit, not for plain or deleted ones', async () => {
    const ws = workspace();
    commit(ws, 'gone.js', "import React from 'react';\n");
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    rmSync(join(ws.root, 'gone.js'));
    sh(ws.root, 'add', '-A');
    commit(ws, 'ok');
    commit(ws, 'plain.js', 'module.exports = 1;\n');
    const plain = await step(ws, run => runChecks(ws, run));
    assert.ok(plain.passed && plain.pathSkipped.some(entry => entry.domain === 'react-ts'));
    assert.ok((await step(ws, run => startReview(ws, run))).pathSkipped.some(entry => entry.domain === 'react-ts'));

    commit(ws, 'view.js', "const React = require('react');\n");
    const react = await step(ws, run => runChecks(ws, run));
    assert.ok(react.passed && !react.pathSkipped.some(entry => entry.domain === 'react-ts'));
    assert.ok(!(await step(ws, run => startReview(ws, run))).pathSkipped.some(entry => entry.domain === 'react-ts'));
  });

  it('skips path-ruled-out domains unless kept, alongside the orchestrator skips', async () => {
    const { domains, pathSkipped, ws } = await openReview([], [{ domain: 'performance', reason: 'no hot path' }], slice('Feature'), []);
    assert.deepEqual(pathSkipped.map(entry => entry.domain), ['react-ts', 'test-validity', 'devops']);
    assert.deepEqual(domains, ['security', 'testing', 'holistic', 'thermo', 'bug', 'scope', 'comments']);
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r', domain: 'devops', findings: [], reviewId: '01-r1' })),
      /skipped the devops domain/,
    );

    const kept = workspace();
    await newRun(kept, [slice('Feature')]);
    await step(kept, run => nextSlice(kept, run));
    commit(kept, 'ok');
    await step(kept, run => runChecks(kept, run));
    await assert.rejects(
      step(kept, run => startReview(kept, run, [{ domain: 'devops', reason: 'none' }], ['devops'])),
      /both skipped and kept: devops/,
    );
    const opened = await step(kept, run => startReview(kept, run, [{ domain: 'react-ts', reason: 'orchestrator reason' }], ['devops']));
    assert.ok(opened.domains.includes('devops'));
    assert.deepEqual(opened.pathSkipped.map(entry => entry.domain), ['test-validity']);
    assert.deepEqual(readRun(kept, 'demo').slices[0]?.review?.skipped.map(entry => `${entry.domain}: ${entry.reason}`), [
      'test-validity: no test file changed (factory path rule)',
      'react-ts: orchestrator reason',
    ]);
  });

  it('lets the validator correct its verdict once, so a confirmed blocking finding blocks', async () => {
    const { reviewId, ws } = await openReview();
    for (const domain of REVIEW_DOMAINS) {
      const findings = domain === 'testing' ? [finding('testing', 'high', 'mutation-survives')] : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId }));
    }
    const validate = (agentId: string, input: { downgrade?: { id: string; reason: string }[]; keep: string[] }) =>
      step(ws, run => submitValidation(ws, run, { agentId, dropped: [], reviewId, ...input }));
    const downgrade = [{ id: 'testing-mutation-survives', reason: 'not a correctness or requirement gap' }];

    await validate('v', { downgrade, keep: [] });
    await assert.rejects(validate('other', { keep: ['testing-mutation-survives'] }), /validated by another agent/);
    await validate('v', { keep: ['testing-mutation-survives'] });
    await assert.rejects(validate('v', { downgrade, keep: [] }), /already corrected once/);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(!result.green);
    assert.equal(result.blocking, 1);
  });

  it('refuses a validation after the review is recorded', async () => {
    const { reviewId, ws } = await openReview();
    await review(ws, reviewId, []);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);
    await assert.rejects(step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep: [], reviewId })), /already recorded/);
  });

  it('blocks on findings that break a recorded decision', async () => {
    const { reviewId, ws } = await openReview(['The shared field is a non-optional record.']);
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId }));
    const declared = { ...finding('react-ts', 'high', 'undefined-field'), decision: 1 };

    await assert.rejects(submit('react-ts', [{ ...declared, severity: 'observation' }]), /breaks a recorded decision, so it must be critical or high/);
    await assert.rejects(submit('react-ts', [{ ...declared, decision: 2 }]), /names decision 2, but the review data lists 1 decisions/);
    for (const domain of REVIEW_DOMAINS) {
      await submit(domain, domain === 'react-ts' ? [declared] : domain === 'bug' ? [finding('bug', 'observation', 'missed-conflict')] : []);
    }
    const validate = (input: { downgrade?: { id: string; reason: string }[]; escalate?: { decision: number; id: string; reason: string }[]; keep: string[] }) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], reviewId, ...input }));
    const reason = 'breaks the decision';

    await assert.rejects(
      validate({ downgrade: [{ id: 'react-ts-undefined-field', reason }], keep: ['bug-missed-conflict'] }),
      /breaks a recorded decision cannot be downgraded/,
    );
    await assert.rejects(
      validate({ escalate: [{ decision: 1, id: 'react-ts-undefined-field', reason }], keep: ['bug-missed-conflict'] }),
      /Only observation findings can be escalated/,
    );
    await assert.rejects(
      validate({ escalate: [{ decision: 3, id: 'bug-missed-conflict', reason }], keep: ['react-ts-undefined-field'] }),
      /names decision 3, but the review data lists 1 decisions/,
    );
    await validate({ escalate: [{ decision: 1, id: 'bug-missed-conflict', reason }], keep: ['react-ts-undefined-field'] });

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(!result.green);
    assert.equal(result.blocking, 2);
    const fix = readFileSync(result.fixPath, 'utf8');
    assert.match(fix, /\[high\] bug-missed-conflict[\s\S]*- Breaks decision 1: The shared field is a non-optional record\./);
    assert.match(fix, /\[high\] react-ts-undefined-field[\s\S]*- Breaks decision 1:/);
  });

  it('skips the domains the orchestrator leaves out, but never the required ones', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    for (const domain of ['bug', 'scope', 'testing'] as const) {
      await assert.rejects(step(ws, run => startReview(ws, run, [{ domain, reason: 'small' }])), new RegExp(`always review this slice: ${domain}`));
    }
    await assert.rejects(
      step(ws, run => startReview(ws, run, [{ domain: 'devops', reason: 'a' }, { domain: 'devops', reason: 'b' }])),
      /appears twice/,
    );
    const opened = await step(ws, run => startReview(ws, run, [{ domain: 'react-ts', reason: 'no TypeScript or React' }], ['test-validity', 'devops']));
    assert.deepEqual(opened.domains, REVIEW_DOMAINS.filter(domain => domain !== 'react-ts'));
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r', domain: 'react-ts', findings: [], reviewId: opened.reviewId })),
      /skipped the react-ts domain/,
    );
    for (const domain of opened.domains) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: [], reviewId: opened.reviewId }));
    }
    await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId: opened.reviewId }));
    assert.ok((await step(ws, run => recordReview(ws, run))).green);
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'review-start')?.detail ?? '', /skipped react-ts \(no TypeScript or React\)/);
  });

  it('lets a slice without test seams skip the testing domain', async () => {
    const docs = slice('Docs', [], { noTestReason: 'docs only', seams: [] });
    const { domains } = await openReview([], [{ domain: 'testing', reason: 'docs only' }, { domain: 'test-validity', reason: 'docs only' }], docs);
    assert.ok(!domains.includes('testing'));
  });

  it('merges duplicates across domains into the most severe kept finding', async () => {
    const { reviewId, ws } = await openReview();
    const same = { path: 'ok', problem: 'TS5097', title: 'ts-extension-import' };
    for (const domain of REVIEW_DOMAINS) {
      const findings =
        domain === 'react-ts'
          ? [{ ...finding('react-ts', 'high', 'ts5097'), ...same }]
          : domain === 'thermo' || domain === 'devops'
            ? [{ ...finding(domain, 'observation', 'ts5097'), ...same }]
            : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId }));
    }
    const validate = (keep: string[], dropped: { duplicateOf?: string; id: string; reason: string }[]) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));

    await assert.rejects(
      validate(['thermo-ts5097'], [
        { duplicateOf: 'thermo-ts5097', id: 'react-ts-ts5097', reason: 'same issue' },
        { duplicateOf: 'thermo-ts5097', id: 'devops-ts5097', reason: 'same issue' },
      ]),
      /Keep the most severe of the duplicates: "react-ts-ts5097" is high/,
    );
    await assert.rejects(
      validate(['react-ts-ts5097', 'devops-ts5097'], [{ duplicateOf: 'missing', id: 'thermo-ts5097', reason: 'same issue' }]),
      /not a kept finding/,
    );
    await validate(['react-ts-ts5097'], [
      { duplicateOf: 'react-ts-ts5097', id: 'thermo-ts5097', reason: 'same issue' },
      { duplicateOf: 'react-ts-ts5097', id: 'devops-ts5097', reason: 'same issue' },
    ]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(!result.green);
    assert.equal(result.blocking, 1);
  });

  it('turns downgraded blocking findings into non-blocking observations', async () => {
    const { reviewId, ws } = await openReview();
    for (const domain of REVIEW_DOMAINS) {
      const findings =
        domain === 'thermo'
          ? [finding('thermo', 'high', 'extract-layer'), finding('thermo', 'observation', 'naming')]
          : domain === 'bug'
            ? [finding('bug', 'critical', 'unreachable-guard')]
            : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId }));
    }
    const validate = (downgrade: { id: string; reason: string }[], keep: string[]) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'v', downgrade, dropped: [], keep, reviewId }));
    const reason = 'not a correctness or requirement gap';

    await assert.rejects(validate([{ id: 'thermo-naming', reason }], ['thermo-extract-layer', 'bug-unreachable-guard']), /Only critical or high findings can be downgraded: thermo-naming/);
    await validate([{ id: 'thermo-extract-layer', reason }, { id: 'bug-unreachable-guard', reason }], ['thermo-naming']);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.green);
    assert.equal(result.observations.length, 3);
    assert.match(result.observations.join('\n'), /\[observation\] thermo-extract-layer/);
  });

  it('rejects findings submitted after validation', async () => {
    const { reviewId, ws } = await openReview();
    for (const domain of REVIEW_DOMAINS.filter(domain => domain !== 'bug')) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: [], reviewId }));
    }
    await step(ws, run => submitDomain(ws, run, { agentId: 'bug', domain: 'bug', findings: [], reviewId }));
    await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId }));
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'late', domain: 'security', findings: [finding('security', 'critical', 'late')], reviewId })),
      /already validated/,
    );
  });

  it('rejects a findings file edited after it was submitted', async () => {
    const { findingsDir, reviewId, ws } = await openReview();
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: domain === 'security' ? [finding('security', 'critical', 'leak')] : [], reviewId }));
    }
    writeFileSync(join(findingsDir, 'security.json'), '[]\n');
    await assert.rejects(step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId })), /changed after it was submitted/);
  });
});
