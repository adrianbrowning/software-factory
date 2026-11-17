import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { carriedKeysLine, carriesKey } from '../src/legacy-observations.ts';
import { type Finding, readRun, REVIEW_DOMAINS, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, keptFindings, recordReview, runChecks, startReview, submitDomain, submitValidation, validationSchema } from '../src/review.ts';
import { addFollowUp, applyReslice, approvePlan, nextAction, nextSlice, planReslice, planSlices } from '../src/workflow.ts';
import { CHECKS_OK, commit, fakeGh, finding, headlessSubmitRun, noFixItems, retroDoneRun, review, reviewActive, slice, submitGreenWithObservation, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

type Reply = { content: { text: string }[] };

const repo = (extra: Record<string, unknown> = {}) => tempRepo('factory-place-', { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], ...extra }) });

/** An observation of the thermo domain with an explicit category. */
const observation = (name: string, category: NonNullable<Finding['category']>, domain = 'thermo'): Finding => ({ ...finding(domain as Finding['domain'], 'observation', name), category, problem: `${name} misleads the reader` });

/** An interactive run of slices Feature and Second, driven through the registered tools; `dialogs` collects every confirm title (all answered yes). */
async function interactive(root: string) {
  const tools = load();
  const dialogs: string[] = [];
  const call = async (name: string, params: unknown, confirm: (title: string) => Promise<boolean> = async () => true) => {
    const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async (title: string) => (dialogs.push(title), confirm(title)), notify() {} } };
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
  };
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature'), slice('Second', ['Feature'])])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  /** A full review with these findings (all kept), recorded; returns the record reply. */
  const full = async (findings: Finding[]) => {
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, findings);
    return call('factory_review_record', {});
  };
  return { call, dialogs, full, ws };
}

describe('batched observation placement', () => {
  it('refuses an observation without a category at submission', async () => {
    using dir = repo();
    const { ws } = await interactive(dir.root);
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    const bare = { ...finding('thermo', 'observation', 'naming'), category: undefined };
    await assert.rejects(withRun(ws, 'demo', run => submitDomain(ws, run, { agentId: 'a', domain: 'thermo', findings: [bare], reviewId })), /observation without a category/);
  });

  it('refuses a downgrade of a finding without a category unless the validator gives a valid one, and places the downgraded finding by it', async () => {
    using dir = repo();
    const { call, ws } = await interactive(dir.root);
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    const bare = { ...finding('thermo', 'high', 'gap'), category: undefined };
    const skipped = readRun(ws, 'demo').slices.find(item => item.review?.id === reviewId)?.review?.skipped ?? [];
    for (const domain of REVIEW_DOMAINS.filter(name => !skipped.some(entry => entry.domain === name))) {
      const findings = domain === 'thermo' ? [bare] : [];
      await withRun(ws, 'demo', run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId, ...noFixItems(domain) }));
    }
    const downgrade = (category?: string) =>
      withRun(ws, 'demo', run => submitValidation(ws, run, { agentId: 'validator', downgrade: [{ id: bare.id, reason: 'not a correctness or requirement gap', category }], dropped: [], keep: [], reviewId }));
    await assert.rejects(downgrade(), /needs a category/);
    await assert.rejects(downgrade('not-a-category'), /expected one of/);
    await downgrade('correctness');
    const text = (await call('factory_review_record', {})).content[0]?.text ?? '';
    assert.match(text, /thermo-gap[\s\S]*Default placement: end queue/);
  });

  it('a downgrade category fills in only the downgraded finding that has none, and never replaces a reviewer\'s own', () => {
    const bare = { ...finding('thermo', 'high', 'bare'), category: undefined };
    const own = { ...finding('thermo', 'high', 'own'), category: 'style' as const };
    const kept = { ...finding('thermo', 'high', 'kept'), category: undefined };
    const validation = validationSchema.parse({
      downgrade: [
        { category: 'correctness', id: bare.id, reason: 'r' },
        { category: 'correctness', id: own.id, reason: 'r' },
      ],
      dropped: [],
      keep: [kept.id],
    });
    const byId = new Map(keptFindings([bare, own, kept], validation).map(item => [item.id, item]));
    assert.equal(byId.get(bare.id)?.category, 'correctness');
    assert.equal(byId.get(own.id)?.category, 'style');
    assert.equal(byId.get(kept.id)?.category, undefined);
    assert.equal(byId.get(kept.id)?.severity, 'high');
  });

  it('lists every unplaced observation with its default placement in the final green reply, and completion refuses until factory_place', async () => {
    using dir = repo();
    const { call, dialogs, full, ws } = await interactive(dir.root);
    const text = (await full([observation('naming', 'naming'), observation('gap', 'correctness')])).content[0]?.text ?? '';
    assert.match(text, /thermo-naming[\s\S]*Default placement: leave/);
    assert.match(text, /thermo-gap[\s\S]*Default placement: end queue/);
    await assert.rejects(call('factory_complete_slice', {}), /unplaced observations: thermo-naming, thermo-gap/);

    const placed = (await call('factory_place', { placements: [{ id: 'thermo-naming', placement: 'carry', to: '02' }] })).content[0]?.text ?? '';
    assert.match(placed, /thermo-naming: carry to slice 02/);
    assert.deepEqual(dialogs, ['Place 2 observations of slice 01?'], 'one confirm for the whole batch');
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.observations.map(entry => [entry.id, entry.placement, entry.to]), [['thermo-naming', 'carried', '02'], ['thermo-gap', 'carried', 'end']]);
    assert.equal(run.slices[0]?.unplaced.length, 0);
    assert.equal(run.waiting.length, 1);
    await call('factory_complete_slice', {});
    assert.equal(readRun(ws, 'demo').slices[0]?.status, 'done');
  });

  it('refuses an id that is already placed or not unplaced, before any dialog', async () => {
    using dir = repo();
    const { call, dialogs, full } = await interactive(dir.root);
    await full([observation('naming', 'naming')]);
    await assert.rejects(call('factory_place', { placements: [{ id: 'thermo-nope', placement: 'leave' }] }), /not unplaced on slice 01/);
    await call('factory_place', { placements: [] });
    await assert.rejects(call('factory_place', { placements: [{ id: 'thermo-naming', placement: 'leave' }] }), /already left/);
    assert.equal(dialogs.length, 1);
  });

  it('a declined factory_place confirm places nothing', async () => {
    using dir = repo();
    const { call, dialogs, full, ws } = await interactive(dir.root);
    await full([observation('naming', 'naming'), observation('gap', 'correctness')]);
    const before = readRun(ws, 'demo');
    const text = (await call('factory_place', { placements: [] }, async () => false)).content[0]?.text ?? '';
    assert.match(text, /did not place the observations/);
    assert.equal(dialogs.length, 1);
    const after = readRun(ws, 'demo');
    assert.deepEqual(after.slices[0]?.unplaced, before.slices[0]?.unplaced);
    assert.equal(after.slices[0]?.unplaced.length, 2);
    assert.deepEqual(after.observations, before.observations);
    assert.equal(after.observations.length, 0);
  });

  it('factory_place refuses each malformed placement before any dialog', async () => {
    using dir = repo();
    const { call, dialogs, full } = await interactive(dir.root);
    await full([observation('naming', 'naming'), observation('gap', 'correctness')]);
    const place = (placements: unknown[]) => call('factory_place', { placements });
    await assert.rejects(place([{ id: 'thermo-gap', placement: 'leave' }, { id: 'thermo-gap', placement: 'end' }]), /placed twice/);
    await assert.rejects(place([{ id: 'thermo-gap', placement: 'leave', to: '02' }]), /"to" belongs to carry only/);
    await assert.rejects(place([{ id: 'thermo-gap', placement: 'carry' }]), /carry needs "to"/);
    await assert.rejects(place([{ id: 'thermo-gap', placement: 'carry', to: '01' }]), /Slice 01 is active; carry takes a pending slice/);
    assert.equal(dialogs.length, 0);
  });

  it('factory_place refuses an id unplaced under two reviews, and a targeted green awaiting its full review', async () => {
    using dir = repo();
    const { call, dialogs, full, ws } = await interactive(dir.root);
    await full([finding('security', 'high', 'leak'), observation('naming', 'naming', 'bug')]);
    commit(ws, 'more.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    // The targeted green keeps the same observation id under a second review; its full review is still to come.
    await full([{ ...observation('naming', 'style', 'bug'), path: 'more.txt' }]);
    await assert.rejects(call('factory_place', { placements: [] }), /was targeted: place observations after its full review/);
    await full([]);
    await assert.rejects(call('factory_place', { placements: [{ id: 'bug-naming', placement: 'leave' }] }), /unplaced under reviews[\s\S]*name it as <review>:bug-naming/);
    assert.equal(dialogs.length, 0);
  });

  it('factory_carry, factory_defer and factory_leave refuse observation ids after a targeted green, and a note alone still carries; factory_place takes them after the full review', async () => {
    using dir = repo({ deferred: { kind: 'file' } });
    const { call, full, ws } = await interactive(dir.root);
    await full([finding('security', 'high', 'leak'), observation('naming', 'naming')]);
    commit(ws, 'more.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    await full([{ ...observation('extra', 'style', 'bug'), path: 'more.txt' }]);
    await assert.rejects(call('factory_leave', { observations: ['bug-extra'] }), /targeted: factory_leave takes observation ids only after its full review/);
    await assert.rejects(call('factory_carry', { observations: ['bug-extra'], to: '02' }), /factory_carry takes observation ids only after/);
    await assert.rejects(call('factory_defer', { observations: ['bug-extra'] }), /factory_defer takes observation ids only after/);
    assert.equal(readRun(ws, 'demo').observations.length, 0);
    await call('factory_carry', { note: 'build the thing', to: '02' });
    assert.equal(readRun(ws, 'demo').slices[1]?.carried.length, 1);
    await call('factory_defer', { note: 'look at this later' });
    assert.equal(readRun(ws, 'demo').deferred.length, 1);
    await full([]);
    await call('factory_place', { placements: [{ id: 'bug-extra', placement: 'leave' }] });
    assert.equal(readRun(ws, 'demo').observations[0]?.placement, 'left');
  });

  it('places the observation of a red review: it is listed with the final green review and factory_fix takes it without using the fix budget', async () => {
    using dir = repo();
    const { call, full, ws } = await interactive(dir.root);
    const red = await full([finding('security', 'high', 'leak'), observation('naming', 'correctness')]);
    assert.match(red.content[0]?.text ?? '', /blocking/);
    assert.equal(readRun(ws, 'demo').slices[0]?.unplaced.length, 1);
    commit(ws, 'more.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    assert.doesNotMatch((await full([])).content[0]?.text ?? '', /Unplaced observations/, 'a targeted green waits for the full review');
    const final = (await full([])).content[0]?.text ?? '';
    assert.match(final, /thermo-naming[\s\S]*Review: 01-r1[\s\S]*Default placement: end queue/);
    const before = readRun(ws, 'demo').slices[0]?.fixRounds;
    const fixed = (await call('factory_fix', { observations: ['thermo-naming'], reason: 'now' })).content[0]?.text ?? '';
    assert.match(fixed, /back in fix for thermo-naming/);
    const slice0 = readRun(ws, 'demo').slices[0];
    assert.equal(slice0?.fixRounds, before);
    assert.equal(slice0?.unplaced.length, 0);
    assert.equal(readRun(ws, 'demo').observations[0]?.placement, 'fixed');
  });

  it('factory_place fix sends the slice to an observation round that costs no fix budget', async () => {
    using dir = repo();
    const { call, full, ws } = await interactive(dir.root);
    await full([observation('gap', 'correctness')]);
    const text = (await call('factory_place', { placements: [{ id: 'thermo-gap', placement: 'fix' }] })).content[0]?.text ?? '';
    assert.match(text, /back in fix/);
    const sliceNow = readRun(ws, 'demo').slices[0];
    assert.equal(sliceNow?.phase, 'fix');
    assert.equal(sliceNow?.fixRounds, 0);
  });

  it('a carried red-review observation is marked as carried to the receiving slice', async () => {
    using dir = repo();
    const { call, full, ws } = await interactive(dir.root);
    await full([finding('security', 'high', 'leak'), observation('gap', 'correctness')]);
    commit(ws, 'more.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    await full([]);
    await full([]);
    await call('factory_place', { placements: [{ id: 'thermo-gap', placement: 'carry', to: '02' }] });
    const section = readRun(ws, 'demo').slices[1]?.carried[0] ?? '';
    assert.match(section, /^### From review 01-r1 of slice 01/, 'a red review header is not the green one');
    assert.match(section, /Carried keys: `01-r1:thermo-gap`$/);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { dataFile } = await withRun(ws, 'demo', run => startReview(ws, run));
    assert.match(readFileSync(dataFile, 'utf8'), /01-r1:thermo-gap` \(carried; carried to this slice: check it\)/);
  });

  it('lists a red review\'s unplaced observation as known, and a full review that raises it again adds nothing', async () => {
    using dir = repo();
    const { full, ws } = await interactive(dir.root);
    await full([finding('security', 'high', 'leak'), observation('naming', 'correctness')]);
    commit(ws, 'more.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const targeted = await withRun(ws, 'demo', run => startReview(ws, run));
    assert.match(readFileSync(targeted.dataFile, 'utf8'), /`01-r1:thermo-naming` \(unplaced\): ok:1 - naming/);
    await review(ws, targeted.reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    const final = (await full([{ ...observation('naming', 'correctness'), id: 'thermo-again' }])).content[0]?.text ?? '';
    assert.equal(final.match(/Default placement/g)?.length, 1, 'listed once');
    assert.deepEqual(readRun(ws, 'demo').slices[0]?.unplaced.map(entry => entry.finding.id), ['thermo-naming']);
  });

  it('a headless follow-up slice never puts its own observations back into the end queue', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature']);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const first = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, first.reviewId, [observation('gap', 'correctness')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    assert.equal(readRun(ws, 'demo').waiting.length, 1);
    await withRun(ws, 'demo', run => addFollowUp(ws, run, slice('Follow up', [])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'follow.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const second = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, second.reviewId, [{ ...observation('again', 'correctness'), path: 'follow.txt' }]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.equal(run.waiting.length, 0);
    assert.match(nextAction(run), /Run the retro/);
    assert.equal(run.observations.find(entry => entry.id === 'thermo-again')?.placement, 'left');
  });

  it('a re-sliced headless follow-up slice keeps its children out of the end queue', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature']);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const first = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, first.reviewId, [observation('gap', 'correctness')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => addFollowUp(ws, run, slice('Follow up', [])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'follow.txt');
    await withRun(ws, 'demo', async run => {
      const plan = planReslice(ws, run, [slice('Child one'), slice('Child two', ['Child one'])]);
      await applyReslice(ws, run, plan);
      assert.deepEqual(plan.children.map(child => child.fromEndQueue), [true, true]);
    });
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const second = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, second.reviewId, [{ ...observation('again', 'correctness'), path: 'follow.txt' }]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    assert.equal(readRun(ws, 'demo').waiting.length, 0);
  });

  it('a re-slice after a red review moves the unplaced observation to the first child', async () => {
    using dir = repo();
    const { full, ws } = await interactive(dir.root);
    await full([finding('security', 'high', 'leak'), observation('naming', 'correctness')]);
    await withRun(ws, 'demo', async run => {
      const plan = planReslice(ws, run, [slice('Child one'), slice('Child two', ['Child one'])]);
      assert.deepEqual(plan.children[0]?.unplaced.map(entry => entry.finding.id), ['thermo-naming']);
      assert.equal(plan.children[1]?.unplaced.length, 0);
    });
  });

  it('names factory_place in the next action while observations are unplaced, and factory_complete_slice after', async () => {
    using dir = repo();
    const { call, full, ws } = await interactive(dir.root);
    await full([observation('naming', 'naming')]);
    assert.match(nextAction(readRun(ws, 'demo')), /factory_place/);
    await call('factory_place', { placements: [] });
    assert.match(nextAction(readRun(ws, 'demo')), /factory_complete_slice/);
  });

  it('a headless completion that is refused after the defaults would be filed files nothing, so the retry creates no duplicate issue', async () => {
    using gh = fakeGh();
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, { deferred: { kind: 'github' } });
    await submitGreenWithObservation(ws);
    writeFileSync(join(ws.root, 'ok'), 'dirty\n');
    await assert.rejects(withRun(ws, 'demo', run => completeSlice(ws, run)), /Cannot complete the slice: commit or remove these changes first/);
    assert.equal(gh.calls().length, 0);
    writeFileSync(join(ws.root, 'ok'), 'x\n');
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    assert.equal(gh.calls().length, 1);
    assert.equal(readRun(ws, 'demo').slices[0]?.status, 'done');
  });

  /** Makes the ticket write of completeSlice fail, after the observations were placed. */
  const breakTicket = (ws: Workspace) => {
    const path = ticketPath(ws, 'demo', readRun(ws, 'demo').slices[0]!);
    rmSync(path, { force: true });
    mkdirSync(path);
  };

  it('an interactive completion that fails after its steps starts rolls the state back and rethrows the error', async () => {
    using dir = repo();
    const { call, full, ws } = await interactive(dir.root);
    await full([observation('naming', 'naming')]);
    await call('factory_place', { placements: [] });
    const before = readRun(ws, 'demo');
    breakTicket(ws);
    await assert.rejects(call('factory_complete_slice', {}), error => error instanceof Error && !/after its default observations were placed/.test(error.message));
    const after = readRun(ws, 'demo');
    assert.equal(after.slices[0]?.status, 'active');
    assert.deepEqual(after.events, before.events, 'no slice-done event is kept');
  });

  it('a headless completion that fails after the defaults were placed keeps the placement and says so', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, { deferred: { kind: 'file' } });
    await submitGreenWithObservation(ws);
    breakTicket(ws);
    await assert.rejects(withRun(ws, 'demo', run => completeSlice(ws, run)), /failed after its default observations were placed/);
    const run = readRun(ws, 'demo');
    assert.equal(run.slices[0]?.status, 'active');
    assert.equal(run.slices[0]?.unplaced.length, 0);
    assert.equal(run.observations.length, 1);
    assert.equal(run.events.some(event => event.kind === 'slice-done'), false);
  });

  it('a headless completion that places nothing and then fails rolls the state back and rethrows the error', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature']);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    const before = readRun(ws, 'demo');
    breakTicket(ws);
    await assert.rejects(withRun(ws, 'demo', run => completeSlice(ws, run)), error => error instanceof Error && /EISDIR/.test(error.message) && !/after its default observations were placed/.test(error.message));
    const after = readRun(ws, 'demo');
    assert.equal(after.slices[0]?.status, 'active');
    assert.deepEqual(after.events, before.events, 'no slice-done event is kept');
  });

  it('a headless Record deferred items slice leaves its correctness observation, so the run still becomes done', async () => {
    using repo = tempRepo('factory-place-', CHECKS_OK);
    const { call, ws } = await retroDoneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await reviewActive(ws, 'record', [observation('gap', 'correctness', 'comments')]);
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.equal(run.waiting.length, 0);
    assert.equal(run.observations.find(entry => entry.id === 'comments-gap')?.placement, 'left');
    assert.equal(run.status, 'done');
  });

  it('a headless run places the defaults with no dialog when the slice completes: end queue, and leave items to the deferred sink', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, { deferred: { kind: 'file' } });
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [observation('naming', 'naming'), observation('gap', 'missing-test')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.observations.map(entry => [entry.id, entry.placement]), [['thermo-gap', 'carried'], ['thermo-naming', 'deferred']]);
    assert.equal(run.deferred.length, 1);
    assert.equal(run.waiting.length, 1);
  });

  it('keeps the observations filed before a failing GitHub issue, and the retry files only the rest', async () => {
    using gh = fakeGh();
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, { deferred: { kind: 'github' } });
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [observation('naming', 'naming'), observation('style', 'style')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    gh.failOn(2);
    await assert.rejects(withRun(ws, 'demo', run => completeSlice(ws, run)), /deferred sink failed, so slice 01 is not complete/);
    const partial = readRun(ws, 'demo');
    assert.notEqual(partial.slices[0]?.status, 'done');
    assert.deepEqual(partial.observations.map(entry => [entry.id, entry.placement]), [['thermo-naming', 'deferred']]);
    assert.deepEqual(partial.slices[0]?.unplaced.map(entry => entry.finding.id), ['thermo-style']);

    gh.healed();
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const done = readRun(ws, 'demo');
    assert.equal(done.slices[0]?.status, 'done');
    assert.deepEqual(done.observations.map(entry => [entry.id, entry.placement]), [['thermo-naming', 'deferred'], ['thermo-style', 'deferred']]);
    assert.equal(gh.calls().length, 3, 'one issue, one failure, one retry for the rest');
  });

  it('a headless run without a sink leaves the leave-by-default observations', async () => {
    using dir = repo();
    const { ws } = await headlessSubmitRun(dir.root, ['Feature']);
    await submitGreenWithObservation(ws);
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    assert.deepEqual(readRun(ws, 'demo').observations.map(entry => [entry.id, entry.placement]), [['thermo-naming', 'left']]);
  });

  it('refuses an explicit defer without a sink', async () => {
    using dir = repo();
    const { call, full } = await interactive(dir.root);
    await full([observation('gap', 'correctness')]);
    await assert.rejects(call('factory_place', { placements: [{ id: 'thermo-gap', placement: 'defer' }] }), /No deferred sink/);
  });

  it('reads the carried keys line by exact key, not by substring, and reports a section without one', () => {
    const section = `### From review 01-r1 of slice 01 "Feature"\n\nx\n\n${carriedKeysLine(['01-r1:thermo-naming-long'])}`;
    assert.equal(carriesKey(section, '01-r1:thermo-naming-long'), true);
    assert.equal(carriesKey(section, '01-r1:thermo-naming'), false);
    assert.equal(carriesKey('### From green review 01-r1 of slice 01 "Feature"\n\nx', '01-r1:thermo-naming'), undefined);
  });
});
