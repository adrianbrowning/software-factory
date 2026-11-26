import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { type Finding, REVIEW_DOMAINS, type Workspace } from '../src/run.ts';
import { recordDecisions, recordReview, runChecks, startReview, submitDomain, submitValidation } from '../src/review.ts';
import { validationFile } from '../src/review-record.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, newRun, noFixItems, slice, step, workspace } from './helpers.ts';

const WARNING = "The Fix prompt's [A-Za-z0-9] rejects a reason that starts with ( or #, which decision 1 allows.";
const LINE = 'Validator warning on the suggested fix (meet the cited decision or acceptance criterion as written, not a narrower fix): ';

describe('validator fix warnings', { concurrency: 4 }, () => {
  /** An open review with these findings submitted by their domains; resolves to the review id. */
  async function submitted(ws: Workspace, findings: Finding[]) {
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => recordDecisions(ws, run, ['Accept any reason.']));
    await step(ws, run => runChecks(ws, run));
    const { reviewId } = await step(ws, run => startReview(ws, run, [], ['react-ts', 'test-validity', 'devops']));
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: findings.filter(item => item.domain === domain), reviewId, ...noFixItems(domain) }));
    }
    return reviewId;
  }

  const validate = (ws: Workspace, reviewId: string, input: { downgrade?: unknown; dropped?: unknown; escalate?: unknown; fixWarnings?: unknown; keep: string[] }) =>
    step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], ...input, reviewId }));
  const warn = (...ids: string[]) => ids.map(id => ({ id, warning: WARNING }));

  const mixed = () => [
    { ...finding('bug', 'high', 'a'), decision: 1 },
    finding('bug', 'critical', 'b'),
    finding('bug', 'observation', 'obs'),
    finding('bug', 'high', 'down'),
    finding('bug', 'high', 'gone'),
    finding('bug', 'observation', 'esc'),
  ];
  const base = { downgrade: [{ id: 'bug-down', reason: 'minor', category: 'naming' }], dropped: [{ id: 'bug-gone', reason: 'not in diff' }], keep: ['bug-a', 'bug-b', 'bug-obs'] };

  it('accepts fixWarnings for a kept blocking and an escalated finding, and without fixWarnings', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed());
    const escalate = [{ decision: 1, id: 'bug-esc', reason: 'breaks it' }];
    const stored = async () => {
      const file = await step(ws, run => validationFile(ws, run, reviewId));
      return JSON.parse(readFileSync(file, 'utf8')) as { fixWarnings: unknown };
    };
    await validate(ws, reviewId, { ...base, escalate });
    assert.deepEqual((await stored()).fixWarnings, []);
    await validate(ws, reviewId, { ...base, escalate, fixWarnings: warn('bug-a', 'bug-esc') });
    assert.deepEqual((await stored()).fixWarnings, warn('bug-a', 'bug-esc'));
  });

  it('writes the warning of an escalated observation in its fix-file section', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed());
    await validate(ws, reviewId, { ...base, escalate: [{ decision: 1, id: 'bug-esc', reason: 'breaks it' }], fixWarnings: warn('bug-esc') });
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    const section = readFileSync(result.fixPath, 'utf8')
      .split(/^### /m)
      .find(part => part.includes('] bug-esc\n'));
    assert.ok(section !== undefined);
    assert.ok(section.split('\n').includes(`- ${LINE}${WARNING}`));
  });

  it('stores fixWarnings for a kept observation, a downgraded and an escalated finding', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed());
    await validate(ws, reviewId, { ...base, escalate: [{ decision: 1, id: 'bug-esc', reason: 'x' }], fixWarnings: warn('bug-obs', 'bug-down', 'bug-esc') });
    const file = await step(ws, run => validationFile(ws, run, reviewId));
    const stored: { fixWarnings: unknown } = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(stored.fixWarnings, warn('bug-obs', 'bug-down', 'bug-esc'));
  });

  it('refuses a fixWarnings id the validation does not keep, naming the id', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed());
    for (const id of ['bug-gone', 'bug-invented']) {
      await assert.rejects(
        validate(ws, reviewId, { ...base, escalate: [{ decision: 1, id: 'bug-esc', reason: 'x' }], fixWarnings: warn(id) }),
        new RegExp(`^Error: A fixWarnings id must name a finding the validation keeps \\(in keep, downgrade or escalate\\): ${id}$`),
      );
    }
  });

  it('refuses a fixWarnings list that names one id twice, naming the id', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed());
    await assert.rejects(validate(ws, reviewId, { ...base, escalate: [{ decision: 1, id: 'bug-esc', reason: 'x' }], fixWarnings: warn('bug-a', 'bug-a') }), /^Error: A fixWarnings id appears twice: bug-a$/);
  });

  it('writes the warning only in the warned finding section, after the decision line and before the sibling note', async () => {
    using ws = workspace();
    const findings = [...mixed().slice(0, 2), { ...finding('comments', 'high', 'stale'), decision: 1 }];
    const reviewId = await submitted(ws, findings);
    await validate(ws, reviewId, { keep: ['bug-a', 'bug-b', 'comments-stale'], fixWarnings: warn('bug-a', 'comments-stale') });
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    const fix = readFileSync(result.fixPath, 'utf8');
    const section = (id: string) => fix.split(/^### /m).find(part => part.includes(`] ${id}\n`)) ?? '';
    const lineOf = (text: string) => text.split('\n').find(row => row.startsWith('- Validator warning')) ?? '';
    assert.equal(lineOf(section('bug-a')), `- ${LINE}${WARNING}`);
    assert.equal(lineOf(section('bug-b')), '');
    const bug = section('bug-a');
    const bugDecisionAt = bug.indexOf('- Breaks decision 1:');
    assert.ok(bugDecisionAt >= 0);
    assert.ok(bugDecisionAt < bug.indexOf('- Validator warning'));
    const comments = section('comments-stale');
    const decisionAt = comments.indexOf('- Breaks decision 1:');
    const warningAt = comments.indexOf('- Validator warning');
    const siblingAt = comments.indexOf('- Sibling comments:');
    assert.ok(decisionAt >= 0 && warningAt >= 0 && siblingAt >= 0);
    assert.ok(decisionAt < warningAt && warningAt < siblingAt);
  });

  it('renders a long multi-line warning on one line cut at 1,000 characters', async () => {
    using ws = workspace();
    const reviewId = await submitted(ws, mixed().slice(0, 1));
    const warning = `first line\n${'x'.repeat(1_500)}`;
    await validate(ws, reviewId, { keep: ['bug-a'], fixWarnings: [{ id: 'bug-a', warning }] });
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    const row = readFileSync(result.fixPath, 'utf8').split('\n').find(line => line.startsWith('- Validator warning')) ?? '';
    assert.equal(row, `- ${LINE}first line ${'x'.repeat(1_000 - 'first line '.length)}…`);
  });
});
