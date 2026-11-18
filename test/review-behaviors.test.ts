import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { submitImplementerReport } from '../src/report.ts';
import { runChecks, startReview } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, newRun, slice, step, workspace } from './helpers.ts';

/** The text of the data file's `## IMPLEMENTER BEHAVIORS` section, up to the next `## ` heading. */
function behaviorsSection(dataFile: string) {
  const data = readFileSync(dataFile, 'utf8');
  const start = data.indexOf('## IMPLEMENTER BEHAVIORS');
  assert.notEqual(start, -1, 'the data file has an IMPLEMENTER BEHAVIORS section');
  const rest = data.slice(start + 3);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('review data file: implementer behaviors', { concurrency: 4 }, () => {
  it('lists the stored report behaviors with their seen-red marks as untrusted claims, and nothing else of the report', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, async run =>
      submitImplementerReport(ws, run, {
        behaviors: [
          { behavior: 'does a', red: 'a threw', seenRed: true, test: 'a' },
          { behavior: 'does b', seenRed: false, test: 'b' },
        ],
        commits: ['abc1234 01: secret-commit-subject'],
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
});
