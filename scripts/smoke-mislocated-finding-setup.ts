// Setup helper for scripts/smoke-mislocated-finding.sh (not part of `pnpm run test`).
// Builds a throwaway repo with one slice whose diff has the issue-384 shape: in src/report.ts, label() changes at line 4
// and saveReport() keeps its doc comment (line 7) as an unchanged context line of the same hunk while its behavior changes
// so the doc becomes false. The slice has passing checks and no review open (the omp session opens it).
// Usage: node scripts/smoke-mislocated-finding-setup.ts <empty repo dir> <model>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { runChecks } from '../src/review.ts';
import { type Run, withRun } from '../src/run.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { ctx, load } from '../test/extension.ts';

const [root, model] = process.argv.slice(2);
if (root === undefined || model === undefined) throw new Error('Usage: smoke-mislocated-finding-setup.ts <repo dir> <model>');

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main');
mkdirSync(join(root, '.omp'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { reviewer: { model }, validator: { model } } }));
const report = (label: string, save: string) => `import { writeFileSync } from 'node:fs';

export function label(name: string): string {
  return ${label};
}

/** Stores the report in the given file and does nothing else. */
export function saveReport(path: string, text: string): void {
${save}
}
`;
writeFileSync(join(root, 'src/report.ts'), report('name.trim()', '  writeFileSync(path, text);'));
git('add', '.');
git('commit', '-qm', 'base');

const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, models: { resolve: () => ({}) }, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
await load().get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Add reports', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, main);
const ws = { config: loadConfig(root), root };
await withRun(ws, 'demo', (run: Run) => approvePlan(ws, run, planSlices(ws, run, [{ acceptance: ['Report works'], blockedBy: [], estimateTokens: 500, noTestReason: 'smoke: nothing to test', seams: [], title: 'Report', whatToBuild: 'Report' }])));

await withRun(ws, 'demo', (run: Run) => nextSlice(ws, run));
writeFileSync(join(root, 'ok'), 'x\n');
writeFileSync(join(root, 'src/report.ts'), report('name.trim().toLowerCase()', '  writeFileSync(path, text);\n  writeFileSync(`${path}.bak`, text);'));
git('add', '.');
git('commit', '-qm', 'report');
await withRun(ws, 'demo', (run: Run) => runChecks(ws, run));
console.log(JSON.stringify({ root }));
