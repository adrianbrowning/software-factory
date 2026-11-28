import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRun, runDir } from '../src/run.ts';
import { runChecks } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, newRun, slice, step, workspace } from './helpers.ts';

const CHECK = 'sh .git/check.sh';
const VITEST_OUTPUT = ' FAIL  test/a.test.ts > suite > works\nFAIL test/b.test.ts (1 s)\n';

type Setup = {
  /** Output the failing first run prints. */
  output?: string;
  /** The 1-based run of the check command that first passes; 0: never. */
  checkPassesFrom?: number;
  /** The 1-based targeted run that first passes; 0: never. */
  targetedPassesFrom?: number;
  /** Seconds the targeted command sleeps before it exits. */
  targetedSleep?: number;
  template?: string;
  key?: string;
  tries?: number;
  timeoutMs?: number;
};

/** A workspace whose check fails with `output` until its Nth run, and whose targeted command records its arguments. */
async function setup(options: Setup = {}) {
  const { output = VITEST_OUTPUT, checkPassesFrom = 2, targetedPassesFrom = 1, targetedSleep = 0, template = 'sh .git/targeted.sh {files}', key = CHECK, tries, timeoutMs } = options;
  const ws = workspace({ checks: [CHECK], rerunFiles: { [key]: template }, ...(tries === undefined ? {} : { rerunFilesTries: tries }), ...(timeoutMs === undefined ? {} : { checkTimeoutMs: timeoutMs }) });
  const git = (name: string) => join(ws.root, '.git', name);
  writeFileSync(git('out.txt'), output);
  writeFileSync(
    git('check.sh'),
    `echo run >> .git/check-runs\nif [ ${checkPassesFrom} -gt 0 ] && [ "$(wc -l < .git/check-runs)" -ge ${checkPassesFrom} ]; then exit 0; fi\ncat .git/out.txt\nexit 1\n`,
  );
  writeFileSync(
    git('targeted.sh'),
    `printf '%s\\n' "$@" > .git/targeted-args\necho T >> .git/targeted-runs\nsleep ${targetedSleep}\nif [ ${targetedPassesFrom} -gt 0 ] && [ "$(wc -l < .git/targeted-runs)" -ge ${targetedPassesFrom} ]; then exit 0; fi\necho TARGETED-OUTPUT\nexit 1\n`,
  );
  await newRun(ws, [slice('Feature')]);
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 'work.txt');
  const lines = (name: string) => (existsSync(git(name)) ? readFileSync(git(name), 'utf8').split('\n').filter(Boolean) : []);
  return { ws, checkRuns: () => lines('check-runs'), targetedRuns: () => lines('targeted-runs').length, targetedArgs: () => lines('targeted-args') };
}

const summaryOf = (summary: string[]) => summary.join('\n');

describe('factory_checks targeted rerun of failed test files', () => {
  it('runs only the parsed files, then the full check once, and reports the pinned summary', async () => {
    const t = await setup();
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.deepEqual(t.targetedArgs(), ['test/a.test.ts', 'test/b.test.ts']);
    assert.equal(t.targetedRuns(), 1);
    assert.equal(t.checkRuns().length, 2);
    assert.ok(!('fixPath' in result) || result.fixPath === undefined);
    assert.match(summaryOf(result.summary), /^sh \.git\/check\.sh: passed on rerun, flaky \(first failed \(exit 1\) in \d+ms; last stdout line: FAIL test\/b\.test\.ts \(1 s\); failed test files passed on targeted try 1 of 3: test\/a\.test\.ts, test\/b\.test\.ts\)$/);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0);
  });

  it('passes node:test files whose path holds a space as one argument, each file once', async () => {
    const output = '✖ failing tests:\n\ntest at test/my dir/b.test.ts:5:1\n✖ beta works (0.5ms)\n\ntest at test/my dir/b.test.ts:9:1\n✖ gamma works (0.5ms)\n';
    const t = await setup({ output });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.deepEqual(t.targetedArgs(), ['test/my dir/b.test.ts']);
  });

  it('passes files in first-seen order when node:test entries and FAIL lines are mixed', async () => {
    const output = '✖ failing tests:\n\ntest at test/a.test.ts:5:1\n✖ alpha (1ms)\n\nFAIL test/b.test.ts\n';
    const t = await setup({ output });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.deepEqual(t.targetedArgs(), ['test/a.test.ts', 'test/b.test.ts']);
  });

  it('drops a file that starts with a dash and a spec location without a line suffix', async () => {
    const output = 'FAIL --reporter=x\nFAIL test/a.test.ts\n✖ failing tests:\n\ntest at somewhere\n✖ beta (1ms)\n';
    const t = await setup({ output });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.deepEqual(t.targetedArgs(), ['test/a.test.ts']);
  });

  it('gives no file for a FAIL line longer than 2000 characters, so one whole-command rerun decides', async () => {
    const t = await setup({ output: `FAIL ${'x'.repeat(2_100)}\n` });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(t.targetedRuns(), 0);
    assert.doesNotMatch(summaryOf(result.summary), /targeted/);
  });

  for (const [template, exactArgs] of [['sh .git/targeted.sh {files}', true], ['sh .git/targeted.sh "{files}"', false]] as const) {
    it(`runs no shell syntax of a parsed file with the template ${template}`, async () => {
      const t = await setup({ template, output: 'FAIL test/$(touch pwned).test.ts\nFAIL test/it\'s.test.ts\nFAIL test/a;b`c`.test.ts\n' });
      using ws = t.ws;
      assert.ok((await step(ws, run => runChecks(ws, run))).passed);
      if (exactArgs) assert.deepEqual(t.targetedArgs(), ['test/$(touch pwned).test.ts', "test/it's.test.ts", 'test/a;b`c`.test.ts']);
      assert.equal(existsSync(join(ws.root, 'pwned')), false);
      assert.equal(existsSync(join(ws.root, '.git', 'pwned')), false);
    });
  }

  it('takes the FAIL path up to the first " > ", " (", " [" or the line end', async () => {
    const output = 'FAIL test/my dir/b.test.ts > s\nFAIL  test/c.test.ts [ test/c.test.ts ]\nFAIL test/d.test.ts [chromium]\nFAIL app/[id]/page.test.ts\n';
    const t = await setup({ output });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.deepEqual(t.targetedArgs(), ['test/my dir/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'app/[id]/page.test.ts']);
  });

  it('names the targeted try that passed when an earlier try failed', async () => {
    const t = await setup({ targetedPassesFrom: 2 });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(t.targetedRuns(), 2);
    assert.match(summaryOf(result.summary), /failed test files passed on targeted try 2 of 3: /);
  });

  it('fails the check when the full run after a passing targeted run fails, with no further whole-command rerun', async () => {
    const t = await setup({ checkPassesFrom: 0, output: VITEST_OUTPUT });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.equal(t.checkRuns().length, 2);
    assert.equal(t.targetedRuns(), 1);
    assert.match(summaryOf(result.summary), /^sh \.git\/check\.sh: failed \(exit 1\) in \d+ms on rerun \(first failed \(exit 1\) in \d+ms; failed test files passed on targeted try 1 of 3: test\/a\.test\.ts, test\/b\.test\.ts\)$/);
    const fix = readFileSync(result.fixPath, 'utf8');
    assert.match(fix, /### stdout\n\n```\n[^`]*FAIL test\/b\.test\.ts/);
    assert.doesNotMatch(fix, /TARGETED-OUTPUT/);
  });

  it('runs the targeted command at most rerunFilesTries times, then one whole-command rerun with today\'s summary', async () => {
    const t = await setup({ targetedPassesFrom: 0, tries: 2 });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(t.targetedRuns(), 2);
    assert.equal(t.checkRuns().length, 2);
    assert.match(summaryOf(result.summary), /^sh \.git\/check\.sh: passed on rerun, flaky \(first failed \(exit 1\) in \d+ms; last stdout line: FAIL test\/b\.test\.ts \(1 s\)\)$/);
  });

  it('keeps today\'s failing summary when the targeted runs fail and the whole-command rerun fails', async () => {
    const t = await setup({ targetedPassesFrom: 0, tries: 2, checkPassesFrom: 0 });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.equal(t.checkRuns().length, 2);
    assert.match(summaryOf(result.summary), /^sh \.git\/check\.sh: failed \(exit 1\) in \d+ms on rerun \(first failed \(exit 1\) in \d+ms\)$/);
  });

  it('ends the targeted runs at a timeout, and one whole-command rerun decides', async () => {
    const t = await setup({ targetedSleep: 5, targetedPassesFrom: 0, timeoutMs: 1_000 });
    using ws = t.ws;
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(result.passed);
    assert.equal(t.targetedRuns(), 1);
    assert.equal(t.checkRuns().length, 2);
    assert.doesNotMatch(summaryOf(result.summary), /targeted/);
  });

  for (const [name, options] of [
    ['has no template', { template: 'sh .git/targeted.sh {files}', key: 'other check' }],
    ['names no file', { output: 'not ok 1 - x\n' }],
  ] as const) {
    it(`runs no targeted command when the check ${name}, and keeps today's summary`, async () => {
      const t = await setup(options);
      using ws = t.ws;
      const result = await step(ws, run => runChecks(ws, run));
      assert.ok(result.passed);
      assert.equal(t.targetedRuns(), 0);
      assert.equal(t.checkRuns().length, 2);
      assert.doesNotMatch(summaryOf(result.summary), /targeted/);
    });
  }

  it('matches a template key to its check after trimming both', async () => {
    const t = await setup({ key: `  ${CHECK} ` });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    assert.equal(t.targetedRuns(), 1);
  });

  it('keeps the first attempt log and puts the targeted output in no log file', async () => {
    const t = await setup({ targetedPassesFrom: 2 });
    using ws = t.ws;
    assert.ok((await step(ws, run => runChecks(ws, run))).passed);
    const dir = join(runDir(ws, 'demo'), 'checks');
    assert.deepEqual(readdirSync(dir), ['01-f0-check1-attempt1.log']);
    const log = readFileSync(join(dir, '01-f0-check1-attempt1.log'), 'utf8');
    assert.match(log, /FAIL test\/b\.test\.ts \(1 s\)/);
    assert.doesNotMatch(log, /TARGETED-OUTPUT/);
  });
});
