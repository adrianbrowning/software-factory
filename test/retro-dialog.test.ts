import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { retroTitle } from '../src/retro.ts';
import { withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { CHECKS_OK, commit, fakeGh, review, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

const TOKEN = `ghp_${'a'.repeat(30)}`;
const TITLE = `first\nsecond ${TOKEN}`;

describe('factory_retro confirm dialog', () => {
  it('shows an apply finding and a file-issue finding whose title spans lines and holds a credential as one redacted line each', async () => {
    using repo = tempRepo('factory-retro-dialog-', CHECKS_OK);
    using gh = fakeGh();
    const confirms: string[] = [];
    const confirm = async (_title: string, message: string) => {
      confirms.push(message);
      return true;
    };
    const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm, notify() {} } };
    const tools = load();
    const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const findings = [
      { action: 'apply', category: 'automated-checks', detail: 'Add a lint rule', severity: 'high', target: 'repo', title: TITLE },
      { action: 'file-issue', category: 'agents-md', detail: 'The skill is vague', severity: 'medium', target: 'factory', title: TITLE },
    ];
    await call('factory_retro', { findings });
    const dialog = confirms.at(-1) ?? assert.fail('no dialog');
    assert.match(dialog, /^- first second <REDACTED>$/m);
    assert.match(dialog, /^## first second <REDACTED>$/m);
    assert.ok(!dialog.includes(TOKEN));
    const args = gh.args();
    assert.ok(args.includes('--title first second <REDACTED> --body'), args);
    assert.ok(!args.includes(TOKEN));
  });

  it('retroTitle puts a headless gate list entry on one redacted line, clipped at 200 characters', () => {
    assert.equal(retroTitle(TITLE), 'first second <REDACTED>');
    assert.equal(retroTitle('x'.repeat(600)), `${'x'.repeat(200)}…`);
  });

  it('files a 300-character finding title clipped to 200 characters plus an ellipsis', async () => {
    using repo = tempRepo('factory-retro-title-', CHECKS_OK);
    using gh = fakeGh();
    const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
    const tools = load();
    const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await call('factory_retro', { findings: [{ action: 'file-issue', category: 'agents-md', detail: 'The skill is vague', severity: 'medium', target: 'factory', title: 'y'.repeat(300) }] });
    assert.ok(gh.args().includes(`--title ${'y'.repeat(200)}… --body`), gh.args());
  });
});
