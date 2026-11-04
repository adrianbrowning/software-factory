import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import type { FactoryConfig } from '../src/config.ts';
import { type Finding, readRun, REVIEW_DOMAINS, type SliceInput, type Workspace, withRun } from '../src/run.ts';
import { recordReview, runChecks, startReview, submitDomain, submitValidation } from '../src/review.ts';
import { approvePlan, planSlices, startRun } from '../src/workflow.ts';

// Tests never read the developer's git config (signing, hooks, default branch).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

export function sh(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Turns `root` into a git repository on `main` whose base commit holds `files` (path → content). */
export function initRepo(root: string, files: Record<string, string>) {
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  return root;
}

/** A temp git repository with a base commit of `files`, removed when the `using` scope that holds it ends. */
export function tempRepo(prefix: string, files: Record<string, string>) {
  const root = initRepo(realpathSync(mkdtempSync(join(tmpdir(), prefix))), files);
  return { root, [Symbol.dispose]: () => rmSync(root, { force: true, recursive: true }) };
}

/** Temp directories removed when the test file ends. */
export const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

/** A workspace on a temp repository, removed when the `using` scope that holds it ends, or else when the test file ends. */
export function workspace(overrides: Partial<FactoryConfig> = {}): Workspace & Disposable {
  const root = initRepo(mkdtempSync(join(tmpdir(), 'factory-')), { 'README.md': 'base\n' });
  roots.push(root);
  return {
    [Symbol.dispose]: () => rmSync(root, { force: true, recursive: true }),
    config: {
      baseRef: 'main',
      branchPrefix: 'factory',
      // Passes only when the slice has committed a file named `ok`.
      checks: ['test -f ok'],
      checkPath: [],
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

/** A check command that runs `guard` first, when given, and appends `label` to .git/check-runs (outside the working tree). */
export function countedCheck(label = 'run', guard = '') {
  return `${guard === '' ? '' : `${guard} && `}echo ${label} >> .git/check-runs`;
}

/** The labels counted checks logged, in run order. */
export function checkRuns(ws: Workspace) {
  return readFileSync(join(ws.root, '.git', 'check-runs'), 'utf8').split('\n').filter(Boolean);
}

export function slice(title: string, blockedBy: string[] = [], extra: Partial<SliceInput> = {}): SliceInput {
  return { acceptance: [`${title} works`], blockedBy, estimateTokens: 500, seams: ['cli'], title, whatToBuild: title, ...extra };
}

export function commit(ws: Workspace, file: string, content = 'x\n') {
  writeFileSync(join(ws.root, file), content);
  sh(ws.root, 'add', file);
  sh(ws.root, 'commit', '-qm', `add ${file}`);
}

export function finding(domain: Finding['domain'], severity: Finding['severity'], name: string): Finding {
  return { domain, fix: 'fix it', fix_prompt: 'fix it', id: `${domain}-${name}`, line: 1, path: 'ok', problem: 'wrong', severity, title: name };
}

export function start(ws: Workspace) {
  return startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
}

export async function newRun(ws: Workspace, inputs: SliceInput[]) {
  await startRun(ws, {
    feature: 'demo',
    sessionId: 'session-1',
    source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' },
  });
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, inputs)));
}

export const step = <T>(ws: Workspace, mutate: Parameters<typeof withRun<T>>[2]) => withRun(ws, 'demo', mutate);

/** Every reviewed domain submits (the given findings under their domains, the rest empty), then the validator keeps `keep`. */
export async function review(ws: Workspace, reviewId: string, findings: Finding[], keep = findings.map(item => item.id)) {
  const skipped = readRun(ws, 'demo').slices.find(item => item.review?.id === reviewId)?.review?.skipped ?? [];
  for (const domain of REVIEW_DOMAINS.filter(name => !skipped.some(entry => entry.domain === name))) {
    await step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: findings.filter(item => item.domain === domain), reviewId }));
  }
  const dropped = findings.filter(item => !keep.includes(item.id)).map(item => ({ id: item.id, reason: 'not in diff' }));
  await step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
}

/** Takes the active slice from committed work to green. */
export async function green(ws: Workspace) {
  await step(ws, run => runChecks(ws, run));
  const { reviewId } = await step(ws, run => startReview(ws, run));
  await review(ws, reviewId, []);
  return step(ws, run => recordReview(ws, run));
}
