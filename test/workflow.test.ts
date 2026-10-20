import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { FactoryConfig } from '../src/config.ts';
import { type Finding, forgetRun, readRun, REVIEW_DOMAINS, type SliceInput, type Workspace, withRun } from '../src/run.ts';
import {
  applyReslice,
  approvePlan,
  completeSlice,
  nextAction,
  nextSlice,
  parseRetro,
  pauseRun,
  planReslice,
  planSlices,
  recordRetro,
  recordReview,
  resolveStall,
  resumeRun,
  REVIEW_REFERENCE_DIR,
  runChecks,
  startReview,
  startRun,
  submitDomain,
  submitStack,
  submitValidation,
} from '../src/workflow.ts';

// Tests never read the developer's git config (signing, hooks, default branch).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
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

function finding(domain: Finding['domain'], severity: Finding['severity'], name: string): Finding {
  return { domain, fix: 'fix it', fix_prompt: 'fix it', id: `${domain}-${name}`, line: 1, path: 'ok', problem: 'wrong', severity, title: name };
}

async function newRun(ws: Workspace, inputs: SliceInput[]) {
  await startRun(ws, {
    feature: 'demo',
    sessionId: 'session-1',
    source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' },
  });
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, inputs)));
}

const step = <T>(ws: Workspace, mutate: Parameters<typeof withRun<T>>[2]) => withRun(ws, 'demo', mutate);

/** Every domain submits (the given findings under their domains, the rest empty), then the validator keeps `keep`. */
async function review(ws: Workspace, reviewId: string, findings: Finding[], keep = findings.map(item => item.id)) {
  for (const domain of REVIEW_DOMAINS) {
    await step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: findings.filter(item => item.domain === domain), reviewId }));
  }
  const dropped = findings.filter(item => !keep.includes(item.id)).map(item => ({ id: item.id, reason: 'not in diff' }));
  await step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
}

/** Takes the active slice from committed work to green. */
async function green(ws: Workspace) {
  await step(ws, run => runChecks(ws, run));
  const { reviewId } = await step(ws, run => startReview(ws, run));
  await review(ws, reviewId, []);
  return step(ws, run => recordReview(ws, run));
}

describe('planSlices', () => {
  it('orders slices blockers first into one linear stack', async () => {
    const ws = workspace();
    await startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    const slices = planSlices(ws, readRun(ws, 'demo'), [slice('UI', ['API']), slice('API', ['Schema']), slice('Schema')]);
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
    assert.equal(planSlices(ws, run, [slice('A', [], { estimateTokens: 1_000 })]).length, 1);
    assert.throws(() => planSlices(ws, run, [slice('A', [], { seams: [] })]), /needs test seams/);
    assert.equal(planSlices(ws, run, [slice('Docs', [], { noTestReason: 'docs only', seams: [] })]).length, 1);
  });
});

describe('slice loop gates', () => {
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
    await review(ws, second.reviewId, [finding('thermo', 'observation', 'naming')]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.green);
    assert.equal(result.observations.length, 1);

    const done = await step(ws, run => completeSlice(ws, run));
    assert.equal(done.status, 'done');
    assert.match(nextAction(readRun(ws, 'demo')), /retro/);
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

  it('fails checks that leave the working tree changed', async () => {
    const ws = workspace({ checks: ['touch ok stray.txt'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const result = await step(ws, run => runChecks(ws, run));
    assert.ok(!result.passed);
    assert.match(readFileSync(result.fixPath, 'utf8'), /Checks changed the working tree[\s\S]*stray\.txt/);
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

  it('stalls when the fix budget is used, and each continue grants maxRounds more fixes', async () => {
    const ws = workspace({ maxRounds: 1 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');

    const failChecks = () => step(ws, run => runChecks(ws, run));
    assert.ok(!(await failChecks()).passed);
    const stalled = await failChecks();
    assert.ok(!stalled.passed && stalled.stalled);
    await assert.rejects(failChecks(), /stalled/);

    await step(ws, run => resolveStall(ws, run, 'pause'));
    assert.equal(readRun(ws, 'demo').status, 'stalled');
    await step(ws, run => resolveStall(ws, run, 'continue'));
    assert.equal(readRun(ws, 'demo').status, 'running');
    const again = await failChecks();
    assert.ok(!again.passed && again.stalled, 'the continue round is used by the first failure after it');
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
      assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks', change);
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
});

describe('review submissions', () => {
  async function openReview() {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    return { ws, ...opened };
  }

  it('checks domain and id prefix separately, and lets the validator only select', async () => {
    const { findingsDir, reviewId, ws } = await openReview();
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId }));

    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), domain: 'security' }]), /must have domain "bug"/);
    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), id: 'security-x' }]), /id starting "bug-"/);
    for (const domain of REVIEW_DOMAINS) {
      await submit(domain, domain === 'bug' ? [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')] : []);
    }
    await assert.rejects(submit('bug', []), /already submitted/);
    assert.equal(JSON.parse(readFileSync(join(findingsDir, 'bug.json'), 'utf8')).length, 2);

    const validate = (keep: string[], dropped: { id: string; reason: string }[] = []) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
    await assert.rejects(validate(['bug-a', 'bug-invented']), /Unknown finding ids: bug-invented/);
    await assert.rejects(validate(['bug-a']), /Undecided: bug-b/);
    await validate(['bug-a'], [{ id: 'bug-b', reason: 'not in diff' }]);
    await assert.rejects(validate(['bug-a'], [{ id: 'bug-b', reason: 'again' }]), /already validated/);

    const result = await step(ws, run => recordReview(ws, run));
    assert.equal(result.green ? 0 : result.blocking, 1);
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

describe('re-slice', () => {
  it('replaces the active slice with children on its branch and remaps later blockers', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Big'), slice('After', ['Big'])]);
    const big = await step(ws, run => nextSlice(ws, run));
    commit(ws, 'partial.txt');

    const first = await step(ws, async run => applyReslice(ws, run, planReslice(ws, run, [slice('Big part two', ['Big part one']), slice('Big part one')]).slices));
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

  it('gives the first child a new review id, so old review files never count', async () => {
    const ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Big')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const old = await step(ws, run => startReview(ws, run));
    await review(ws, old.reviewId, []);

    await step(ws, run => applyReslice(ws, run, planReslice(ws, run, [slice('Part one'), slice('Part two', ['Part one'])]).slices));
    await step(ws, run => runChecks(ws, run));
    const fresh = await step(ws, run => startReview(ws, run));
    assert.notEqual(fresh.reviewId, old.reviewId);
    await assert.rejects(step(ws, run => recordReview(ws, run)), /Domains not submitted yet/);
  });

  it('leaves the run and its tickets unchanged when the branch rename fails', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Big')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'partial.txt');
    sh(ws.root, 'branch', 'factory/demo/01-part-one');

    const before = readFileSync(join(ws.root, '.scratch', 'demo', 'state.json'), 'utf8');
    await assert.rejects(step(ws, run => applyReslice(ws, run, planReslice(ws, run, [slice('Part one')]).slices)));
    assert.equal(readFileSync(join(ws.root, '.scratch', 'demo', 'state.json'), 'utf8'), before);
    assert.ok(existsSync(join(ws.root, '.scratch', 'demo', 'issues', '01-big.md')));
  });
});

describe('pause and resume', () => {
  it('pauses only a running run and resumes it to running', async () => {
    const ws = workspace();
    await startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    await assert.rejects(step(ws, run => pauseRun(run, 'test')), /intake; only a running run pauses/);

    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await step(ws, run => pauseRun(run, 'test'));
    await step(ws, run => resumeRun(ws, run, 'session-2'));
    const run = readRun(ws, 'demo');
    assert.deepEqual([run.status, run.ownerSessionId], ['running', 'session-2']);
  });

  it('sends a reviewed slice back to checks on resume', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => pauseRun(run, 'test'));

    forgetRun(ws, 'demo');
    await step(ws, run => resumeRun(ws, run, 'session-2'));
    const resumed = readRun(ws, 'demo').slices[0];
    assert.deepEqual([resumed?.phase, resumed?.greenSha], ['checks', undefined]);
  });
});

describe('retro', () => {
  it('rejects misrouted actions, sorts by severity, and marks the stack ready once recorded', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));

    await step(ws, run => {
      assert.throws(
        () => parseRetro(run, [{ action: 'apply', category: 'tool-economy', detail: 'd', severity: 'low', target: 'factory', title: 't' }]),
        /only repo findings can be applied/,
      );
      const retro = parseRetro(run, [
        { action: 'skip', category: 'no-ops', detail: 'minor', severity: 'low', target: 'repo', title: 'Low one' },
        { action: 'skip', category: 'navigation', detail: 'big', severity: 'high', target: 'repo', title: 'High repo' },
        { action: 'file-issue', category: 'tool-economy', detail: 'big', severity: 'high', target: 'factory', title: 'High one' },
      ]);
      assert.deepEqual(
        retro.findings.map(item => item.title),
        ['High repo', 'High one', 'Low one'],
      );
      recordRetro(ws, run, retro, { error: 'offline', urls: {} });
    });
    assert.equal(readRun(ws, 'demo').status, 'done');
    const text = readFileSync(join(ws.root, '.scratch', 'demo', 'retro.md'), 'utf8');
    const repo = text.indexOf('## Target repository');
    const factory = text.indexOf('## Software factory');
    assert.ok(repo < text.indexOf('Low one') && text.indexOf('Low one') < factory);
    assert.ok(factory < text.indexOf('High one'));
    assert.match(text, /High one[\s\S]*Not filed: offline/);
  });

  it('adds apply findings as a final slice blocked by every slice, so the run is not ready yet', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));

    const added = await step(ws, run =>
      recordRetro(ws, run, parseRetro(run, [{ action: 'apply', category: 'automated-checks', detail: 'Add a lint rule', severity: 'high', target: 'repo', title: 'Lint rule' }])),
    );
    const run = readRun(ws, 'demo');
    assert.deepEqual([added?.blockedBy, run.status], [['Feature'], 'running']);
  });
});

describe('submit', () => {
  it('refuses to submit a branch that moved after its green review', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const started = await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(run, [])));

    commit(ws, 'unreviewed.txt');
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`moved after their green review.*${started?.branch}`));
  });
});

describe('run state', () => {
  it('fails closed on a state file that does not match the schema', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    forgetRun(ws, 'demo');
    const path = join(ws.root, '.scratch', 'demo', 'state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"phase": "implement"', '"phase": "shipped"'));
    assert.throws(() => readRun(ws, 'demo'), /Corrupt factory state/);
  });

  it('rejects a state file edited outside the factory tools in this process', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const path = join(ws.root, '.scratch', 'demo', 'state.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"phase": "implement"', '"phase": "ready"'));
    assert.throws(() => readRun(ws, 'demo'), /changed outside the factory tools/);
  });

  it('saves nothing when a mutation fails', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await assert.rejects(
      step(ws, run => {
        run.status = 'done';
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(readRun(ws, 'demo').status, 'running');
  });

  it('keeps run state out of git', async () => {
    const ws = workspace();
    await newRun(ws, [slice('Feature')]);
    assert.equal(sh(ws.root, 'status', '--porcelain'), '');
  });
});

describe('review references', () => {
  it('ships one reference per review domain', () => {
    const missing = REVIEW_DOMAINS.filter(domain => !existsSync(join(REVIEW_REFERENCE_DIR, `${domain}.md`)));
    assert.deepEqual(missing, []);
  });
});
