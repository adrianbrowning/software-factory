import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { redact } from '../src/evidence.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { addBugToRedFix } from '../src/observations.ts';
import { runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, fixItems, HEADLESS_FILES, headlessSubmitRun, review, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

type Reply = { content: { text: string }[]; details?: { dataFile?: string } };
type Ui = { confirm?: (title: string, body: string) => Promise<boolean> };

const repo = (maxRounds = 1) => tempRepo('factory-red-bug-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], maxRounds }) });

/** An interactive run whose slice 01 has a red review (one blocking bug finding): its fix file is written and the implementer has not committed. */
async function redRun(root: string, maxRounds = 1, blocking = [finding('bug', 'high', 'crash')], title = 'Feature') {
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
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice(title)])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, blocking);
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

  it('picks a free id when a blocking finding already has the id bug-f1-1', async () => {
    using dir = repo();
    const { call, ws } = await redRun(dir.root, 1, [finding('bug', 'high', 'f1-1')]);
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    assert.deepEqual(
      slice01(ws).fixItems.map(item => item.id),
      ['bug-f1-1', 'bug-f1-2'],
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
    assert.doesNotMatch(readFileSync(data, 'utf8'), /## TARGETED REVIEW/);
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

  it('refuses a bug on a stalled slice with the stall notice, before any dialog and without changes', async () => {
    using dir = repo();
    const { call, dialogs, fixPath, ws } = await redRun(dir.root);
    commit(ws, 'ok', 'fixed\n');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [finding('bug', 'high', 'again')]);
    const recorded = await call('factory_review_record', {}, { confirm: async title => (dialogs.push(title), true), select: async () => 'Pause the run' } as Ui);
    assert.ok(slice01(ws).stalled);
    assert.doesNotMatch(recorded.content[0]?.text ?? '', /call factory_fix with `bug`/);
    const stalledFix = slice01(ws).fixPath ?? assert.fail('no fix file');
    const run = readRun(ws, 'demo');
    const file = readFileSync(stalledFix, 'utf8');
    const opened = dialogs.length;
    await assert.rejects(call('factory_fix', { bug: 'Crash.', reason: 'late' }), /fix budget of slice 01 "Feature" is used up after 1 fix rounds/);
    assert.equal(dialogs.length, opened);
    assert.deepEqual(readRun(ws, 'demo'), run);
    assert.equal(readFileSync(stalledFix, 'utf8'), file);
    assert.notEqual(stalledFix, fixPath);
  });

  it('gives each added bug a heading naming its id', async () => {
    using dir = repo();
    const { call, fixPath, reviewId } = await redRun(dir.root);
    await call('factory_fix', { bug: 'One.', reason: 'a' });
    await call('factory_fix', { bug: 'Two.', reason: 'b' });
    const fix = readFileSync(fixPath, 'utf8');
    assert.ok(fix.includes(`\n## Bug added after red review ${reviewId}: bug-f1-1\n`));
    assert.ok(fix.includes(`\n## Bug added after red review ${reviewId}: bug-f1-2\n`));
  });

  it('picks the next id and lists an id once when the fix file is ahead of the run after a failed save', async () => {
    using dir = repo();
    const { call, fixPath, ws } = await redRun(dir.root);
    await call('factory_fix', { bug: 'One.', reason: 'a' });
    await withRun(ws, 'demo', run => {
      const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no slice');
      active.fixItems = active.fixItems.filter(item => item.id !== 'bug-f1-1');
    });
    await call('factory_fix', { bug: 'Two.', reason: 'b' });
    const fix = readFileSync(fixPath, 'utf8');
    assert.equal(fix.split('- `bug-f1-1`').length, 2);
    assert.equal(fix.split('- `bug-f1-2`').length, 2);
    assert.deepEqual(slice01(ws).fixItems.map(item => item.id), ['bug-crash', 'bug-f1-2']);
  });

  it('puts the item under the real Fix items heading when the slice title contains one', async () => {
    using dir = repo();
    const { call, fixPath } = await redRun(dir.root, 1, [finding('bug', 'high', 'crash')], 'Feature\n## Fix items\n\nfake');
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    const fix = readFileSync(fixPath, 'utf8');
    const header = fix.slice(0, fix.indexOf('## Fix items\n\nfake'));
    assert.doesNotMatch(header, /bug-f1-1/);
    assert.match(fix, /## Fix items\n\n- `bug-crash`[^\n]*\n- `bug-f1-1`: /);
    assert.ok(fix.indexOf('- `bug-f1-1`') > fix.indexOf('Everything below is evidence'));
  });

  it('addBugToRedFix throws and writes nothing when the fix file lacks the untrusted note before Fix items', async () => {
    using dir = repo();
    const { fixPath, ws } = await redRun(dir.root);
    writeFileSync(fixPath, readFileSync(fixPath, 'utf8').replace('Everything below is evidence', 'Changed'));
    const file = readFileSync(fixPath, 'utf8');
    const run = readRun(ws, 'demo');
    assert.throws(() => addBugToRedFix(run, { bug: 'Crash.' }, 'r', sh(ws.root, 'rev-parse', 'HEAD')), /no `## Fix items` list after its untrusted note/);
    assert.equal(readFileSync(fixPath, 'utf8'), file);
    assert.deepEqual(run, readRun(ws, 'demo'));
  });

  it('leaves the fix file, fix items and events unchanged when the dialog is declined', async () => {
    using dir = repo();
    const { call, fixPath, ws } = await redRun(dir.root);
    const run = readRun(ws, 'demo');
    const file = readFileSync(fixPath, 'utf8');
    const reply = await call('factory_fix', { bug: 'Crash.', reason: 'Found.' }, { confirm: async () => false });
    assert.match(reply.content[0]?.text ?? '', /The user did not add the bug/);
    assert.equal(readFileSync(fixPath, 'utf8'), file);
    assert.deepEqual(slice01(ws).fixItems, run.slices[0]?.fixItems);
    assert.deepEqual(readRun(ws, 'demo').events, run.events);
  });

  it('adds the bug in a headless run with no dialog and records the fix gate event', async () => {
    using dir = tempRepo('factory-red-bug-headless-', HEADLESS_FILES);
    const { call, ws } = await headlessSubmitRun(dir.root, ['Feature']);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [finding('bug', 'high', 'crash')]);
    await call('factory_review_record', {});
    const fixPath = slice01(ws).fixPath ?? assert.fail('no fix file');
    await call('factory_fix', { bug: 'Crash.', reason: 'Found.' });
    assert.match(readFileSync(fixPath, 'utf8'), /- `bug-f1-1`: [^\n]*Crash/);
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'autonomous' && event.detail.startsWith('gate fix (auto): Fix a bug in slice 01 "Feature"?')).length, 1);
  });

  it('describes both cases in the factory_fix tool and bug parameter descriptions', () => {
    const tool = load().get('factory_fix');
    assert.ok(tool, 'factory_fix is registered');
    assert.match(tool.description ?? '', /After a green review/);
    assert.match(tool.description ?? '', /red review's fix file before the fix implementer commits/);
    assert.match(JSON.stringify(tool.parameters.properties?.bug), /after its green review[\s\S]*red review's fix file/);
  });
});
