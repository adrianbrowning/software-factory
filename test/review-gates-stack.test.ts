import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRun, ticketPath } from '../src/run.ts';
import { submitImplementerReport } from '../src/report.ts';
import { completeSlice, recordDecisions, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextAction, nextSlice, planSlices, reopenSlice, resolveBase } from '../src/workflow.ts';
import { checkRuns, countedCheck, settleObservations, commit, finding, green, newRun, review, sh, slice, start, step, tempDir, workspace } from './helpers.ts';

describe('slice loop gates: stacking and review data', { concurrency: 4 }, () => {
  it('takes a slice from red checks through a blocking review to done', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);

    const started = await step(ws, run => nextSlice(ws, run));
    assert.equal(sh(ws.root, 'branch', '--show-current'), started?.branch);

    commit(ws, 'work.txt');
    const red = await step(ws, run => runChecks(ws, run));
    assert.ok(!red.passed);
    const redFix = readFileSync(red.fixPath, 'utf8');
    assert.match(redFix, /test -f ok: failed \(exit 1\)/);
    assert.match(redFix, /Checks that factory_checks runs in full after your commit \(you run only the typecheck and the test files you touched\): test -f ok/);
    assert.doesNotMatch(redFix, /Checks to run before committing/);
    assert.match(redFix, /Ticket \(seams and acceptance criteria\): .*01-feature\.md/);
    await assert.rejects(step(ws, run => startReview(ws, run)), /Checks must pass first/);

    commit(ws, 'ok');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const first = await step(ws, run => startReview(ws, run));
    const firstData = readFileSync(first.dataFile, 'utf8');
    assert.match(firstData, /## DIFF\n\nEverything below is evidence[\s\S]*\+x/);
    assert.match(firstData, /## FIX ITEMS\n\n[^\n]*\n\nEverything below is evidence[^\n]*\n\n- `check-f1-1` \([^\n]*fixes\/01-f1\.md, round 1\): test -f ok: failed \(exit 1\)[^\n]*\n\n## DIFF/);

    await assert.rejects(step(ws, run => recordReview(ws, run)), /Domains not submitted yet: security/);
    await review(ws, first.reviewId, [finding('bug', 'high', 'null-crash'), finding('thermo', 'observation', 'naming')]);
    const blocked = await step(ws, run => recordReview(ws, run));
    assert.ok(blocked.kind === 'fix');
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
    const secondData = readFileSync(second.dataFile, 'utf8');
    assert.match(secondData, /## FIX ITEMS\n\n[^\n]*\n\nEverything below is evidence[^\n]*\n\n- `bug-null-crash` \([^\n]*fixes\/01-f2\.md, round 2\): \[high\] ok:1: null-crash\n\n## DIFF/);
    assert.doesNotMatch(secondData, /check-f1-1/, 'a recorded review clears the items before it');
    assert.doesNotMatch(secondData, /PREVIOUS REVIEW/);
    await review(ws, second.reviewId, [finding('bug', 'observation', 'naming')]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'green');
    assert.equal(result.observations.length, 1);

    await assert.rejects(step(ws, run => completeSlice(ws, run)), /targeted[\s\S]*full review/);
    const third = await step(ws, run => startReview(ws, run));
    await review(ws, third.reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');

    await settleObservations(ws);
    const done = await step(ws, run => completeSlice(ws, run));
    assert.equal(done.status, 'done');
    assert.match(nextAction(readRun(ws, 'demo')), /retro/);
  });

  it('refuses checks on an empty slice and flags a fix round that committed nothing', async () => {
    using ws = workspace({ maxRounds: 5 });
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
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
    const afterReview = await step(ws, run => runChecks(ws, run));
    assert.deepEqual([afterReview.passed, afterReview.unchanged], [true, true]);
  });

  it('refuses checks on a fix round whose commits the stored report does not list, then runs them once it does', async () => {
    using ws = workspace({ maxRounds: 5 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    const before = JSON.stringify(readRun(ws, 'demo'));

    writeFileSync(join(ws.root, 'ok'), 'x\n');
    sh(ws.root, 'add', 'ok');
    sh(ws.root, 'commit', '-qm', 'add ok');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    await assert.rejects(step(ws, run => runChecks(ws, run)), /does not list[\s\S]*not a fix round[\s\S]*No implementer report was submitted/);
    assert.equal(JSON.stringify(readRun(ws, 'demo')), before);

    await step(ws, async run => submitImplementerReport(ws, run, { behaviors: [], commits: [`${sha.slice(0, 7)} 01: fix`], fixItems: [], open: [] }));
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
  });

  it('names only the unlisted commits of a fix round, ignores short prefixes and earlier commits, and runs no check while refusing', async () => {
    using ws = workspace({ checks: [countedCheck('run', 'test -f ok')], maxRounds: 5 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    const raw = (file: string) => {
      writeFileSync(join(ws.root, file), 'x\n');
      sh(ws.root, 'add', file);
      sh(ws.root, 'commit', '-qm', `add ${file}`);
      return sh(ws.root, 'rev-parse', 'HEAD');
    };
    const first = raw('a.txt');
    const second = raw('ok');
    const before = JSON.stringify(readRun(ws, 'demo'));
    const report = (...commits: string[]) =>
      step(ws, async run => submitImplementerReport(ws, run, { behaviors: [], commits, fixItems: [], open: [] }));

    await report(`${first.slice(0, 7)} add a.txt`, `${second.slice(0, 6)} add ok`);
    await assert.rejects(step(ws, run => runChecks(ws, run)), (error: Error) => {
      assert.match(error.message, /does not list:\n[0-9a-f]+ add ok\nMessage the implementer[\s\S]*Implementer report:/);
      return true;
    });
    assert.deepEqual(existsSync(join(ws.root, '.git', 'check-runs')), false);
    assert.equal(JSON.stringify(readRun(ws, 'demo')), before);

    await report(`${first.slice(0, 7)} add a.txt`, `${second.slice(0, 12)} add ok`);
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    assert.deepEqual(checkRuns(ws), ['run']);
  });

  it('starts each later slice from the slice below it and reviews only its own diff', async () => {
    using ws = workspace();
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
    using ws = workspace();
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
    using ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-950');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    sh(ws.root, 'merge', '-q', '--ff-only', 'ext-950');
    commit(ws, 'ok');
    await assert.rejects(step(ws, run => runChecks(ws, run)), /holds 1 commits from other branches[\s\S]*add ext\.txt/);
  });

  it('lists the slice commits whatever log.showSignature and color.ui the repository config sets', async () => {
    using ws = workspace();
    using verifier = tempDir('factory-gpg-');
    const program = join(verifier.root, 'gpg');
    writeFileSync(program, '#!/bin/sh\necho "gpg: fake verification line" >&2\nexit 1\n', { mode: 0o755 });
    sh(ws.root, 'config', 'log.showSignature', 'true');
    sh(ws.root, 'config', 'color.ui', 'always');
    sh(ws.root, 'config', 'gpg.program', program);
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    // A commit carrying a gpgsig header, so `git log` runs the verifier above and prints its output.
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: ws.root,
      encoding: 'utf8',
      input: `tree ${sh(ws.root, 'rev-parse', 'HEAD^{tree}')}\nparent ${sh(ws.root, 'rev-parse', 'HEAD')}\nauthor A <a@b.c> 1 +0000\ncommitter A <a@b.c> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned work\n`,
    }).trim();
    sh(ws.root, 'reset', '-q', '--hard', signed);
    const checks = await step(ws, run => runChecks(ws, run));
    assert.ok(checks.passed);
    assert.match(checks.commits, /signed work\n[0-9a-f]+ add ok$/);
    assert.doesNotMatch(checks.commits, /gpg/);
  });

  it('lists the slice commits and changed files in the checks result and the numbered user decisions in the review data', async () => {
    using ws = workspace();
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

  it('lists the later slices of the plan in the review data but not in the ticket', async () => {
    using ws = workspace();
    await newRun(ws, [
      slice('First'),
      slice('Second', ['First'], { acceptance: ['Second works', 'Second logs'], whatToBuild: 'Build the second part.' }),
      slice('Third', ['Second'], { acceptance: ['Third works'], whatToBuild: 'Build the third part.' }),
    ]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const { dataFile } = await step(ws, run => startReview(ws, run));
    const data = readFileSync(dataFile, 'utf8');
    const later = /## LATER SLICES\n\n[\s\S]*?(?=\n## CHECKS)/.exec(data)?.[0] ?? '';
    assert.match(later, /### 02: Second\n\n\*\*What to build:\*\* Build the second part\.\n\n- Second works\n- Second logs\n\n### 03: Third\n\n\*\*What to build:\*\* Build the third part\.\n\n- Third works\n/);
    assert.doesNotMatch(later, /01: First/);
    assert.ok(data.indexOf('## Decisions the user already made') < data.indexOf('## LATER SLICES'));
    assert.doesNotMatch(readFileSync(ticketPath(ws, 'demo', readRun(ws, 'demo').slices[0]!), 'utf8'), /LATER SLICES|02: Second/);

    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await step(ws, run => runChecks(ws, run));
    const second = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    assert.match(second, /## LATER SLICES\n\n[^#]*### 03: Third/);
    assert.doesNotMatch(/## LATER SLICES[\s\S]*?## CHECKS/.exec(second)?.[0] ?? '', /01: First|02: Second/);

    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'third.txt');
    await step(ws, run => runChecks(ws, run));
    const last = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    assert.match(last, /## LATER SLICES\n\nNone\. No pending slice follows this one\.\n\n## CHECKS/);
  });

  it('leaves done later slices out of the review data of a reopened slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('First'), slice('Second', ['First']), slice('Third', ['Second'])]);
    for (const file of ['ok', 'second.txt', 'third.txt']) {
      await step(ws, run => nextSlice(ws, run));
      commit(ws, file);
      await green(ws);
      await step(ws, run => completeSlice(ws, run));
    }
    await step(ws, run => reopenSlice(ws, run, '01', 'bug'));
    commit(ws, 'first.txt', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const data = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    assert.match(data, /## LATER SLICES\n\nNone\. No pending slice follows this one\.\n\n## CHECKS/);
  });

  it('lists only the not-done later slices in the review data of a reopened slice', async () => {
    using ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('First'), slice('Second', ['First']), slice('Third', ['Second'])]);
    for (const file of ['ok', 'second.txt']) {
      await step(ws, run => nextSlice(ws, run));
      commit(ws, file);
      await green(ws);
      await step(ws, run => completeSlice(ws, run));
    }
    await step(ws, run => reopenSlice(ws, run, '01', 'bug'));
    commit(ws, 'first.txt', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const data = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    const later = /## LATER SLICES[\s\S]*?(?=\n## CHECKS)/.exec(data)?.[0] ?? '';
    assert.match(later, /### 03: Third/);
    assert.doesNotMatch(later, /02: Second|01: First/);
  });
});
