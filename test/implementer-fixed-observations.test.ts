import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ctx, load } from './extension.ts';

import { readRun, type Workspace, withRun } from '../src/run.ts';
import { submitImplementerReport } from '../src/report.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { HEADLESS_FILES, commit, tempRepo, finding, headlessSubmitRun, fixItems, newRun, review, sh, slice, step, workspace } from './helpers.ts';

const OBSERVATION = 'thermo-naming';

/** A slice whose first review is red (one blocking finding) and kept an observation unplaced; the slice is in fix mode. */
async function redWithObservation(ws: Workspace) {
  await newRun(ws, [slice('Feature')]);
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 'ok');
  await step(ws, run => runChecks(ws, run));
  const opened = await step(ws, run => startReview(ws, run));
  await review(ws, opened.reviewId, [finding('scope', 'high', 'gap'), finding('thermo', 'observation', 'naming')]);
  assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
  assert.deepEqual(
    readRun(ws, 'demo').slices[0]?.unplaced.map(entry => entry.finding.id),
    [OBSERVATION],
  );
  commit(ws, 'fixed.txt');
  return sh(ws.root, 'rev-parse', 'HEAD');
}

const report = (ws: Workspace, sha: string, fixItems: string[]) =>
  step(ws, run => submitImplementerReport(ws, run, { behaviors: [], checks: [], commits: [`${sha.slice(0, 7)} fix`], fixItems, open: [] }));

const state = (ws: Workspace) => {
  const run = readRun(ws, 'demo');
  return { ledger: run.observations, slice: run.slices[0]! };
};

describe('implementer report records fixed observations', { concurrency: 4 }, () => {
  it('records an unplaced observation named with `fixed in <sha>` as fixed, as a fix item of the round, and drops it from placement', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    const result = await report(ws, sha, ['scope-gap: fixed in ' + sha.slice(0, 7), `\`${OBSERVATION}\` fixed in ${sha.slice(0, 7)}`]);
    assert.deepEqual(result.fixed, ['01-r1:thermo-naming']);

    const { ledger, slice: after } = state(ws);
    assert.deepEqual(ledger.map(entry => [entry.key, entry.placement]), [['01-r1:thermo-naming', 'fixed']]);
    assert.deepEqual(after.unplaced, []);
    assert.equal(after.fixItems.filter(item => item.id === OBSERVATION && item.round === after.fixFiles).length, 1);
    const events = readRun(ws, 'demo').events.filter(event => event.kind === 'fixed-by-implementer');
    assert.deepEqual(events.map(event => [event.slice, event.detail]), [[after.id, `01-r1: ${OBSERVATION} fixed in ${sha.slice(0, 7)}`]]);
  });

  it('lists it as a FIX ITEM of the next review, and an open verdict makes that review red', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    assert.match(fixItems(opened.dataFile), /- `thermo-naming` \(/);
    const verdicts = readRun(ws, 'demo').slices[0]!.fixItems.map(item =>
      item.id === OBSERVATION ? { id: item.id, reason: 'still wrong', status: 'open' as const } : { id: item.id, reason: 'the diff fixes it', status: 'fixed' as const },
    );
    assert.ok(verdicts.find(verdict => verdict.id !== OBSERVATION), `the round has another fix item, which is fixed: ${JSON.stringify(verdicts)}`);
    await review(ws, opened.reviewId, [], [], verdicts);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
  });

  it('records a `fixed in <sha>` observation after the fix round passes the checks, in phase review', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'review');
    const result = await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    assert.deepEqual(result.fixed, ['01-r1:thermo-naming']);
    const { ledger, slice: after } = state(ws);
    assert.deepEqual(ledger.map(entry => [entry.key, entry.placement]), [['01-r1:thermo-naming', 'fixed']]);
    assert.deepEqual(after.unplaced, []);
  });

  it('keeps the fix items an open review lists when a report names a fixed observation', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    const listed = [...fixItems(opened.dataFile).matchAll(/^- `([^`]+)`/gm)].map(match => match[1]!);
    assert.ok(listed.length > 0);
    const result = await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    assert.deepEqual(result.fixed, []);
    assert.deepEqual(readRun(ws, 'demo').slices[0]!.fixItems.map(item => item.id).toSorted(), listed.toSorted());
    await review(ws, opened.reviewId, [], [], listed.map(id => ({ id, reason: 'the diff fixes it', status: 'fixed' as const })));
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
  });

  it('flags a capitalised `Fixed in <sha>` line sent during an open review as skipped, but not an `already fixed in` note', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => startReview(ws, run));
    assert.equal((await report(ws, sha, [`${OBSERVATION}: Fixed in ${sha.slice(0, 7)}`])).skippedForOpenReview, true);
    assert.equal((await report(ws, sha, [`${OBSERVATION}: already fixed in an earlier commit`])).skippedForOpenReview, false);
  });

  it('does not flag a `scope-gap: fixed in <own sha>` line sent during an open review, as it is no unplaced observation', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => startReview(ws, run));
    assert.equal((await report(ws, sha, [`scope-gap: fixed in ${sha.slice(0, 7)}`])).skippedForOpenReview, false);
  });

  it('does not flag a `fixed in <sha>` line sent during an open review when the sha is no commit of the slice', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    await step(ws, run => startReview(ws, run));
    assert.equal((await report(ws, sha, [`${OBSERVATION}: fixed in ${'a'.repeat(40)}`])).skippedForOpenReview, false);
  });

  it('records a `fixed in <sha>` observation reported after the review returned green, as no review is open then', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    const listed = [...fixItems(opened.dataFile).matchAll(/^- `([^`]+)`/gm)].map(match => match[1]!);
    await review(ws, opened.reviewId, [], [], listed.map(id => ({ id, reason: 'the diff fixes it', status: 'fixed' as const })));
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    assert.notEqual(readRun(ws, 'demo').slices[0]?.phase, 'review');
    const result = await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    assert.deepEqual(result.fixed, ['01-r1:thermo-naming']);
    assert.equal(result.skippedForOpenReview, false);
  });

  it('flags a `fixed in <sha>` line sent during an open review as not recorded, and the tool reply says so', async () => {
    using dir = tempRepo('factory-fixed-obs-open-', HEADLESS_FILES);
    const { ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, {}, async () => '');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const first = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('scope', 'high', 'gap'), finding('thermo', 'observation', 'naming')]);
    assert.equal((await withRun(ws, 'demo', run => recordReview(ws, run))).kind, 'fix');
    commit(ws, 'fixed.txt');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    await withRun(ws, 'demo', run => startReview(ws, run));

    const implementer = { ...ctx('sub', 'factory-implementer'), cwd: dir.root };
    const reported = await load().get('factory_implementer_report')?.execute('id', { behaviors: [], checks: [], commits: [`${sha.slice(0, 7)} fix`], fixItems: [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`], open: [] }, undefined, undefined, implementer);
    const text = reported !== null && typeof reported === 'object' && 'content' in reported && Array.isArray(reported.content) ? JSON.stringify(reported.content) : '';
    assert.match(text, /not recorded as fixed because a review is open/);
    assert.deepEqual(readRun(ws, 'demo').observations, []);
  });

  it('places nothing for `already fixed` and `not a defect` lines against an unambiguous unplaced observation', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    const before = JSON.stringify(state(ws));
    const result = await report(ws, sha, [`${OBSERVATION}: already fixed`, `${OBSERVATION}: not a defect: fine`]);
    assert.deepEqual(result.fixed, []);
    assert.equal(JSON.stringify(state(ws)), before);
  });

  it('leaves the ledger and unplaced list alone for other lines, unknown or ambiguous ids and foreign shas', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => {
      const active = run.slices[0]!;
      const first = active.unplaced[0]!;
      active.unplaced.push({ ...first, review: '01-r0' });
    });
    const before = JSON.stringify(state(ws));
    const short = sha.slice(0, 7);
    const lines = [
      `${OBSERVATION}: already fixed`,
      `${OBSERVATION}: not a defect: fine`,
      `unknown-id: fixed in ${short}`,
      `${OBSERVATION}: fixed in ${short}`, // ambiguous between two reviews
      `01-r1:${OBSERVATION}: fixed in deadbee`, // not a commit of the slice
    ];
    const result = await report(ws, sha, lines);
    assert.deepEqual(result.fixed, []);
    assert.equal(JSON.stringify(state(ws)), before);

    // `<review>:<id>` resolves what the bare id cannot.
    assert.deepEqual((await report(ws, sha, [`\`01-r1:${OBSERVATION}\` fixed in ${short}`])).fixed, ['01-r1:thermo-naming']);
    assert.deepEqual(state(ws).slice.unplaced.map(entry => entry.review), ['01-r0']);
  });

  it('gives two observations with the same bare id from two reviews distinct fix items, each needing its own verdict', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => {
      const active = run.slices[0]!;
      active.unplaced.push({ ...active.unplaced[0]!, review: '01-r0' });
    });
    const short = sha.slice(0, 7);
    const result = await report(ws, sha, [`\`01-r0:${OBSERVATION}\` fixed in ${short}`, `\`01-r1:${OBSERVATION}\` fixed in ${short}`]);
    assert.deepEqual(result.fixed.toSorted(), ['01-r0:thermo-naming', '01-r1:thermo-naming']);
    const ids = readRun(ws, 'demo').slices[0]!.fixItems.map(item => item.id).filter(id => id.endsWith(OBSERVATION));
    assert.deepEqual(ids.toSorted(), ['01-r1:thermo-naming', 'thermo-naming']);
    assert.deepEqual(state(ws).ledger.map(entry => entry.key).toSorted(), ['01-r0:thermo-naming', '01-r1:thermo-naming']);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    const listed = fixItems(opened.dataFile);
    assert.match(listed, /^- `thermo-naming` \(/m);
    assert.match(listed, /^- `01-r1:thermo-naming` \(/m);
    const verdicts = readRun(ws, 'demo').slices[0]!.fixItems.map(item => ({
      id: item.id,
      reason: 'checked',
      status: item.id === '01-r1:thermo-naming' ? ('open' as const) : ('fixed' as const),
    }));
    await review(ws, opened.reviewId, [], [], verdicts);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
    const fixFile = readFileSync(readRun(ws, 'demo').slices[0]!.fixPath!, 'utf8');
    const openSection = fixFile.slice(fixFile.indexOf('## Open fix items from'));
    assert.deepEqual([...openSection.matchAll(/^### `([^`]+)`$/gm)].map(match => match[1]), ['01-r1:thermo-naming']);
  });

  it('does not accept a commit of another checked-out branch as a slice commit', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    const branch = sh(ws.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    sh(ws.root, 'switch', '-qc', 'unrelated', 'main');
    commit(ws, 'foreign.txt');
    const foreign = sh(ws.root, 'rev-parse', 'HEAD');
    const before = JSON.stringify(state(ws));
    const result = await step(ws, run => submitImplementerReport(ws, run, { behaviors: [], checks: [], commits: [], fixItems: [`${OBSERVATION}: fixed in ${foreign.slice(0, 7)}`], open: [] }));
    assert.deepEqual(result.fixed, []);
    assert.equal(JSON.stringify(state(ws)), before);
    sh(ws.root, 'switch', '-q', branch);
    assert.deepEqual((await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`])).fixed, ['01-r1:thermo-naming']);
  });

  it('resolves ids against the unplaced list the report found, whatever the order of its lines', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => {
      const active = run.slices[0]!;
      active.unplaced.push({ ...active.unplaced[0]!, review: '01-r0' });
    });
    const short = sha.slice(0, 7);
    const result = await report(ws, sha, [`\`01-r1:${OBSERVATION}\` fixed in ${short}`, `${OBSERVATION}: fixed in ${short}`]);
    assert.deepEqual(result.fixed, ['01-r1:thermo-naming']);
    assert.deepEqual(state(ws).slice.unplaced.map(entry => entry.review), ['01-r0']);
  });

  it('places an observation once when the report names it on several lines, bare and qualified', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    const short = sha.slice(0, 7);
    const result = await report(ws, sha, [`${OBSERVATION}: fixed in ${short}`, `${OBSERVATION}: fixed in ${short}`, `\`01-r1:${OBSERVATION}\` fixed in ${short}`]);
    assert.deepEqual(result.fixed, ['01-r1:thermo-naming']);
    assert.equal(state(ws).ledger.length, 1);
    assert.equal(state(ws).slice.fixItems.filter(item => item.id === OBSERVATION && item.round === state(ws).slice.fixFiles).length, 1);
  });

  it('does not undo a placement when a later report omits it, and adds nothing when a later report names it again', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    const placed = JSON.stringify(state(ws));
    assert.deepEqual((await report(ws, sha, ['scope-gap: already fixed'])).fixed, []);
    assert.deepEqual((await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`])).fixed, []);
    assert.equal(JSON.stringify(state(ws)), placed);
  });

  it('refuses the report and records nothing outside fix mode', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await step(ws, run => {
      run.slices[0]!.fixFromSha = undefined;
    });
    const before = JSON.stringify(state(ws));
    await assert.rejects(report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]), /not in fix mode/);
    assert.equal(JSON.stringify(state(ws)), before);
  });

  it('through the tools: the reply names it, a headless completion starts no fix round for a misleading-doc one, and the slice completes', async () => {
    using dir = tempRepo('factory-fixed-obs-', HEADLESS_FILES);
    const { call, ws } = await headlessSubmitRun(dir.root, ['Feature'], {}, {}, async () => '');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const first = await withRun(ws, 'demo', run => startReview(ws, run));
    const doc = { ...finding('thermo', 'observation', 'doc'), category: 'misleading-doc' as const, problem: 'doc misleads the reader' };
    const gap = { ...finding('thermo', 'observation', 'gap'), category: 'correctness' as const, problem: 'gap remains' };
    await review(ws, first.reviewId, [finding('scope', 'high', 'gap'), doc, gap]);
    assert.equal((await withRun(ws, 'demo', run => recordReview(ws, run))).kind, 'fix');
    commit(ws, 'fixed.txt');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');

    const implementer = { ...ctx('sub', 'factory-implementer'), cwd: dir.root };
    const reported = await load().get('factory_implementer_report')?.execute('id', { behaviors: [], checks: [], commits: [`${sha.slice(0, 7)} fix`], fixItems: [`scope-gap: fixed in ${sha.slice(0, 7)}`, `thermo-doc: fixed in ${sha.slice(0, 7)}`], open: [] }, undefined, undefined, implementer);
    assert.match((reported as { content: { text: string }[] }).content[0]?.text ?? '', /thermo-doc/);
    assert.deepEqual(readRun(ws, 'demo').slices[0]?.unplaced.map(entry => entry.finding.id), ['thermo-gap']);

    await withRun(ws, 'demo', run => runChecks(ws, run));
    const second = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, second.reviewId, []);
    assert.equal((await withRun(ws, 'demo', run => recordReview(ws, run))).kind, 'green');
    // The fix round followed a red review, so the targeted green review is repeated in full before completion.
    const full = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, full.reviewId, []);
    const recorded = (await call('factory_review_record', {})).content[0]?.text ?? '';
    assert.match(recorded, /thermo-gap/);
    assert.doesNotMatch(recorded, /thermo-doc/);
    const placed = (await call('factory_place', { placements: [] })).content[0]?.text ?? '';
    assert.doesNotMatch(placed, /thermo-doc/);
    assert.match(placed, /thermo-gap/, placed);
    assert.deepEqual(readRun(ws, 'demo').slices[0]?.unplaced, []);
    assert.deepEqual(readRun(ws, 'demo').observations.map(entry => [entry.id, entry.placement]).filter(([id]) => id === 'thermo-doc'), [['thermo-doc', 'fixed']]);
    const rounds = readRun(ws, 'demo').slices[0]!.fixFiles;
    const text = (await call('factory_complete_slice', {})).content[0]?.text ?? '';
    assert.match(text, /Slice 01 is done on /);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixFiles, rounds);
  });
});
