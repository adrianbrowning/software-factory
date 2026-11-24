import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keptFindings, validationSchema } from '../src/review-record.ts';
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

  it('keeps an escalated finding as high carrying its decision or its criterion', () => {
    const findings = [finding('bug', 'observation', 'a'), finding('bug', 'observation', 'b')];
    const kept = keptFindings(findings, parse([{ decision: 2, id: 'bug-a', reason: 'r' }, { criterion: 'quoted', id: 'bug-b', reason: 'r' }]));
    assert.deepEqual(kept.map(({ criterion, decision, id, severity }) => ({ criterion, decision, id, severity })), [
      { criterion: undefined, decision: 2, id: 'bug-a', severity: 'high' },
      { criterion: 'quoted', decision: undefined, id: 'bug-b', severity: 'high' },
    ]);
  });
});
