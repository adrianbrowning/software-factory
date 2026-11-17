import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { type Finding, readRun, withRun, type Workspace } from '../src/run.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

type Reply = { content: { text: string }[]; details?: { dataFile?: string; domains?: string[]; reviewId?: string } };

/** A run with slice Feature (a test seam, so testing always reviews) and Second, driven through the registered tools. */
async function setup(root: string) {
  const tools = load();
  const call = async (name: string, params: unknown, agent: 'main' | 'factory-reviewer' | 'factory-review-validator' = 'main') => {
    const caller = { ...ctx(agent === 'main' ? 'main' : 'sub', agent), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
  };
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature'), slice('Second', ['Feature'])])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await call('factory_checks', {});

  /** Every domain of `domains` submits (its own findings, else none), the validator keeps `keep` and drops the rest, then the review is recorded. */
  const finish = async (domains: string[], findings: Finding[], keep: string[], record = true) => {
    const reviewId = readRun(ws, 'demo').slices[0]?.review?.id ?? assert.fail('no review');
    for (const domain of domains) {
      const own = findings.filter(item => item.domain === domain);
      await call('factory_review_submit', { domain, findings: own, reviewId, ...(domain === 'scope' ? { fixItems: readRun(ws, 'demo').slices[0]?.fixItems.map(item => ({ id: item.id, reason: 'fixed in the diff', status: 'fixed' })) ?? [] } : {}) }, 'factory-reviewer');
    }
    const dropped = findings.filter(item => !keep.includes(item.id)).map(item => ({ id: item.id, reason: 'outside the fix diff' }));
    await call('factory_review_validate', { dropped, keep, reviewId }, 'factory-review-validator');
    return record ? call('factory_review_record', {}) : undefined;
  };
  const open = async (params: unknown = { skip: [] }) => {
    const opened = await call('factory_review_start', params);
    return { dataFile: opened.details?.dataFile ?? assert.fail('no data file'), domains: [...(opened.details?.domains ?? [])].sort(), reviewId: opened.details?.reviewId ?? '' };
  };
  /** A full review of the committed work that blocks on `finding` (a security finding) and goes to the fix loop. */
  const red = async (blocking: Finding) => {
    const opened = await open();
    await finish(opened.domains, [blocking], [blocking.id]);
    return opened;
  };
  return { call, finish, open, red, ws };
}

const repo = () => tempRepo('factory-targeted-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) });
const sorted = (...domains: string[]) => [...domains].sort();

describe('targeted re-review', () => {
  it('opens a targeted review of the failing domains plus bug, scope and testing after a red review, and says so in the data file with the fix diff', async () => {
    using dir = repo();
    const { call, open, red, ws } = await setup(dir.root);
    const first = await red(finding('security', 'high', 'leak'));
    assert.ok(first.domains.length > 4, 'the first review is a full one');
    commit(ws, 'second.txt', 'a\nb\n');
    await call('factory_checks', {});

    const targeted = await open({ skip: [{ domain: 'security', reason: 'the orchestrator skip list applies only to a full review' }] });
    assert.deepEqual(targeted.domains, sorted('security', 'bug', 'scope', 'testing'));
    const data = readFileSync(targeted.dataFile, 'utf8');
    assert.match(data, /## TARGETED REVIEW\n/);
    assert.match(data, new RegExp(`${first.reviewId}[\\s\\S]*## TARGETED REVIEW|## TARGETED REVIEW[\\s\\S]*${first.reviewId}`));
    assert.match(data, /- second\.txt: 1-2\n/, 'the fix diff changed lines are listed');
    assert.doesNotMatch(/## TARGETED REVIEW\n([\s\S]*?)\n## /.exec(data)?.[1] ?? '', /- ok: /, 'lines of the slice outside the fix diff are not listed');
    assert.match(data, /add second\.txt/, 'the commits of the fix diff are listed');
  });

  it('a fresh slice review is full', async () => {
    using dir = repo();
    const { open } = await setup(dir.root);
    const first = await open({ skip: [] });
    assert.doesNotMatch(readFileSync(first.dataFile, 'utf8'), /## TARGETED REVIEW/);
  });

  it('keeps an observation only on a fix diff line: the validator must drop one outside it, and blocking findings anywhere count', async () => {
    using dir = repo();
    const { call, finish, open, red, ws } = await setup(dir.root);
    await red(finding('security', 'high', 'leak'));
    commit(ws, 'second.txt', 'a\nb\n');
    await call('factory_checks', {});
    const targeted = await open();
    const inside = { ...finding('bug', 'observation', 'inside'), path: 'second.txt' };
    const outside = finding('bug', 'observation', 'outside');
    const blockingElsewhere = finding('security', 'high', 'still');

    // The reviewers' submissions are accepted; factory_review_validate refuses a validation that keeps the observation outside the fix diff, and the validator corrects it.
    await assert.rejects(finish(targeted.domains, [inside, outside, blockingElsewhere], [inside.id, outside.id, blockingElsewhere.id]), /outside the fix diff[\s\S]*bug-outside/);
    const reviewId = targeted.reviewId;
    await call('factory_review_validate', { dropped: [{ id: outside.id, reason: 'outside the fix diff' }], keep: [inside.id, blockingElsewhere.id], reviewId }, 'factory-review-validator');
    const recorded = await call('factory_review_record', {});
    assert.match(recorded?.content[0]?.text ?? '', /1 blocking findings/, 'a blocking finding outside the fix diff still blocks');
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
  });

  it('refuses a validation that downgrades a blocking finding outside the fix diff to a kept observation', async () => {
    using dir = repo();
    const { call, open, red, ws } = await setup(dir.root);
    await red(finding('security', 'high', 'leak'));
    commit(ws, 'second.txt', 'a\nb\n');
    await call('factory_checks', {});
    const targeted = await open();
    const reviewId = targeted.reviewId;
    const blocking = finding('security', 'high', 'old');
    for (const domain of targeted.domains) {
      await call('factory_review_submit', { domain, findings: domain === 'security' ? [blocking] : [], reviewId, ...(domain === 'scope' ? { fixItems: readRun(ws, 'demo').slices[0]?.fixItems.map(item => ({ id: item.id, reason: 'fixed', status: 'fixed' })) } : {}) }, 'factory-reviewer');
    }
    await assert.rejects(
      call('factory_review_validate', { downgrade: [{ id: blocking.id, reason: 'minor' }], dropped: [], keep: [], reviewId }, 'factory-review-validator'),
      /outside the fix diff/,
    );
  });

  it('lists only the changed line of a fix diff, and refuses keeping an observation on an unchanged line two lines away', async () => {
    using dir = repo();
    const { call, finish, open, ws } = await setup(dir.root);
    const original = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
    commit(ws, 'lines.txt', `${original.join('\n')}\n`);
    await call('factory_checks', {});
    const opened = await open();
    await finish(opened.domains, [finding('security', 'high', 'leak')], [finding('security', 'high', 'leak').id]);
    commit(ws, 'lines.txt', `${original.map((text, index) => (index === 5 ? 'changed' : text)).join('\n')}\n`);
    await call('factory_checks', {});
    const targeted = await open();
    const data = readFileSync(targeted.dataFile, 'utf8');
    assert.match(data, /- lines\.txt: 6(-6)?\n/, 'only the changed line is listed');
    const near = { ...finding('bug', 'observation', 'near'), line: 8, path: 'lines.txt' };
    await assert.rejects(finish(targeted.domains, [near], [near.id]), /outside the fix diff[\s\S]*bug-near/);
  });

  it('allows a full review on the same commit after a targeted green, and completes only after the full one is green', async () => {
    using dir = repo();
    const { call, finish, open, red, ws } = await setup(dir.root);
    await red(finding('security', 'high', 'leak'));
    commit(ws, 'second.txt', 'a\nb\n');
    await call('factory_checks', {});
    const targeted = await open();
    const green = await finish(targeted.domains, [], []);
    assert.match(green?.content[0]?.text ?? '', /Review is green/);

    await assert.rejects(call('factory_complete_slice', {}), /full review/);
    const before = readRun(ws, 'demo').slices[0]?.checked?.sha;
    const full = await open({ skip: [] });
    assert.ok(full.domains.length > 4, 'the review after a targeted green is a full one');
    assert.doesNotMatch(readFileSync(full.dataFile, 'utf8'), /## TARGETED REVIEW/);
    assert.equal(readRun(ws, 'demo').slices[0]?.checked?.sha, before, 'on the same commit, with no new checks');
    await assert.rejects(call('factory_complete_slice', {}), /The slice has no green review yet/);
    await finish(full.domains, [], []);
    assert.match((await call('factory_complete_slice', {})).content[0]?.text ?? '', /Slice 01 is done/);
  });

  it('goes back to targeted rounds when the full review after a targeted green blocks', async () => {
    using dir = repo();
    const { call, finish, open, red, ws } = await setup(dir.root);
    await red(finding('security', 'high', 'leak'));
    commit(ws, 'second.txt', 'a\nb\n');
    await call('factory_checks', {});
    await finish((await open()).domains, [], []);
    const full = await open({ skip: [] });
    await finish(full.domains, [finding('thermo', 'high', 'naming')], ['thermo-naming']);
    commit(ws, 'third.txt');
    await call('factory_checks', {});
    assert.deepEqual((await open()).domains, sorted('thermo', 'bug', 'scope', 'testing'));
  });

  it('lets a slice complete after a full green and a targeted green of an observation fix round only', async () => {
    using dir = repo();
    const { call, finish, open, ws } = await setup(dir.root);
    const full = await open({ skip: [] });
    await finish(full.domains, [finding('thermo', 'observation', 'naming')], ['thermo-naming']);
    await call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' });
    commit(ws, 'tidy.txt');
    await call('factory_checks', {});
    const targeted = await open({ skip: [{ domain: 'thermo', reason: 'ignored in a targeted review' }] });
    assert.deepEqual(targeted.domains, sorted('thermo', 'bug', 'scope', 'testing'));
    await finish(targeted.domains, [], []);
    assert.match((await call('factory_complete_slice', {})).content[0]?.text ?? '', /Slice 01 is done/);
  });

  it('does not let an earlier full green excuse a targeted green that follows a red review', async () => {
    using dir = repo();
    const { call, finish, open, ws } = await setup(dir.root);
    await finish((await open({ skip: [] })).domains, [], []);
    await call('factory_decide', { decisions: ['Later decision.'] });
    const again = await open({ skip: [] });
    await finish(again.domains, [finding('thermo', 'high', 'naming')], ['thermo-naming']);
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    await finish((await open()).domains, [], []);
    await assert.rejects(call('factory_complete_slice', {}), /full review/);
  });

  it('needs a full review after a bug fix round that follows a full green, even with observations in the round', async () => {
    using dir = repo();
    const { call, finish, open, ws } = await setup(dir.root);
    const full = await open({ skip: [] });
    await finish(full.domains, [finding('thermo', 'observation', 'naming')], ['thermo-naming']);
    await call('factory_fix', { bug: 'it crashes', observations: ['thermo-naming'], reason: 'user found it' });
    commit(ws, 'tidy.txt');
    await call('factory_checks', {});
    const next = await open({ skip: [] });
    assert.doesNotMatch(readFileSync(next.dataFile, 'utf8'), /## TARGETED REVIEW/);
    assert.ok(next.domains.length > 4);
    await finish(next.domains, [], []);
    assert.match((await call('factory_complete_slice', {})).content[0]?.text ?? '', /Slice 01 is done/);
  });
});
