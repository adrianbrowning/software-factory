import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRun } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { nextAction, nextSlice, pauseRun, planFollowUp, resolveStall, resumeRun, saveChecks, startRun } from '../src/workflow.ts';
import { checkRuns, commit, countedCheck, finding, fixItems, green, newRun, review, sh, slice, start, step, tempDir, workspace } from './helpers.ts';

describe('slice loop gates: checks and the fix budget', { concurrency: 4 }, () => {
  it('drops the stored check results whenever the checked commit stops being current', async () => {
    using ws = workspace();
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
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
    const fixing = readRun(ws, 'demo').slices[0];
    assert.deepEqual([fixing?.phase, fixing?.checked], ['fix', undefined]);
    const fixed = await step(ws, run => runChecks(ws, run));
    assert.ok(fixed.passed && !fixed.reused);
    assert.deepEqual(checkRuns(ws), ['run', 'run', 'run']);
    assert.equal(fixed.summary.length, 2);
  });

  it('fails checks that leave the working tree changed, and lists that as a fix item of the next review', async () => {
    using ws = workspace({ checks: ['touch ok stray.txt'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    const fix = readFileSync(result.fixPath, 'utf8');
    assert.match(fix, /Checks changed the working tree[\s\S]*stray\.txt/);
    assert.match(fix, /## Fix items\n\n- `tree-f1`: Checks changed the working tree\n/);

    commit(ws, 'ok');
    commit(ws, 'stray.txt');
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    const data = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    assert.match(data, /\n- `tree-f1` \([^\n]*fixes\/01-f1\.md, round 1\): Checks changed the working tree\n/);
  });

  it('refuses a check whose command is not found as an environment error, not a fix round', async () => {
    using ws = workspace({ checks: ['factory-missing-tool --run'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    await assert.rejects(step(ws, run => runChecks(ws, run)), /factory-missing-tool --run[\s\S]*PATH used:[\s\S]*environment error[\s\S]*checkPath/);
    const after = readRun(ws, 'demo').slices[0];
    assert.equal(after?.fixRounds, 0);
    assert.equal(after?.phase, 'implement');
    assert.equal(after?.fixPath, undefined);
    assert.equal(existsSync(join(ws.root, '.scratch', 'demo', 'fixes')), false);

    using bin = tempDir('factory-bin-');
    writeFileSync(join(bin.root, 'factory-missing-tool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin.root, 'factory-missing-tool'), 0o755);
    ws.config.checkPath = [bin.root];
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
  });

  it('refuses a wrapped command-not-found that exits with another code, in bash and dash wording', async () => {
    for (const line of ['sh: pnpm: command not found', 'sh: 1: pnpm: not found', '/bin/sh: line 1: pnpm: command not found']) {
      using ws = workspace({ checks: [`printf '%s\\n' '${line}' >&2; exit 1`] });
      await newRun(ws, [slice('Feature')]);
      await step(ws, run => nextSlice(ws, run));
      commit(ws, 'work.txt');
      await assert.rejects(step(ws, run => runChecks(ws, run)), /environment error[\s\S]*command -v pnpm[\s\S]*install the dependencies/, line);
      assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0, line);
    }
  });

  it('counts an ordinary failure that mentions "not found" as a fix round', async () => {
    using ws = workspace({ checks: [`printf 'error: module not found\\n' >&2; exit 1`] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 1);
  });
  it('retries a failed check once: a pass on rerun is flaky, uses no fix round, and a second failure keeps the rerun output', async () => {
    using counter = tempDir('factory-flaky-');
    const flaky = `if [ -f '${counter.root}/seen' ]; then exit 0; fi; touch '${counter.root}/seen'; exit 1`;
    using ws = workspace({ checks: [flaky] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.match(result.summary.join('\n'), /flaky[\s\S]*first failed \(exit 1\) in \d+ms/);
    const after = readRun(ws, 'demo').slices[0];
    const event = readRun(ws, 'demo').events.find(e => e.kind === 'checks-pass' && e.slice === after?.id);
    assert.match(event?.detail ?? '', /flaky[\s\S]*first failed \(exit 1\) in \d+ms/);
    const flakyLine = result.summary.find(line => /flaky/.test(line));
    assert.ok(flakyLine?.startsWith(flaky));
    assert.ok(flakyLine && event?.detail.includes(flakyLine));
    assert.equal(after?.fixRounds, 0);
    assert.equal(after?.fixPath, undefined);

    using both = tempDir('factory-both-');
    const hard = `echo run >> '${both.root}/n'; echo "attempt $(wc -l < '${both.root}/n')" >&2; exit 1`;
    using ws2 = workspace({ checks: [hard] });
    await newRun(ws2, [slice('Feature')]);
    await step(ws2, run => nextSlice(ws2, run));
    commit(ws2, 'work.txt');
    const failed = await step(ws2, run => runChecks(ws2, run));
    assert.ok(!failed.passed);
    assert.match(readFileSync(failed.fixPath, 'utf8'), /attempt\s+2/);
    assert.equal(readRun(ws2, 'demo').slices[0]?.fixRounds, 1);
  });

  it('runs a passing check once and does not rerun a timed-out check', async () => {
    using counter = tempDir('factory-once-');
    using ws = workspace({ checks: [`echo x >> '${counter.root}/n'`] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.equal(readFileSync(join(counter.root, 'n'), 'utf8').split('\n').filter(Boolean).length, 1);

    using slow = tempDir('factory-slow-');
    using ws2 = workspace({ checks: [`echo x >> '${slow.root}/n'; sleep 5`], checkTimeoutMs: 300 });
    await newRun(ws2, [slice('Feature')]);
    await step(ws2, run => nextSlice(ws2, run));
    commit(ws2, 'work.txt');
    assert.ok(!(await step(ws2, run => runChecks(ws2, run))).passed);
    assert.equal(readFileSync(join(slow.root, 'n'), 'utf8').split('\n').filter(Boolean).length, 1);
  });
  it('marks only the occurrence that failed as flaky when a check command is listed twice', async () => {
    using counter = tempDir('factory-dup-');
    const dup = `echo x >> '${counter.root}/n'; [ "$(wc -l < '${counter.root}/n')" -ne 1 ]`;
    using ws = workspace({ checks: [dup, dup] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(result.summary.filter(line => /flaky/.test(line)).length, 1);
  });

  it('reports a check that runs past its timeout', async () => {
    using ws = workspace({ checks: ['sleep 5'], checkTimeoutMs: 100 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.match(readFileSync(result.fixPath, 'utf8'), /sleep 5: timed out/);
  });

  it('gates a run on the checks it started with; changed saved checks reach new runs only', async () => {
    using ws = workspace({ checks: undefined });
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
    using ws = workspace({ maxRounds: 1 });
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

    await step(ws, run => resolveStall(ws, run, 'continue'));
    commit(ws, 'ok');
    assert.ok((await failChecks()).passed);
    const items = fixItems((await step(ws, run => startReview(ws, run))).dataFile);
    const ids = [...items.matchAll(/^- `([^`]+)` \([^\n]*fixes\/01-f(\d)\.md, round (\d)\)/gm)].map(([, id, file, round]) => `${id} ${file} ${round}`);
    assert.deepEqual(ids, ['check-f1-1 1 1', 'check-f2-1 2 2', 'check-f3-1 3 3'], 'each stalled and continued round keeps its own id, fix file, and round');
  });

  it('tells the user a stalled run asks on resume whether to raise the used-up fix budget', async () => {
    using ws = workspace({ maxRounds: 1 });
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
    using ws = workspace({ maxRounds: 1 });
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

  it('tells the orchestrator a paused run that is not stalled resumes with factory_start, only when the user asks', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => pauseRun(run, 'test'));
    assert.equal(
      nextAction(readRun(ws, 'demo')),
      'The run is paused. When the user asks to continue, call factory_start with resume "demo" (the user\'s command is /factory resume demo); otherwise stop.',
    );
  });

  it('raises the budget by maxRounds, not by the used rounds, when a stalled run resumes', async () => {
    using ws = workspace({ maxRounds: 1 });
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

  it('refuses to run the checks while another branch or a detached HEAD is checked out', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const sliceBranch = sh(ws.root, 'branch', '--show-current');
    sh(ws.root, 'switch', '-q', '-c', 'elsewhere');
    await assert.rejects(step(ws, run => runChecks(ws, run)), new RegExp(`works on ${sliceBranch}, but elsewhere is checked out`));
    sh(ws.root, 'switch', '-q', '--detach');
    await assert.rejects(step(ws, run => runChecks(ws, run)), new RegExp(`works on ${sliceBranch}, but a detached HEAD is checked out`));
    sh(ws.root, 'switch', '-q', sliceBranch);
    sh(ws.root, 'branch', '-q', '-D', 'elsewhere');
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
  });

  it('refuses to run the checks while the working tree has uncommitted changes', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const dirty = /commit or remove these changes first/;
    writeFileSync(join(ws.root, 'untracked.txt'), 'x\n');
    await assert.rejects(step(ws, run => runChecks(ws, run)), dirty);
    rmSync(join(ws.root, 'untracked.txt'));
    writeFileSync(join(ws.root, 'ok'), 'changed\n');
    await assert.rejects(step(ws, run => runChecks(ws, run)), dirty);
    sh(ws.root, 'checkout', '--', 'ok');
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
  });
});
