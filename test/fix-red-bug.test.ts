import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { redact } from '../src/evidence.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, fixItems, review, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

type Reply = { content: { text: string }[]; details?: { dataFile?: string } };
type Ui = { confirm?: (title: string, body: string) => Promise<boolean> };

const repo = (maxRounds = 1) => tempRepo('factory-red-bug-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], maxRounds }) });

/** An interactive run whose slice 01 has a red review (one blocking bug finding): its fix file is written and the implementer has not committed. */
async function redRun(root: string, maxRounds = 1) {
  const tools = load();
  const dialogs: string[] = [];
  const call = async (name: string, params: unknown, ui: Ui = { confirm: async title => (dialogs.push(title), true) }, agent: 'main' | 'factory-reviewer' = 'main') => {
    const caller = { ...ctx(agent === 'main' ? 'main' : 'sub', agent), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {}, ...ui } };
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
  };
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, [finding('bug', 'high', 'crash')]);
  const recorded = await call('factory_review_record', {});
  const fixPath = readRun(ws, 'demo').slices[0]?.fixPath ?? assert.fail('no fix file');
  return { call, dialogs, fixPath, recorded: recorded.content[0]?.text ?? '', reviewId, ws, maxRounds };
}

const slice01 = (ws: Workspace) => readRun(ws, 'demo').slices[0] ?? assert.fail('no slice');

describe('factory_fix with a bug on a red review', () => {
  it('adds the bug to the red review fix file as bug-f1-1 with its own section, then a second as bug-f1-2', async () => {
    using dir = repo();
    const { call, dialogs, fixPath, ws } = await redRun(dir.root);
    const secret = `ghp_${'a'.repeat(30)}`;
    const reply = await call('factory_fix', { bug: `Advisor found a crash. token=${secret}`, reason: 'The advisor saw it.' });
    assert.deepEqual(dialogs, ['Fix a bug in slice 01 "Feature"?']);
    assert.match(reply.content[0]?.text ?? '', /Fix file: /);
    const slice = slice01(ws);
    assert.deepEqual([slice.phase, slice.fixPath], ['fix', fixPath]);
    const fix = readFileSync(fixPath, 'utf8');
    assert.match(fix, /## Fix items\n\n- `bug-crash`[^\n]*\n- `bug-f1-1`: [^\n]*Advisor found a crash[^\n]*\n\n/);
    const section = fix.slice(fix.indexOf('The advisor saw it.'));
    assert.ok(section.includes(redact(`Advisor found a crash. token=${secret}`)));
    assert.doesNotMatch(fix, /ghp_/);

    await call('factory_fix', { bug: 'Second problem.', reason: 'Another note.' });
    const both = readFileSync(fixPath, 'utf8');
    assert.match(both, /- `bug-f1-1`: [^\n]*\n- `bug-f1-2`: [^\n]*Second problem[^\n]*\n\n/);
    assert.match(both, /The advisor saw it\.[\s\S]*Another note\./);
    assert.deepEqual(
      slice01(ws).fixItems.map(item => item.id),
      ['bug-crash', 'bug-f1-1', 'bug-f1-2'],
    );
  });

  it('counts no fix round and never stalls, also at the round limit, and records an event naming the review and the item', async () => {
    using dir = repo();
    const { call, reviewId, ws } = await redRun(dir.root);
    const before = slice01(ws);
    assert.equal(before.fixRounds, before.roundLimit, 'the red review used the last round');
    const files = before.fixFiles;
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    const after = slice01(ws);
    assert.deepEqual([after.fixRounds, after.stalled, after.fixFiles], [before.fixRounds, false, files]);
    assert.equal(readRun(ws, 'demo').events.find(event => event.kind === 'fix-bug-added')?.detail, `${reviewId}: bug-f1-1`);
  });

  it('makes the next review full, lists the added item under FIX ITEMS and refuses scope verdicts that leave it out', async () => {
    using dir = repo();
    const { call, ws } = await redRun(dir.root);
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    commit(ws, 'ok', 'fixed\n');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const opened = await call('factory_review_start', { skip: [] });
    const data = opened.details?.dataFile ?? assert.fail('no data file');
    assert.doesNotMatch(data, /## TARGETED REVIEW/);
    assert.match(fixItems(data), /- `bug-f1-1` \([^\n]*fixes\/01-f1\.md, round 1\): [^\n]*Crash/);
    const reviewId = readRun(ws, 'demo').slices[0]?.review?.id ?? assert.fail('no review');
    await assert.rejects(call('factory_review_submit', { domain: 'scope', findings: [], fixItems: [{ id: 'bug-crash', reason: 'ok', status: 'fixed' }], reviewId }, {}, 'factory-reviewer'), /bug-f1-1/);
  });

  it('turns an open verdict on the added item into a red review whose next fix file lists it', async () => {
    using dir = repo(2);
    const { call, ws } = await redRun(dir.root, 2);
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    commit(ws, 'ok', 'fixed\n');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [], [], [
      { id: 'bug-crash', reason: 'fixed', status: 'fixed' },
      { id: 'bug-f1-1', reason: 'not fixed', status: 'open' },
    ]);
    const recorded = await call('factory_review_record', {});
    assert.match(recorded.content[0]?.text ?? '', /1 open fix items/);
    const next = readFileSync(slice01(ws).fixPath ?? assert.fail('no fix file'), 'utf8');
    assert.match(next, /## Open fix items from [^\n]*\n\n### `bug-f1-1`/);
  });

  it('refuses observation ids, and a bug after the implementer committed, before any dialog and without changes', async () => {
    using dir = repo();
    const { call, dialogs, fixPath, ws } = await redRun(dir.root);
    const run = readRun(ws, 'demo');
    const file = readFileSync(fixPath, 'utf8');
    await assert.rejects(call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' }), /^Error: Slice 01 is in fix after a red review, so factory_fix there takes only a bug, not observation ids\./);
    await assert.rejects(call('factory_fix', { bug: 'Crash.', observations: ['thermo-naming'], reason: 'tidy' }), /takes only a bug, not observation ids/);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(readRun(ws, 'demo'), run);
    assert.equal(readFileSync(fixPath, 'utf8'), file);

    commit(ws, 'ok', 'fixed\n');
    const committed = readRun(ws, 'demo');
    const head = sh(ws.root, 'rev-parse', 'HEAD');
    await assert.rejects(call('factory_fix', { bug: 'Crash.', reason: 'late' }), new RegExp(`^Error: Slice 01's fix file describes ${slice01(ws).fixFromSha}, but HEAD is ${head}: the implementer has committed, so the bug cannot join it\\. Call factory_fix with the bug after the review of this round is recorded\\.$`));
    assert.deepEqual(dialogs, []);
    assert.deepEqual(readRun(ws, 'demo'), committed);
    assert.equal(readFileSync(fixPath, 'utf8'), file);
  });

  it('names factory_fix with bug in the factory_review_record reply of a red review', async () => {
    using dir = repo();
    const { recorded } = await redRun(dir.root);
    assert.match(recorded, /To add a bug no reviewer submitted \(for example one an advisor found\), call factory_fix with `bug` and `reason` before you spawn the fix-mode implementer\./);
  });

  it('describes both cases in the factory_fix tool and bug parameter descriptions', () => {
    const tool = load().get('factory_fix');
    assert.ok(tool, 'factory_fix is registered');
    assert.match(tool.description ?? '', /After a green review/);
    assert.match(tool.description ?? '', /red review's fix file before the fix implementer commits/);
    assert.match(JSON.stringify(tool.parameters.properties?.bug), /after its green review[\s\S]*red review's fix file/);
  });
});
