import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderFinding } from '../src/finding-text.ts';
import { keptFindings, type Validation, validationSchema } from '../src/review-record.ts';
import type { Finding } from '../src/run.ts';
import { finding } from './helpers.ts';

describe('validation escalate entry', () => {
  const base = { dropped: [], keep: [] };
  const entry = { id: 'bug-a', reason: 'r' };
  const parse = (escalate: object[]) => validationSchema.parse({ ...base, escalate });

  it('rejects an entry with neither decision nor criterion, naming the id and both fields', () => {
    assert.throws(() => parse([entry]), /bug-a.*decision.*criterion/);
  });

  it('rejects an entry with both decision and criterion, naming the id and both fields', () => {
    assert.throws(() => parse([{ ...entry, criterion: 'c', decision: 1 }]), /bug-a.*decision.*criterion/);
  });

  it('gives a field error, not the exactly-one message, for a wrong-typed decision', () => {
    assert.throws(
      () => parse([{ ...entry, decision: '1' }]),
      error => {
        if (!(error instanceof Error) || /exactly one/.test(error.message)) return false;
        type Issue = { errors?: Issue[][]; expected?: string; message?: string; path?: unknown[] };
        const flatten = (issues: Issue[]): Issue[] => issues.flatMap(issue => [issue, ...flatten((issue.errors ?? []).flat())]);
        return flatten(JSON.parse(error.message) as Issue[]).some(issue =>
          issue.path?.length === 1 && issue.path[0] === 'decision'
          && (issue.expected === 'number' || /expected number, received string/.test(issue.message ?? '')));
      },
    );
  });

  it('strips an unknown key from an entry with one valid field', () => {
    const [parsed] = parse([{ ...entry, decision: 1, extra: true }]).escalate;
    assert.deepEqual(parsed, { decision: 1, id: 'bug-a', reason: 'r' });
  });

  it('keeps an escalated finding as high carrying its decision or its criterion', () => {
    const findings = [finding('bug', 'observation', 'a'), finding('bug', 'observation', 'b')];
    const kept = keptFindings(findings, parse([{ decision: 2, id: 'bug-a', reason: 'r' }, { criterion: 'quoted', id: 'bug-b', reason: 'r' }]));
    assert.deepEqual(kept.map(({ criterion, decision, id, severity }) => ({ criterion, decision, id, severity })), [
      { criterion: undefined, decision: 2, id: 'bug-a', severity: 'high' },
      { criterion: 'quoted', decision: undefined, id: 'bug-b', severity: 'high' },
    ]);
  });
});

describe('keptFindings downgrade with decisionMatch', () => {
  it('leaves the decision out of a finding downgraded with decisionMatch', () => {
    const cited = { ...finding('bug', 'high', 'a'), category: 'correctness' as const, decision: 1 };
    const [kept] = keptFindings([cited], validationSchema.parse({ downgrade: [{ decisionMatch: 'x', id: 'bug-a', reason: 'r' }], dropped: [], keep: [] }));
    assert.equal(kept?.severity, 'observation');
    assert.equal('decision' in (kept ?? {}), false);
    assert.doesNotMatch(renderFinding(kept as Finding, [{ author: 'user', text: 'T' }]), /Breaks decision/);
  });
});

describe('Validation escalate entry type', () => {
  it('has no state with both decision and criterion', () => {
    const both = { criterion: 'c', decision: 1, id: 'bug-a', reason: 'r' };
    const one = { criterion: 'c', id: 'bug-a', reason: 'r' };
    const control: Validation = { dropped: [], downgrade: [], escalate: [one], fixWarnings: [], keep: [] };
    assert.ok(control);
    // @ts-expect-error an entry with both fields is not a Validation escalate entry
    const validation: Validation = { dropped: [], downgrade: [], escalate: [both], fixWarnings: [], keep: [] };
    assert.ok(validation);
  });
});
