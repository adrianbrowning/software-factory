import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keptFindings, type Validation, validationSchema } from '../src/review-record.ts';
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
      error => error instanceof Error
        && /"path":\s*\[\s*"decision"\s*\]/.test(error.message)
        && /expected number, received string/.test(error.message)
        && !/exactly one/.test(error.message),
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

describe('Validation escalate entry type', () => {
  it('has no state with both decision and criterion', () => {
    const both = { criterion: 'c', decision: 1, id: 'bug-a', reason: 'r' };
    // @ts-expect-error an entry with both fields is not a Validation escalate entry
    const validation: Validation = { dropped: [], downgrade: [], escalate: [both], keep: [] };
    assert.ok(validation);
  });
});
