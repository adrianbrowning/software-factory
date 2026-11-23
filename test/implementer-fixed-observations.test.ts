import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRun, type Workspace } from '../src/run.ts';
import { submitImplementerReport } from '../src/report.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, fixItems, newRun, review, sh, slice, step, workspace } from './helpers.ts';

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
  step(ws, run => submitImplementerReport(ws, run, { behaviors: [], commits: [`${sha.slice(0, 7)} fix`], fixItems, open: [] }));

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
  });

  it('lists it as a FIX ITEM of the next review, and an open verdict makes that review red', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    assert.match(fixItems(opened.dataFile), /- `thermo-naming` \(/);
    const verdicts = readRun(ws, 'demo').slices[0]!.fixItems.map(item => ({ id: item.id, reason: 'still wrong', status: 'open' as const }));
    await review(ws, opened.reviewId, [], [], verdicts);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
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

  it('does not undo a placement when a later report omits it, and adds nothing when a later report names it again', async () => {
    using ws = workspace({ maxRounds: 3 });
    const sha = await redWithObservation(ws);
    await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    const placed = JSON.stringify(state(ws));
    assert.deepEqual((await report(ws, sha, [])).fixed, []);
    assert.deepEqual((await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`])).fixed, []);
    assert.equal(JSON.stringify(state(ws)), placed);
  });

  it('records nothing outside fix mode', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    const result = await report(ws, sha, [`${OBSERVATION}: fixed in ${sha.slice(0, 7)}`]);
    assert.deepEqual(result.fixed, []);
    assert.deepEqual(state(ws).ledger, []);
  });
});
