// Setup helper for scripts/smoke-known-observations.sh (not part of `pnpm run test`).
// Builds a throwaway repo whose slice 01 left one thermo observation (greet.ts:1) and whose slice 02 changes the same
// line; slice 02 has passing checks and no review open (the omp session opens it, as a resumed review is discarded).
// Prints the repo root and the repeat finding (the same location and problem under a new id) as JSON.
// Usage: node scripts/smoke-known-observations-setup.ts <empty repo dir> <model>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { recordReview, runChecks, startReview, submitDomain, submitValidation, completeSlice } from '../src/review.ts';
import { readRun, REVIEW_DOMAINS, withRun } from '../src/run.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { leaveObservations } from '../src/observations.ts';
import { ctx, load } from '../test/extension.ts';

const [root, model] = process.argv.slice(2);
if (root === undefined || model === undefined) throw new Error('Usage: smoke-known-observations-setup.ts <repo dir> <model>');

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main');
mkdirSync(join(root, '.omp'));
writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { reviewer: { model }, validator: { model } } }));
git('add', '.');
git('commit', '-qm', 'base');

const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, models: { resolve: () => ({}) }, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
await load().get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Add greetings', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, main);
const ws = { config: loadConfig(root), root };
const s = (title: string, blockedBy: string[]) => ({ acceptance: [`${title} works`], blockedBy, estimateTokens: 500, noTestReason: 'smoke: nothing to test', seams: [], title, whatToBuild: title });
await withRun(ws, 'demo', (run: any) => approvePlan(ws, run, planSlices(ws, run, [s('Greeting', []), s('Loud greeting', ['Greeting'])])));

const problem = "The exported function name `f` does not say what it does: a reader of a call site cannot tell that it returns a greeting.";
const thermo = (id: string, title: string) => ({ category: 'naming', domain: 'thermo', fix: 'Rename f to greet.', fix_prompt: 'Rename f to greet in greet.ts and its callers.', id, line: 1, path: 'greet.ts', problem, severity: 'observation', title });

async function reviewWith(findings: any[], validate: boolean) {
  await withRun(ws, 'demo', (run: any) => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', (run: any) => startReview(ws, run));
  const reviewed = readRun(ws, 'demo').slices.find((x: any) => x.review?.id === reviewId);
  const skipped = reviewed.review.skipped.map((x: any) => x.domain);
  const domains = REVIEW_DOMAINS.filter((d: string) => !skipped.includes(d));
  for (const domain of domains) {
    await withRun(ws, 'demo', (run: any) => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: findings.filter(f => f.domain === domain), reviewId, ...(domain === 'scope' ? { fixItems: [] } : {}) }));
  }
  if (validate) await withRun(ws, 'demo', (run: any) => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep: findings.map(f => f.id), reviewId }));
  return reviewId;
}

// Slice 01: f in greet.ts, green with the naming observation, which the user leaves.
await withRun(ws, 'demo', (run: any) => nextSlice(ws, run));
writeFileSync(join(root, 'ok'), 'x\n');
writeFileSync(join(root, 'greet.ts'), "export const f = (name: string) => `hello ${name}`;\n");
git('add', '.');
git('commit', '-qm', 'add f');
await reviewWith([thermo('thermo-unclear-name', 'f is an unclear name')], true);
console.error('slice 01 review:', (await withRun(ws, 'demo', (run: any) => recordReview(ws, run))).kind);
await withRun(ws, 'demo', (run: any) => leaveObservations(ws, run, { observations: ['thermo-unclear-name'] }));
await withRun(ws, 'demo', (run: any) => completeSlice(ws, run));

// Slice 02: greet.ts line 1 changes, f keeps its name; thermo reports the same problem under a new id.
await withRun(ws, 'demo', (run: any) => nextSlice(ws, run));
writeFileSync(join(root, 'greet.ts'), "export const f = (name: string, loud = false) => (loud ? `HELLO ${name.toUpperCase()}` : `hello ${name}`);\n");
git('add', '.');
git('commit', '-qm', 'loud f');
await withRun(ws, 'demo', (run: any) => runChecks(ws, run));
console.log(JSON.stringify({ root, repeat: thermo('thermo-vague-function-name', 'Function name f is vague') }));
