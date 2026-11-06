import './git-env.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Finding, type FixVerdict, readRun, type Workspace } from '../src/run.ts';
import { fixObservations, recordDecisions, recordReview, runChecks, startReview, submitDomain } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, fixItems, greenWithObservation, newRun, review, sh, slice, step, workspace } from './helpers.ts';

describe('fix items', { concurrency: 4 }, () => {
  it('numbers two failed checks of one round check-f1-1 and check-f1-2, in check order', async () => {
    using ws = workspace({ checks: ['test -f ok', 'test -f other'] });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    const red = await step(ws, run => runChecks(ws, run));
    assert.ok(!red.passed);
    assert.match(readFileSync(red.fixPath, 'utf8'), /## Fix items\n\n- `check-f1-1`: test -f ok: failed \(exit 1\)[^\n]*\n- `check-f1-2`: test -f other: failed \(exit 1\)[^\n]*\n\n## test -f ok: failed/);
  });

  it('clears the fix items of a red checks round when a green review records, so the next review lists only the new ones', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    assert.ok(!(await step(ws, run => runChecks(ws, run))).passed);
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);

    await step(ws, run => fixObservations(ws, run, { bug: 'Crash.', observations: ['thermo-naming'] }, 'Fix both now.'));
    commit(ws, 'ok', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const items = fixItems((await step(ws, run => startReview(ws, run))).dataFile);
    assert.doesNotMatch(items, /check-f1-1/);
    assert.match(items, /- `bug-f2` \([^\n]*fixes\/01-f2\.md, round 2\)/);
    assert.match(items, /- `thermo-naming` \([^\n]*fixes\/01-f2\.md, round 2\)/);
  });

  it('lists the chosen observations and the bug from a green review as fix items of the next review', async () => {
    using ws = workspace({ maxRounds: 2 });
    await greenWithObservation(ws);
    assert.equal(fixItems(join(ws.root, '.scratch', 'demo', 'reviews', '01-r1', 'data.md')), 'None.\n', 'a first review has no fix items');
    const fixed = await step(ws, run => fixObservations(ws, run, { bug: 'Empty input\n  crashes.', observations: ['thermo-naming'] }, 'Fix both now.'));
    const fixFile = readFileSync(fixed.fixPath, 'utf8');
    assert.match(fixFile, /## Fix items\n\n[^#]*`bug-f1`[^#]*`thermo-naming`/);
    assert.match(fixFile, /## Observations from green review 01-r1 the user chose to fix\n\nFix both now\.\n\n### \[observation\] thermo-naming\n/, 'observations sit at the level of blocking findings');

    commit(ws, 'ok', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const items = fixItems((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(items, /- `bug-f1` \([^\n]*fixes\/01-f1\.md, round 1\): Bug found after green review 01-r1: Empty input crashes\.\n/);
    assert.match(items, /- `thermo-naming` \([^\n]*fixes\/01-f1\.md, round 1\): \[observation\] ok:1: naming\n/);
  });

  it('keeps the blocking findings as fix items through a red checks round, beside the failed checks', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('bug', 'high', 'null-crash')]);
    const blocked = await step(ws, run => recordReview(ws, run));
    assert.ok(!blocked.green);
    assert.match(
      readFileSync(blocked.fixPath, 'utf8'),
      /## Fix items\n\n- `bug-null-crash`: [^\n]*\n\n## Blocking review findings from 01-r1\n\n### \[high\] bug-null-crash\n/,
      'the findings sit in their own section after the fix items',
    );

    sh(ws.root, 'rm', '-q', 'ok');
    sh(ws.root, 'commit', '-qm', 'break');
    const red = await step(ws, run => runChecks(ws, run));
    assert.ok(!red.passed);
    assert.match(readFileSync(red.fixPath, 'utf8'), /## Fix items\n\n- `check-f2-1`: test -f ok: failed \(exit 1\)/);

    commit(ws, 'ok', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const items = fixItems((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(items, /- `bug-null-crash` \([^\n]*fixes\/01-f1\.md, round 1\): \[high\] ok:1: null-crash\n/);
    assert.match(items, /- `check-f2-1` \([^\n]*fixes\/01-f2\.md, round 2\): test -f ok: failed \(exit 1\) in \d+ms\n/);
  });
});

describe('fix item verdicts', { concurrency: 4 }, () => {
  /**
   * Opens the second review of a slice in `ws` whose first review blocked on bug-a and bug-b, so it lists both as fix
   * items. `decisions` are recorded before the first review. `ws` needs a round limit of at least 2.
   */
  async function reviewOfFixItems(ws: Workspace, decisions: string[] = []) {
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    if (decisions.length > 0) await step(ws, run => recordDecisions(ws, run, decisions));
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('bug', 'high', 'a'), finding('bug', 'high', 'b')]);
    assert.ok(!(await step(ws, run => recordReview(ws, run))).green);
    commit(ws, 'ok', 'fixed\n');
    await step(ws, run => runChecks(ws, run));
    const opened = await step(ws, run => startReview(ws, run));
    const submit = (domain: Finding['domain'], verdicts: unknown) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: [], fixItems: verdicts, reviewId: opened.reviewId }));
    return { ...opened, submit };
  }

  const fixed = (id: string): FixVerdict => ({ id, reason: 'the diff guards the null', status: 'fixed' });

  it('tells the scope reviewer to give a verdict for every fix item', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { dataFile } = await reviewOfFixItems(ws);
    const items = fixItems(dataFile);
    assert.match(items, /scope reviewer gives each item a verdict/);
    assert.match(items, /fixed, not-a-defect, waived, or open/);
    assert.doesNotMatch(items, /leave out one the fix resolved/);
  });

  it('refuses a scope submission without a verdict for each fix item, naming the missing ids', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { submit } = await reviewOfFixItems(ws);
    await assert.rejects(submit('scope', []), /Give a verdict for every fix item\. Missing: bug-a, bug-b/);
    await assert.rejects(submit('scope', [fixed('bug-a')]), /Missing: bug-b$/);
    assert.equal(await submit('scope', [fixed('bug-a'), fixed('bug-b')]), 0);
  });

  it('refuses an unknown or repeated id, a waiver without an existing decision, and verdicts from another domain', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { submit } = await reviewOfFixItems(ws, ['Null input is out of scope.']);
    await assert.rejects(submit('scope', [fixed('bug-a'), fixed('bug-b'), fixed('bug-c')]), /Unknown fix item ids: bug-c/);
    await assert.rejects(submit('scope', [fixed('bug-a'), fixed('bug-b'), fixed('bug-a')]), /Fix item "bug-a" has more than one verdict/);
    const waived = (decision?: number) => ({ id: 'bug-b', reason: 'the user accepted it', status: 'waived', ...(decision === undefined ? {} : { decision }) });
    await assert.rejects(submit('scope', [fixed('bug-a'), waived()]), /"decision"[^]*expected number, received undefined/, 'a waived item names a decision');
    await assert.rejects(submit('scope', [fixed('bug-a'), waived(2)]), /Fix item "bug-b" names decision 2, but the review data lists 1 decisions/);
    await assert.rejects(submit('scope', [{ ...fixed('bug-a'), decision: 1 }, fixed('bug-b')]), /Unrecognized key: \\"decision\\"/, 'only a waived item names a decision');
    await assert.rejects(submit('bug', [fixed('bug-a'), fixed('bug-b')]), /Only the scope domain gives fix item verdicts/);
    assert.equal(await submit('scope', [fixed('bug-a'), waived(1)]), 0);
  });

  it('blocks on an open fix item with no blocking finding, and carries it into the next fix file and review', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { dataFile, reviewId } = await reviewOfFixItems(ws);
    const open = { id: 'bug-b', reason: 'Unreachable is claimed, but parse still passes null', status: 'open' } as const;
    await review(ws, reviewId, [finding('thermo', 'observation', 'naming')], ['thermo-naming'], [fixed('bug-a'), open]);
    const recorded = await step(ws, run => recordReview(ws, run));
    assert.ok(!recorded.green);
    const stored = JSON.parse(readFileSync(join(dataFile, '..', 'review.json'), 'utf8'));
    assert.equal(stored.verdict, 'CHANGES_REQUESTED');
    assert.deepEqual(stored.fixItems, [fixed('bug-a'), open]);

    const fix = readFileSync(recorded.fixPath, 'utf8');
    assert.match(fix, /## Fix items\n\n- `bug-b`: \[high\] ok:1: b\n\n/);
    assert.doesNotMatch(fix, /`bug-a`/);
    assert.match(fix, /## Open fix items from 01-r2\n\n### `bug-b`\n\n- Asked in: [^\n]*fixes\/01-f1\.md \(round 1\)\n- Item: \[high\] ok:1: b\n- Scope reviewer: Unreachable is claimed, but parse still passes null/);

    commit(ws, 'ok', 'fixed again\n');
    await step(ws, run => runChecks(ws, run));
    const next = fixItems((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(next, /- `bug-b` \([^\n]*fixes\/01-f2\.md, round 2\): \[high\] ok:1: b\n/);
    assert.doesNotMatch(next, /bug-a/);
  });

  it('lists an open fix item once when a blocking finding repeats its id', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { reviewId } = await reviewOfFixItems(ws);
    await review(ws, reviewId, [finding('bug', 'high', 'b')], ['bug-b'], [fixed('bug-a'), { id: 'bug-b', reason: 'still crashes', status: 'open' }]);
    const recorded = await step(ws, run => recordReview(ws, run));
    assert.ok(!recorded.green);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixItems.filter(item => item.id === 'bug-b').length, 1);
  });

  it('goes green when every fix item is fixed, not a defect, or waived, and no finding blocks', async () => {
    using ws = workspace({ maxRounds: 3 });
    const { dataFile, reviewId } = await reviewOfFixItems(ws, ['Null input is out of scope.']);
    const verdicts: FixVerdict[] = [
      { id: 'bug-a', reason: 'parse never receives null: the caller at src/p.ts:3 checks it', status: 'not-a-defect' },
      { decision: 1, id: 'bug-b', reason: 'decision 1 accepts it', status: 'waived' },
    ];
    await review(ws, reviewId, [], [], verdicts);
    assert.ok((await step(ws, run => recordReview(ws, run))).green);
    const stored = JSON.parse(readFileSync(join(dataFile, '..', 'review.json'), 'utf8'));
    assert.equal(stored.verdict, 'APPROVED');
    assert.deepEqual(stored.fixItems, verdicts);
  });

  it('requires a fixItems list on every scope submission, empty when the review lists no fix items', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const { reviewId } = await step(ws, run => startReview(ws, run));
    const submit = (domain: Finding['domain'], extra: { fixItems?: unknown }) => step(ws, run => submitDomain(ws, run, { agentId: 'r', domain, findings: [], reviewId, ...extra }));
    await assert.rejects(submit('scope', {}), /The scope domain gives fixItems: a verdict for each FIX ITEMS id, \[\] when the review data lists none/);
    await assert.rejects(submit('bug', { fixItems: [] }), /Only the scope domain gives fix item verdicts/);
    assert.equal(await submit('scope', { fixItems: [] }), 0);
  });
});
