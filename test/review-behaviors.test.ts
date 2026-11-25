import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startImplementerSession, submitImplementerReport } from '../src/report.ts';
import { runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, dataSection, newRun, sh, slice, step, workspace } from './helpers.ts';

const behaviorsSection = (dataFile: string) => dataSection(dataFile, 'IMPLEMENTER BEHAVIORS');

describe('review data file: implementer behaviors', { concurrency: 4 }, () => {
  it('lists the stored report behaviors with their seen-red marks as untrusted claims, and nothing else of the report', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    const first = sh(ws.root, 'rev-parse', '--short=12', 'HEAD');
    await step(ws, async run =>
      submitImplementerReport(ws, run, {
        behaviors: [
          { behavior: 'does a', red: 'a threw', seenRed: true, test: 'a' },
          { behavior: 'does b', seenRed: false, test: 'b' },
        ],
        commits: [`${first} 01: secret-commit-subject`],
        open: ['NEEDS SEAM: secret-open-item'],
      }),
    );
    await step(ws, run => runChecks(ws, run));
    const section = behaviorsSection((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(section, /untrusted/i);
    assert.match(section, /- a → does a \(seen red: yes — a threw\)\n- b → does b \(seen red: no\)/);
    assert.doesNotMatch(section, /secret-commit-subject|secret-open-item|Commits:|Open:|Fix file items/);
  });

  it('says no implementer report was stored when none was', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const section = behaviorsSection((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(section, /No implementer report was stored/);
  });

  it('says None. when the stored report has no behaviors', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, async run => submitImplementerReport(ws, run, { behaviors: [], commits: [], open: ['NEEDS SEAM: x'] }));
    await step(ws, run => runChecks(ws, run));
    const section = behaviorsSection((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(section, /None\./);
    assert.doesNotMatch(section, /No implementer report was stored/);
  });
});

describe('review data file: ticket copy', () => {
  it('shows the noTestReason and the pinning sentence of a seamed slice', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature', undefined, { noTestReason: 'behavior stays the same' })]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const data = readFileSync((await step(ws, run => startReview(ws, run))).dataFile, 'utf8');
    assert.match(data, /No test needs to go red first: behavior stays the same\. Tests on this slice pin the existing behavior: write them on the old code first, see them green, keep them green, and report them with seenRed false\./);
  });
});

describe('review data file after a fix round', () => {
  it('lists only the fix round report behaviors, and keeps its fix file items out', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.test.ts');
    await step(ws, async run =>
      submitImplementerReport(ws, run, { behaviors: [{ behavior: 'first', red: 'boom', seenRed: true, test: 'old-test' }], commits: [], open: [] }),
    );
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    await step(ws, async run => startImplementerSession(ws, run));
    commit(ws, 'ok');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    await step(ws, async run =>
      submitImplementerReport(ws, run, {
        behaviors: [{ behavior: 'second', seenRed: false, test: 'new-test' }],
        commits: [`${sha.slice(0, 7)} 01: fix`],
        fixItems: ['check-f1-1: fixed in secret-fix-item'],
        open: [],
      }),
    );
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, true);
    const section = behaviorsSection((await step(ws, run => startReview(ws, run))).dataFile);
    assert.match(section, /- new-test → second \(seen red: no\)/);
    assert.doesNotMatch(section, /old-test|secret-fix-item/);
  });
});

describe('report test-file gate exemptions', () => {
  it('stores an empty report for a slice without seams', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Docs', [], { noTestReason: 'docs only', seams: [] })]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'doc.md');
    const stored = await step(ws, run => submitImplementerReport(ws, run, { behaviors: [], commits: [], open: [] }));
    assert.equal(stored.replaced, false);
  });

  it('stores a fix-mode report of a seamed slice with no behavior and no test file in the fix commit', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'work.test.ts');
    await step(ws, async run => submitImplementerReport(ws, run, { behaviors: [{ behavior: 'a', seenRed: true, red: 'failed', test: 't' }], commits: [], open: [] }));
    assert.equal((await step(ws, run => runChecks(ws, run))).passed, false);
    await step(ws, async run => startImplementerSession(ws, run));
    commit(ws, 'ok');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    const stored = await step(ws, run =>
      submitImplementerReport(ws, run, { behaviors: [], commits: [`${sha.slice(0, 7)} 01: fix`], fixItems: ['check-f1-1: already fixed'], open: [] }),
    );
    assert.match(readFileSync(stored.path, 'utf8'), /Behaviors:\n- none\n/);
  });
});
