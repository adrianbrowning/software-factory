import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { FactoryConfig } from '../src/config.ts';
import { evidence } from '../src/evidence.ts';
import { type Finding, readRun, REVIEW_DOMAINS, type Run, type SliceInput, type Workspace, withRun } from '../src/run.ts';
import {
  applyReslice,
  completeSlice,
  nextAction,
  nextSlice,
  approvePlan,
  planReslice,
  planSlices,
  parseRetro,
  recordRetro,
  recordReview,
  resolveStall,
  REVIEW_REFERENCE_DIR,
  runChecks,
  settle,
  startReview,
  startRun,
  submitDomain,
  submitValidation,
} from '../src/workflow.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) execFileSync('rm', ['-rf', root]);
});

function sh(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function workspace(overrides: Partial<FactoryConfig> = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'factory-'));
  roots.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), 'base\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  return {
    config: {
      baseRef: 'main',
      branchPrefix: 'factory',
      // Passes only when the slice has committed a file named `ok`.
      checks: ['test -f ok'],
      checkTimeoutMs: 10_000,
      factoryRepo: 'acme/factory',
      maxRounds: 1,
      scratchDir: '.scratch',
      sliceTokenBudget: 1_000,
      trunk: 'main',
      ...overrides,
    },
    root,
  };
}

function slice(title: string, blockedBy: string[] = [], extra: Partial<SliceInput> = {}): SliceInput {
  return { acceptance: [`${title} works`], blockedBy, estimateTokens: 500, seams: ['cli'], title, whatToBuild: title, ...extra };
}

function commit(ws: Workspace, file: string, content = 'x\n') {
  writeFileSync(join(ws.root, file), content);
  sh(ws.root, 'add', file);
  sh(ws.root, 'commit', '-qm', `add ${file}`);
}

function finding(domain: string, severity: Finding['severity'], name: string): Finding {
  return { domain: domain as Finding['domain'], fix: 'fix it', fix_prompt: 'fix it', id: `${domain}-${name}`, line: 1, path: 'ok', problem: 'wrong', severity, title: name };
}

async function newRun(ws: Workspace, inputs: SliceInput[]) {
  await startRun(ws, {
    feature: 'demo',
    sessionId: 'session-1',
    source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' },
  });
  return withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, inputs)));
}

/** Submits every domain (the given findings under their domains, the rest empty) and validates keeping `keep`. */
function review(ws: Workspace, run: Run, reviewId: string, findings: Finding[], keep = findings.map(item => item.id)) {
  for (const domain of REVIEW_DOMAINS) {
    submitDomain(ws, run, { domain, findings: findings.filter(item => item.domain === domain), reviewId });
  }
  const dropped = findings.filter(item => !keep.includes(item.id)).map(item => ({ id: item.id, reason: 'not in diff' }));
  submitValidation(ws, run, { dropped, keep, reviewId });
}

describe('planSlices', () => {
  it('orders slices blockers first into one linear stack', async () => {
    const ws = workspace();
    await startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    const run = readRun(ws, 'demo');
    const slices = planSlices(ws, run, [slice('UI', ['API']), slice('API', ['Schema']), slice('Schema')]);
    assert.deepEqual(
      slices.map(item => [item.id, item.title, item.parentBranch]),
      [
        ['01', 'Schema', 'main'],
        ['02', 'API', 'factory/demo/01-schema'],
        ['03', 'UI', 'factory/demo/02-api'],
      ],
    );
  });

  it('rejects cycles, unknown blockers, oversized slices, and slices without seams or a reason', async () => {
    const ws = workspace();
    await startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    const run = readRun(ws, 'demo');
    assert.throws(() => planSlices(ws, run, [slice('A', ['B']), slice('B', ['A'])]), /cycle/);
    assert.throws(() => planSlices(ws, run, [slice('A', ['Missing'])]), /unknown slice "Missing"/);
    assert.throws(() => planSlices(ws, run, [slice('A', [], { estimateTokens: 1_001 })]), /split it to fit 1000/);
    assert.throws(() => planSlices(ws, run, [slice('A', [], { seams: [] })]), /needs test seams/);
    assert.equal(planSlices(ws, run, [slice('Docs', [], { noTestReason: 'docs only', seams: [] })]).length, 1);
  });
});

describe('slice loop gates', () => {
  it('takes a slice from red checks through a blocking review to done', async () => {
    const ws = workspace({ maxRounds: 2 });
    await newRun(ws, [slice('Feature')]);

    const started = await withRun(ws, 'demo', run => nextSlice(ws, run));
    assert.equal(sh(ws.root, 'branch', '--show-current'), started?.branch);

    commit(ws, 'work.txt');
    const red = await withRun(ws, 'demo', run => runChecks(ws, run));
    assert.equal(red.passed, false);
    assert.match(readFileSync(red.passed ? '' : red.fixPath, 'utf8'), /test -f ok: failed \(exit 1\)/);
    await assert.rejects(withRun(ws, 'demo', run => startReview(ws, run)), /Checks must pass first/);

    commit(ws, 'ok');
    assert.equal((await withRun(ws, 'demo', run => runChecks(ws, run))).passed, true);
    const first = await withRun(ws, 'demo', run => startReview(ws, run));
    assert.match(readFileSync(first.dataFile, 'utf8'), /## DIFF[\s\S]*\+x/);

    await assert.rejects(withRun(ws, 'demo', run => recordReview(ws, run)), /Domains not submitted yet: security/);
    const run = readRun(ws, 'demo');
    review(ws, run, first.reviewId, [finding('bug', 'high', 'null-crash'), finding('thermo', 'observation', 'naming')]);
    const blocked = await withRun(ws, 'demo', current => recordReview(ws, current));
    assert.equal(blocked.green, false);
    assert.match(readFileSync(blocked.green ? '' : blocked.fixPath, 'utf8'), /\[high\] bug-null-crash/);

    commit(ws, 'ok', 'fixed\n');
    assert.equal((await withRun(ws, 'demo', current => runChecks(ws, current))).passed, true);
    const second = await withRun(ws, 'demo', current => startReview(ws, current));
    review(ws, readRun(ws, 'demo'), second.reviewId, [finding('thermo', 'observation', 'naming')]);
    const green = await withRun(ws, 'demo', current => recordReview(ws, current));
    assert.deepEqual(green.green && green.observations.length, 1);

    const done = await withRun(ws, 'demo', current => completeSlice(ws, current));
    assert.equal(done.status, 'done');
    assert.match(nextAction(readRun(ws, 'demo')), /retro/);
  });

  it('stalls when the fix budget is used and continues only by user choice', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'work.txt');

    assert.equal((await withRun(ws, 'demo', run => runChecks(ws, run))).passed ? 'pass' : 'fail', 'fail');
    const second = await withRun(ws, 'demo', run => runChecks(ws, run));
    assert.equal(!second.passed && second.stalled, true);
    await assert.rejects(withRun(ws, 'demo', run => runChecks(ws, run)), /stalled/);

    await withRun(ws, 'demo', run => resolveStall(ws, run, 'pause'));
    assert.equal(readRun(ws, 'demo').status, 'stalled');
    await withRun(ws, 'demo', run => resolveStall(ws, run, 'continue'));
    const resumed = readRun(ws, 'demo');
    assert.deepEqual([resumed.status, resumed.slices[0]?.stalled, resumed.slices[0]?.roundLimit], ['running', false, 2]);
  });

  it('invalidates a review when the repository changes during it', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const opened = await withRun(ws, 'demo', run => startReview(ws, run));
    review(ws, readRun(ws, 'demo'), opened.reviewId, []);

    writeFileSync(join(ws.root, 'stray.txt'), 'reviewer edit\n');
    await assert.rejects(withRun(ws, 'demo', run => recordReview(ws, run)), /changed during review/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks');
  });

  it('refuses to complete a slice whose HEAD moved after the green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const opened = await withRun(ws, 'demo', run => startReview(ws, run));
    review(ws, readRun(ws, 'demo'), opened.reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));

    commit(ws, 'late.txt');
    await assert.rejects(withRun(ws, 'demo', run => completeSlice(ws, run)), /HEAD moved after the green review/);
  });
});

describe('review submissions', () => {
  it('lets the validator only select from submitted findings', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { findingsDir, reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    const run = readRun(ws, 'demo');

    assert.throws(
      () => submitDomain(ws, run, { domain: 'bug', findings: [finding('security', 'high', 'x')], reviewId }),
      /must have domain "bug"/,
    );
    for (const domain of REVIEW_DOMAINS) {
      submitDomain(ws, run, { domain, findings: domain === 'bug' ? [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')] : [], reviewId });
    }
    assert.throws(() => submitValidation(ws, run, { dropped: [], keep: ['bug-a', 'bug-invented'], reviewId }), /Unknown finding ids: bug-invented/);
    assert.throws(() => submitValidation(ws, run, { dropped: [], keep: ['bug-a'], reviewId }), /Undecided: bug-b/);
    assert.equal(JSON.parse(readFileSync(join(findingsDir, 'bug.json'), 'utf8')).length, 2);
    submitValidation(ws, run, { dropped: [{ id: 'bug-b', reason: 'not in diff' }], keep: ['bug-a'], reviewId });

    const result = await withRun(ws, 'demo', current => recordReview(ws, current));
    assert.equal(result.green ? 0 : result.blocking, 1);
  });
});

describe('re-slice', () => {
  it('replaces the active slice with children on its branch and remaps later blockers', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Big'), slice('After', ['Big'])]);
    const big = await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'partial.txt');

    const first = await withRun(ws, 'demo', async run => {
      const { slices } = planReslice(ws, run, [slice('Big part two', ['Big part one']), slice('Big part one')]);
      return applyReslice(ws, run, slices);
    });
    const run = readRun(ws, 'demo');
    assert.deepEqual(
      run.slices.map(item => [item.id, item.title, item.status, item.blockedBy.join('+')]),
      [
        ['01', 'Big part one', 'active', ''],
        ['02', 'Big part two', 'pending', 'Big part one'],
        ['03', 'After', 'pending', 'Big part one+Big part two'],
      ],
    );
    assert.equal(sh(ws.root, 'branch', '--show-current'), first.branch);
    assert.match(sh(ws.root, 'log', '--oneline', '-1'), /add partial.txt/);
    assert.equal(sh(ws.root, 'branch', '--list', big?.branch ?? ''), '');
  });
});

describe('retro', () => {
  it('rejects misrouted actions and marks the stack ready once the retro is recorded', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    review(ws, readRun(ws, 'demo'), reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));

    await withRun(ws, 'demo', run => {
      assert.throws(
        () => parseRetro(run, [{ action: 'apply', category: 'tool-economy', detail: 'd', severity: 'low', target: 'factory', title: 't' }]),
        /only repo findings can be applied/,
      );
      const { findings } = parseRetro(run, [
        { action: 'skip', category: 'no-ops', detail: 'minor', severity: 'low', target: 'repo', title: 'Low one' },
        { action: 'file-issue', category: 'tool-economy', detail: 'big', severity: 'high', target: 'factory', title: 'High one' },
      ]);
      recordRetro(ws, run, findings);
      settle(run);
    });
    assert.equal(readRun(ws, 'demo').status, 'done');
    const retro = readFileSync(join(ws.root, '.scratch', 'demo', 'retro.md'), 'utf8');
    assert.ok(retro.indexOf('## Target repository') < retro.indexOf('## Software factory'));
  });
});

describe('run state', () => {
  it('fails closed on a state file that does not match the schema', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const path = join(ws.root, '.scratch', 'demo', 'state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"phase": "implement"', '"phase": "shipped"'));
    assert.throws(() => readRun(ws, 'demo'), /Corrupt factory state/);
  });

  it('keeps run state out of git', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    assert.equal(sh(ws.root, 'status', '--porcelain'), '');
  });
});

describe('evidence', () => {
  it('redacts credentials and keeps the tail of long output', () => {
    const redacted = evidence(`GITHUB_TOKEN=ghp_${'a'.repeat(36)} Authorization: Bearer abc.def`);
    assert.doesNotMatch(redacted, /ghp_|abc\.def/);
    assert.equal(evidence('xxxxxxxxxxEND', 5), '...[truncated]\nxxEND');
  });
});

describe('review references', () => {
  it('ships one reference per review domain', () => {
    const missing = REVIEW_DOMAINS.filter(domain => !existsSync(join(REVIEW_REFERENCE_DIR, `${domain}.md`)));
    assert.deepEqual(missing, []);
  });
});
