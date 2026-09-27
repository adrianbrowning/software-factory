import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReviewReport, parseTaggedReview } from '../drop-in/factory.js';

const finding = {
  evidence: 'The error is ignored.',
  file: 'src/example.ts',
  line: 12,
  recommendation: 'Handle the error.',
  severity: 'high',
  title: 'Ignored error',
};

test('the review contract accepts positive integer and null lines', () => {
  assert.deepEqual(parseReviewReport({ findings: [finding] }), { findings: [finding] });
  assert.deepEqual(parseReviewReport({ findings: [{ ...finding, line: null }] }), {
    findings: [{ ...finding, line: null }],
  });
});

test('the review contract rejects invalid findings', () => {
  const invalidFindings: unknown[] = [
    { ...finding, line: -1 },
    { ...finding, line: 1.5 },
    { ...finding, line: Number.POSITIVE_INFINITY },
    { ...finding, line: Number.NaN },
    { ...finding, severity: 'urgent' },
    { ...finding, evidence: 42 },
    null,
  ];

  for (const invalidFinding of invalidFindings) {
    assert.throws(
      () => parseReviewReport({ findings: [invalidFinding] }),
      /invalid review report/i,
    );
  }
});

test('tagged review parsing uses the same runtime contract', () => {
  assert.deepEqual(
    parseTaggedReview(`<review>${JSON.stringify({ findings: [finding] })}</review>`),
    { findings: [finding] },
  );
  assert.throws(
    () => parseTaggedReview(`<review>${JSON.stringify({ findings: [{ ...finding, line: -1 }] })}</review>`),
    /invalid review report/i,
  );
  assert.throws(
    () => parseTaggedReview('<review>{not json}</review>'),
    /invalid review JSON/i,
  );
  assert.throws(
    () => parseTaggedReview('no tagged payload'),
    /did not return a <review> payload/i,
  );
});
