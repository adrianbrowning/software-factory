import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { readRun } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { nextAction, nextSlice, pauseRun, planFollowUp, resolveStall, repoChecks, resumeRun, saveChecks, startRun } from '../src/workflow.ts';
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
    const hardLine = failed.summary.find(l => l.startsWith(hard));
    assert.ok(hardLine);
    assert.match(hardLine.slice(hard.length), /^: failed \(exit 1\) in \d+ms on rerun \(first failed \(exit 1\) in \d+ms\)$/);
  });

  async function flakyRun(output: string, redirect = '', emit?: (out: string) => string) {
    using counter = tempDir('factory-flaky-names-');
    using out = tempDir('factory-flaky-out-');
    writeFileSync(join(out.root, 'out.txt'), output);
    const check = `if [ -f '${counter.root}/seen' ]; then exit 0; fi; touch '${counter.root}/seen'; ${emit ? emit(out.root) : `cat '${out.root}/out.txt' ${redirect}`}; exit 1`;
    using ws = workspace({ checks: [check] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    const line = result.summary.find(l => /flaky/.test(l)) ?? '';
    const event = readRun(ws, 'demo').events.find(e => e.kind === 'checks-pass');
    assert.ok(event?.detail.includes(line));
    return line.slice(check.length);
  }

  it('names the failing tests of a node:test spec first failure in the flaky line', async () => {
    const line = await flakyRun(
      '✖ inner (1ms)\n✖ failing tests:\n\ntest at test/a.test.ts:12:3\n✖ alpha works (2.1ms)\n  Error: boom\n\ntest at test/my dir/b.test.ts:5:1\n✖ beta works (0.5ms)\n  Error: x\n\ntest at test/a.test.ts:12:3\n✖ alpha works (2.1ms)\n',
    );
    assert.match(line, /test\/a\.test\.ts:12:3 alpha works/);
    assert.match(line, /test\/my dir\/b\.test\.ts:5:1 beta works/);
    assert.equal(line.split('alpha works').length, 2);
    assert.ok(!line.includes('inner'));
    assert.ok(!/last (stdout|stderr) line/.test(line));
  });

  it('parses a whitespace-heavy test at line in well under a second and still names the other entries', async () => {
    const spaces = ' '.repeat(500_000);
    const started = Date.now();
    const line = await flakyRun(`✖ failing tests:\n\ntest at ${spaces}x\n✖ huge (1ms)\n\ntest at test/a.test.ts:1:1\n✖ alpha works (2ms)\n`);
    assert.ok(Date.now() - started < 10_000, 'a quadratic parse takes minutes');
    assert.match(line, /test\/a\.test\.ts:1:1 alpha works/);
  });

  it('keeps a quoted JSON credential out of the flaky line, in a TAP name and in the last output line', async () => {
    const tap = await flakyRun('not ok 1 - {"password": "hunter2"}\n');
    assert.ok(!tap.includes('hunter2'));
    assert.match(tap, /failing tests: .*password=<REDACTED>/);
    const last = await flakyRun('{"token": "s3cr3t"}\n');
    assert.ok(!last.includes('s3cr3t'));
    assert.match(last, /last stdout line: .*token=<REDACTED>/);
  });

  it('names TAP not ok tests, caps at 10 and counts the rest, and redacts secrets in names', async () => {
    const tap = Array.from({ length: 12 }, (_, i) => `not ok ${i + 1} - case${i + 1}${i === 0 ? ' token=sekret123' : ''}`).join('\n');
    const line = await flakyRun(`ok 0 - fine\n${tap}\n`);
    assert.match(line, /case10/);
    assert.ok(!line.includes('case11'));
    assert.match(line, /2 more/);
    assert.ok(!line.includes('sekret123'));
    assert.ok(!/last (stdout|stderr) line/.test(line));
  });

  it('keeps the last non-empty output line, redacted and capped at 300 characters, when no test is named', async () => {
    const line = await flakyRun(`something\nGITHUB_TOKEN=abc123xyz ${'x'.repeat(400)}\n\n`);
    assert.match(line, /GITHUB_TOKEN=<REDACTED>/);
    assert.ok(!line.includes('abc123xyz'));
    assert.ok(!line.includes('something'));
    assert.ok(line.includes('x'.repeat(100)));
    assert.ok(!line.includes('x'.repeat(301)));
    assert.ok(line.split('last stdout line: ')[1]!.replace(/\)$/, '').length <= 300);
  });

  /**
   * A shell command that returns only after the parent has read what was written before it. It writes blank padding
   * (never counted as output) that no stdio socket buffer can hold (those are a few hundred KB at most; libuv gives a
   * child a socketpair per stream), yet that fits the 1 MB capture limit with the earlier text. The write blocks until
   * the parent has drained the stream up to the earlier text: backpressure orders the two streams, not a timer.
   */
  const drained = (redirect: string) => `head -c 900000 /dev/zero | tr '\\0' ' ' ${redirect}`;

  it('names the stream that received the last non-blank output as the fallback line', async () => {
    const line = await flakyRun('from stderr\n', '>&2');
    assert.match(line, /last stderr line: from stderr/);
    assert.ok(!line.includes('last stdout line'));
    assert.match(await flakyRun('from stdout\n'), /last stdout line: from stdout/);
    const stdoutLast = await flakyRun('', '', () => `printf 'earlier\\n' >&2; ${drained('>&2')}; printf 'last\\n'`);
    assert.match(stdoutLast, /last stdout line: last/);
    assert.ok(!stdoutLast.includes('earlier'));
    const stderrLast = await flakyRun('', '', () => `printf 'earlier\\n'; ${drained('')}; printf 'last\\n' >&2`);
    assert.match(stderrLast, /last stderr line: last/);
    assert.ok(!stderrLast.includes('earlier'));
    const blank = await flakyRun('', '', () => `printf 'last\\n'; ${drained('')}; printf ' \\n' >&2`);
    assert.match(blank, /last stdout line: last/);
    const nbsp = await flakyRun('', '', () => `printf 'last\\n'; ${drained('')}; printf '\\302\\240' >&2`);
    assert.match(nbsp, /last stdout line: last/);
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
    using ws = workspace({ checks: [dup] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => {
      run.checks = [dup, dup];
    });
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(result.summary.filter(line => /flaky/.test(line)).length, 1);
  });

  it('saveChecks writes and returns the normalized list; blank-only lists are refused', async () => {
    using ws = workspace({ checks: undefined });
    assert.deepEqual(await saveChecks(ws, [' a ', 'a', '', 'b']), ['a', 'b']);
    assert.deepEqual(JSON.parse(readFileSync(join(ws.root, ws.config.scratchDir, 'checks.json'), 'utf8')).checks, ['a', 'b']);
    await assert.rejects(saveChecks(ws, ['  ']), /Choose at least one check command\./);
  });

  it('repoChecks reads a hand-written checks.json through the shared schema', async () => {
    using ws = workspace({ checks: undefined });
    await saveChecks(ws, ['x']);
    writeFileSync(join(ws.root, ws.config.scratchDir, 'checks.json'), JSON.stringify({ checks: [' a ', 'a', '  ', 'b'] }));
    assert.deepEqual(repoChecks(ws), ['a', 'b']);
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

// Date.now is mocked process-wide, so these tests run alone, outside the concurrent suite above.
describe('checks and a host clock jump', () => {
  /**
   * Runs checks with a Date.now that moves 60 s ahead for each file in `jumps`, so a check command that creates a file
   * there makes the host clock jump while that command runs.
   */
  async function withClockJumps(jumps: string, checks: (jumps: string) => string[], body: (ws: ReturnType<typeof workspace>) => Promise<void>) {
    const realNow = Date.now.bind(Date);
    const now = mock.method(Date, 'now', () => realNow() + readdirSync(jumps).length * 60_000);
    try {
      using ws = workspace({ checks: checks(jumps) });
      await newRun(ws, [slice('Feature')]);
      await step(ws, run => nextSlice(ws, run));
      commit(ws, 'work.txt');
      await body(ws);
    } finally {
      now.mock.restore();
    }
  }

  it('refuses a failed check whose deciding run saw a clock jump as an environment error, not a fix round', async () => {
    using jumps = tempDir('factory-jumps-');
    const check = (dir: string) => `touch '${dir}'/$$; exit 1`;
    await withClockJumps(jumps.root, dir => [check(dir)], async ws => {
      const before = readRun(ws, 'demo');
      await assert.rejects(
        step(ws, run => runChecks(ws, run)),
        error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /touch '[^']*'\/\$\$; exit 1[^\n]*clockJumpMs \d+/);
          assert.match(error.message, /environment error[^\n]*host sleep or a clock change[^\n]*not a code fault/);
          assert.match(error.message, /Then call factory_checks again\.$/);
          return true;
        },
      );
      const after = readRun(ws, 'demo');
      assert.equal(after.slices[0]?.fixRounds, 0);
      assert.equal(after.slices[0]?.phase, 'implement');
      assert.equal(after.slices[0]?.fixPath, undefined);
      assert.equal(existsSync(join(ws.root, '.scratch', 'demo', 'fixes')), false);
      assert.deepEqual(after.events.filter(e => e.kind === 'checks-fail'), before.events.filter(e => e.kind === 'checks-fail'));
    });
  });

  it('refuses a timed-out check whose run saw a clock jump', async () => {
    using jumps = tempDir('factory-jumps-');
    await withClockJumps(jumps.root, dir => [`touch '${dir}'/$$; sleep 30`], async ws => {
      ws.config.checkTimeoutMs = 300;
      await assert.rejects(step(ws, run => runChecks(ws, run)), /environment error[\s\S]*Then call factory_checks again\.$/);
      assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0);
    });
  });

  it('passes a check that failed with a clock jump and passed on a rerun without one, marked flaky', async () => {
    using jumps = tempDir('factory-jumps-');
    await withClockJumps(jumps.root, dir => [`if [ -f '${dir}'/a ]; then exit 0; fi; touch '${dir}'/a; exit 1`], async ws => {
      const result = await step(ws, run => runChecks(ws, run));
      assert.ok(result.passed);
      assert.match(result.summary.join('\n'), /passed on rerun, flaky/);
    });
  });

  it('opens a fix round when a clock-jumped first run is followed by a failing rerun without a jump', async () => {
    using jumps = tempDir('factory-jumps-');
    await withClockJumps(jumps.root, dir => [`if [ -f '${dir}'/a ]; then exit 1; fi; touch '${dir}'/a; exit 1`], async ws => {
      const result = await step(ws, run => runChecks(ws, run));
      assert.ok(!result.passed);
      assert.match(readFileSync(result.fixPath, 'utf8'), /on rerun/);
      assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 1);
    });
  });

  it('passes checks that all pass while the clock jumps', async () => {
    using jumps = tempDir('factory-jumps-');
    await withClockJumps(jumps.root, dir => [`touch '${dir}'/$$`], async ws => {
      assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    });
  });
});
