import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fixAfterGreen } from '../src/observations.ts';
import { placeObservationBatch, planPlace } from '../src/place.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, newRun, review, slice, step, workspace } from './helpers.ts';

const LABEL = 'Validator warning on the suggested fix (meet the recorded decisions and acceptance criteria as written, not a narrower fix): ';
const W1 = 'The fix prompt rejects a name that starts with an underscore, which decision 1 allows.';
const W2 = 'The fix prompt drops the strict mode that criterion 2 names.';
const W3 = 'The fix prompt narrows the downgraded case.';

/** The fix-file section of finding `id` (from its `### ` heading up to the next one). */
const sectionOf = (fix: string, id: string) => fix.split(/^### /m).find(part => part.includes(`] ${id}\n`)) ?? '';
const warningLines = (section: string) => section.split('\n').filter(row => row.startsWith('- Validator warning'));

async function startSlice(ws: ReturnType<typeof workspace>) {
  await newRun(ws, [slice('Feature')]);
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 'ok');
  await step(ws, run => runChecks(ws, run));
}

describe('observation fix round shows the validator fix warning', { concurrency: 4 }, () => {
  it('puts the warning once in the section of a warned observation and a downgraded finding, and none in an unwarned one', async () => {
    using ws = workspace();
    await startSlice(ws);
    const { reviewId } = await step(ws, run => startReview(ws, run));
    const findings = [finding('thermo', 'observation', 'warned'), finding('thermo', 'observation', 'plain'), finding('thermo', 'high', 'down')];
    await review(ws, reviewId, findings, ['thermo-warned', 'thermo-plain'], undefined, {
      downgrade: [{ category: 'naming', id: 'thermo-down', reason: 'minor' }],
      fixWarnings: [{ id: 'thermo-warned', warning: W1 }, { id: 'thermo-down', warning: W3 }],
    });
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-warned', 'thermo-plain', 'thermo-down'] }, 'tidy'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-warned')), [`- ${LABEL}${W1}`]);
    assert.ok(!sectionOf(fix, 'thermo-warned').includes(`${W1}.`), 'no doubled period');
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-plain')), []);
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-down')), [`- ${LABEL}${W3}`]);
  });

  it('gives each observation the warning of the review that kept it, red reviews included', async () => {
    using ws = workspace();
    await startSlice(ws);
    const red = await step(ws, run => startReview(ws, run));
    await review(ws, red.reviewId, [finding('security', 'high', 'leak'), finding('thermo', 'observation', 'early')], undefined, undefined, { fixWarnings: [{ id: 'thermo-early', warning: W1 }] });
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'fix');
    commit(ws, 'more');
    await step(ws, run => runChecks(ws, run));
    const next = await step(ws, run => startReview(ws, run));
    await review(ws, next.reviewId, [{ ...finding('security', 'observation', 'late'), path: 'more' }], undefined, undefined, { fixWarnings: [{ id: 'security-late', warning: W2 }] });
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    const fixed = await step(ws, run => fixAfterGreen(ws, run, { observations: ['thermo-early', 'security-late'] }, 'tidy'));
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-early')), [`- ${LABEL}${W1}`]);
    assert.deepEqual(warningLines(sectionOf(fix, 'security-late')), [`- ${LABEL}${W2}`]);
  });

  it('shows the warning for a fix placement of factory_place', async () => {
    using ws = workspace();
    await startSlice(ws);
    const { reviewId } = await step(ws, run => startReview(ws, run));
    await review(ws, reviewId, [finding('thermo', 'observation', 'warned'), finding('thermo', 'observation', 'plain')], undefined, undefined, { fixWarnings: [{ id: 'thermo-warned', warning: W1 }] });
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    const fixed = await step(ws, async run => {
      const placed = await placeObservationBatch(ws, run, planPlace(ws, run, { placements: [{ id: 'thermo-warned', placement: 'fix' }, { id: 'thermo-plain', placement: 'fix' }] }));
      return fixAfterGreen(ws, run, { observations: placed.fixes }, 'Chosen in the batched placement.');
    });
    const fix = readFileSync(fixed.fixPath, 'utf8');
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-warned')), [`- ${LABEL}${W1}`]);
    assert.deepEqual(warningLines(sectionOf(fix, 'thermo-plain')), []);
  });
});
