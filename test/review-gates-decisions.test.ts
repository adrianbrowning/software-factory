import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordDecisions, recordReview, runChecks, startReview, submitDomain, submitValidation } from '../src/review.ts';
import { nextAction, nextSlice } from '../src/workflow.ts';
import { commit, finding, green, newRun, review, slice, step, workspace } from './helpers.ts';

describe('slice loop gates: decisions and review invalidation', { concurrency: 4 }, () => {
  it('invalidates a review when the working tree or HEAD changes during it', async () => {
    for (const change of ['untracked', 'commit'] as const) {
      using ws = workspace();
      await newRun(ws, [slice('Feature')]);
      await step(ws, run => nextSlice(ws, run));
      commit(ws, 'ok');
      await step(ws, run => runChecks(ws, run));
      const opened = await step(ws, run => startReview(ws, run));
      await review(ws, opened.reviewId, []);

      if (change === 'untracked') writeFileSync(join(ws.root, 'stray.txt'), 'reviewer edit\n');
      else commit(ws, 'reviewer.txt');
      await assert.rejects(step(ws, run => recordReview(ws, run)), /changed during review/);
      const invalidated = readRun(ws, 'demo').slices[0];
      assert.equal(invalidated?.phase, 'checks', change);
      assert.equal(invalidated?.checked, undefined, change);
    }
  });

  it('refuses to complete a slice whose HEAD moved after the green review, and requires new checks', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);

    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => completeSlice(ws, run)), /HEAD moved after the green review/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks');
  });

  it('discards an open review when a decision lands during it, and reopens review on the same commit', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const checked = readRun(ws, 'demo').slices[0]?.checked?.sha;
    const opened = await step(ws, run => startReview(ws, run));
    await step(ws, run => submitDomain(ws, run, { agentId: 'r-bug', domain: 'bug', findings: [], reviewId: opened.reviewId }));

    const recorded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(recorded.discarded, opened.reviewId);
    const invalidated = readRun(ws, 'demo');
    assert.equal(invalidated.slices[0]?.phase, 'review');
    assert.equal(invalidated.slices[0]?.review, undefined);
    assert.equal(invalidated.slices[0]?.checked?.sha, checked);
    assert.match(invalidated.events.at(-1)?.detail ?? '', new RegExp(`${opened.reviewId}: decisions recorded during review`));
    assert.equal(invalidated.events.at(-1)?.kind, 'review-invalidated');
    assert.match(nextAction(invalidated), /factory_review_start/);

    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r-scope', domain: 'scope', findings: [], reviewId: opened.reviewId })),
      /is not the active review/,
    );
    await assert.rejects(
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep: [], reviewId: opened.reviewId })),
      /is not the active review/,
    );
    await assert.rejects(step(ws, run => recordReview(ws, run)), /No review in progress/);

    const again = await step(ws, run => startReview(ws, run));
    assert.notEqual(again.reviewId, opened.reviewId);
    assert.equal(readRun(ws, 'demo').slices[0]?.review?.decisions, 1);
    assert.match(readFileSync(again.dataFile, 'utf8'), /Late decision\./);
    await review(ws, again.reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
  });

  it('keeps the last recorded blocking findings in the next review after a decision discards the review in between', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('bug', 'high', 'null-crash')]);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');

    commit(ws, 'ok', 'fixed\n');
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const second = await step(ws, run => startReview(ws, run));
    const discarded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(discarded.discarded, second.reviewId);

    const third = await step(ws, run => startReview(ws, run));
    assert.equal(third.reviewId, '01-r3');
    assert.match(readFileSync(third.dataFile, 'utf8'), /## FIX ITEMS\n\n[^\n]*\n\nEverything below is evidence[^\n]*\n\n- `bug-null-crash` \([^\n]*fixes\/01-f1\.md, round 1\): \[high\] ok:1: null-crash\n\n## IMPLEMENTER BEHAVIORS/);
  });

  it('refuses to complete a slice when a decision lands after its green review, until a new review goes green', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => recordDecisions(ws, run, ['Late decision.']));

    await assert.rejects(step(ws, run => completeSlice(ws, run)), /no green review yet/);
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, []);
    await step(ws, run => recordReview(ws, run));
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  /** A state file an older factory wrote: a decision recorded without the decide-time review reset. */
  const olderDecision = (ws: Workspace) => step(ws, run => void run.decisions.push({ author: 'user', text: 'Decision an older factory recorded.' }));

  it('reopens review on the green commit at completion when an older state file holds a decision newer than the green review', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    const greenSha = readRun(ws, 'demo').slices[0]?.checked?.sha;
    await olderDecision(ws);
    assert.match(nextAction(readRun(ws, 'demo')), /factory_review_start/);

    await assert.rejects(step(ws, run => completeSlice(ws, run)), /Decision 1 is newer than the green review/);
    const reopened = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reopened?.phase, reopened?.checked?.sha, reopened?.review], ['review', greenSha, undefined]);
  });

  it('opens a new review of the green commit without checks when an older state file holds a decision newer than the green review', async () => {
    using again = workspace();
    await newRun(again, [slice('Feature')]);
    await step(again, run => nextSlice(again, run));
    commit(again, 'ok');
    await green(again);
    const greenState = readRun(again, 'demo');
    const checked = greenState.slices[0]?.checked?.sha;
    const greenId = `${greenState.slices[0]?.id}-r${greenState.slices[0]?.reviews}`;
    const checkRuns = greenState.events.filter(event => event.kind.startsWith('checks')).length;
    await olderDecision(again);
    const opened = await step(again, run => startReview(again, run));
    const started = readRun(again, 'demo');
    const state = started.slices[0];
    assert.deepEqual([state?.phase, state?.checked?.sha, state?.review?.id, state?.review?.decisions], ['review', checked, opened.reviewId, 1]);
    assert.notEqual(opened.reviewId, greenId);
    assert.match(readFileSync(opened.dataFile, 'utf8'), /Decision an older factory recorded\./);
    assert.equal(started.events.filter(event => event.kind.startsWith('checks')).length, checkRuns);
  });

  it('discards a review at record time when an older state file holds a decision newer than it', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, []);
    await olderDecision(ws);

    await assert.rejects(step(ws, run => recordReview(ws, run)), /Decision 1 is newer than review/);
    const state = readRun(ws, 'demo');
    assert.equal(state.slices[0]?.review, undefined);
    assert.equal(state.slices[0]?.phase, 'review');
    assert.equal(state.events.at(-1)?.kind, 'review-invalidated');
  });

  it('opens a new review on the green commit without checks when a decision lands after the green review', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => recordDecisions(ws, run, ['Early decision.']));
    await green(ws);
    const first = readRun(ws, 'demo').slices[0];
    const greenId = `${first?.id}-r${first?.reviews}`;
    const greenSha = first?.checked?.sha;
    assert.equal(first?.phase, 'ready');
    assert.ok(greenSha && first?.green);
    const checkRuns = readRun(ws, 'demo').events.filter(event => event.kind.startsWith('checks')).length;
    const recorded = await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    assert.equal(recorded.discarded, undefined, 'no review is running, so no reviewer needs stopping');
    const reopened = readRun(ws, 'demo');
    assert.equal(reopened.slices[0]?.phase, 'review');
    assert.equal(reopened.slices[0]?.checked?.sha, greenSha);
    assert.equal(reopened.slices[0]?.green, undefined);
    assert.equal(reopened.slices[0]?.review, undefined);
    assert.equal(reopened.events.at(-1)?.kind, 'review-invalidated');
    assert.match(nextAction(reopened), /factory_review_start/);

    const opened = await step(ws, run => startReview(ws, run));
    const state = readRun(ws, 'demo');
    assert.notEqual(opened.reviewId, greenId);
    assert.equal(state.slices[0]?.phase, 'review');
    assert.equal(state.slices[0]?.checked?.sha, greenSha);
    assert.equal(state.slices[0]?.green, undefined);
    assert.equal(state.slices[0]?.review?.decisions, 2);
    assert.equal(state.events.filter(event => event.kind.startsWith('checks')).length, checkRuns);
    const data = readFileSync(opened.dataFile, 'utf8');
    assert.match(data, /Early decision\./);
    assert.match(data, /Late decision\./);
    await review(ws, opened.reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    assert.equal((await step(ws, run => completeSlice(ws, run))).status, 'done');
  });

  it('still refuses a review of a green slice with no newer decision, and sends a moved HEAD back to checks', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await assert.rejects(step(ws, run => startReview(ws, run)), /Checks must pass first/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');

    await step(ws, run => recordDecisions(ws, run, ['Late decision.']));
    const reopened = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reopened?.phase, reopened?.green], ['review', undefined]);
    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => startReview(ws, run)), /HEAD moved after checks passed/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'checks');
  });

  it('sends a ready slice from an older state file back to checks when HEAD moved from the green commit', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await olderDecision(ws);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
    commit(ws, 'late.txt');
    await assert.rejects(step(ws, run => startReview(ws, run)), /HEAD moved after checks passed/);
    const reset = readRun(ws, 'demo').slices[0];
    assert.deepEqual([reset?.phase, reset?.checked, reset?.green], ['checks', undefined, undefined]);
  });

  it('leaves the slice untouched when a decision lands with no open or green review', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const before = readRun(ws, 'demo').slices[0];
    const recorded = await step(ws, run => recordDecisions(ws, run, ['Early decision.']));
    assert.equal(recorded.discarded, undefined);
    assert.deepEqual(readRun(ws, 'demo').slices[0], before);
  });

  it('refuses a decision that names a done or unknown slice and records none of the batch', async () => {
    using ws = workspace();
    await newRun(ws, [slice('First'), slice('Second', ['First'])]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    const before = readRun(ws, 'demo');

    await assert.rejects(step(ws, run => recordDecisions(ws, run, ['Plain.', { slice: '01', text: 'Built by First.' }])), /Slice 01 is done/);
    await assert.rejects(step(ws, run => recordDecisions(ws, run, ['Plain.', { slice: '07', text: 'Built by nobody.' }])), /No slice 07/);
    const after = readRun(ws, 'demo');
    assert.deepEqual(after.decisions, []);
    assert.deepEqual(after.slices.map(item => item.ownsDecisions), [[], []]);
    assert.equal(after.events.length, before.events.length);
  });
});
