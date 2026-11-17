// Setup helper for scripts/smoke-headless-placement.sh (not part of `pnpm run test`).
// Builds a throwaway headless run whose slice 01 has committed work and passing checks, with no review open. The omp
// session then runs real reviewers (categories), the real validator, record, and the headless completion.
// Usage: node scripts/smoke-headless-placement-setup.ts <empty repo dir> <model>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { runChecks } from '../src/review.ts';
import { withRun, type Run } from '../src/run.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { ctx, load } from '../test/extension.ts';

const [root, model] = process.argv.slice(2);
if (root === undefined || model === undefined) throw new Error('Usage: smoke-headless-placement-setup.ts <repo dir> <model>');

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main');
mkdirSync(join(root, '.omp'));
writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({
  baseRef: 'main', checks: ['test -f ok'], deferred: { kind: 'file' }, headless: { submission: 'stop' },
  models: { reviewer: { model }, validator: { model } },
}));
writeFileSync(join(root, 'demo.md'), '# Demo\n\nAdd a greeting function and a loud variant.\n');
git('add', '.');
git('commit', '-qm', 'base');

const commands = new Map<string, { handler: (args: string, caller: unknown) => Promise<void> }>();
load({ commands, sent: [] });
const noDialog = async (title: string) => { throw new Error(`dialog: ${title}`); };
const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, models: { resolve: () => ({}) }, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
await commands.get('factory')?.handler('headless demo.md', caller);
const ws = { config: loadConfig(root), root };
const s = (title: string, blockedBy: string[]) => ({ acceptance: [`${title} works`], blockedBy, estimateTokens: 500, noTestReason: 'smoke: nothing to test', seams: [], title, whatToBuild: title });
await withRun(ws, 'demo', (run: Run) => approvePlan(ws, run, planSlices(ws, run, [s('Greeting', []), s('Loud greeting', ['Greeting'])])));
await withRun(ws, 'demo', (run: Run) => nextSlice(ws, run));
writeFileSync(join(root, 'ok'), 'x\n');
writeFileSync(join(root, 'greet.ts'), 'export const f = (name: string) => `hello ${name}`;\n');
git('add', '.');
git('commit', '-qm', 'add f');
await withRun(ws, 'demo', (run: Run) => runChecks(ws, run));
console.log(JSON.stringify({ root }));
