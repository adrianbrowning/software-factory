// Setup helper for scripts/smoke-worker-submissions.sh (not part of `pnpm run test`).
// Builds a throwaway git repo with a started run whose one slice has committed work and passing checks (no review open
// yet; the omp prompt opens it), through the real extension tools (factory_start writes the active-run pointer), and
// prints the repo root as JSON.
// Usage: node scripts/smoke-worker-submissions-setup.ts <empty repo dir> <model>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runChecks } from '../src/review.ts';
import { withRun } from '../src/run.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { ctx, load } from '../test/extension.ts';

const [root, model] = process.argv.slice(2);
if (root === undefined || model === undefined) throw new Error('Usage: smoke-worker-submissions-setup.ts <repo dir> <model>');
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

git('init', '-q', '-b', 'main');
mkdirSync(join(root, '.omp'));
const agentModel = { model };
writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { reviewer: agentModel, validator: agentModel } }));
git('add', '.');
git('commit', '-qm', 'base');

const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, models: { resolve: () => ({}) }, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
await load().get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Add a greeting', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, main);
const ws = { config: loadConfig(root), root };
const slice = { acceptance: ['greet() returns hello'], blockedBy: [], estimateTokens: 500, seams: ['greet()'], title: 'Greeting', whatToBuild: 'A greet function' };
await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice])));
await withRun(ws, 'demo', run => nextSlice(ws, run));
writeFileSync(join(root, 'ok'), 'x\n');
writeFileSync(join(root, 'greet.ts'), "export const greet = () => 'hello';\n");
writeFileSync(join(root, 'greet.test.ts'), "import assert from 'node:assert/strict';\nimport { greet } from './greet.ts';\n\nassert.equal(greet(), 'hello');\n");
git('add', '.');
git('commit', '-qm', 'add greet');
await withRun(ws, 'demo', run => runChecks(ws, run));
console.log(JSON.stringify({ root }));
