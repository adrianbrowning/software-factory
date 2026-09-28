import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReviewReport, parseSkillReview, parseTaggedReview } from '../drop-in/factory.js';

const finding = {
  evidence: 'The error is ignored.',
  file: 'src/example.ts',
  line: 12,
  recommendation: 'Handle the error.',
  severity: 'high',
  title: 'Ignored error',
};

const skillFinding = {
  domain: 'bug',
  fix: 'Handle the error.',
  fix_prompt: 'Handle the error in src/example.ts at line 12.',
  id: 'bug-ignored-error',
  line: 12,
  path: 'src/example.ts',
  problem: 'The error is ignored.',
  severity: 'high',
  title: 'Ignored error',
};

function skillReview(findings: unknown[]) {
  return {
    counts: { critical: 0, high: findings.length, observations: 0 },
    findings,
    summary: 'Reviewed.',
    verdict: findings.length > 0 ? 'APPROVED_WITH_SUGGESTIONS' : 'APPROVED',
  };
}

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

test('parseSkillReview maps skill findings to the internal review contract', () => {
  assert.deepEqual(parseSkillReview(skillReview([skillFinding])), {
    findings: [{
      evidence: 'The error is ignored.',
      file: 'src/example.ts',
      line: 12,
      recommendation: 'Handle the error.',
      severity: 'high',
      title: 'Ignored error',
    }],
  });
});

test('parseSkillReview maps observation severity to low and omits missing lines as null', () => {
  assert.deepEqual(
    parseSkillReview(skillReview([{ ...skillFinding, line: undefined, severity: 'observation' }])),
    {
      findings: [{
        evidence: 'The error is ignored.',
        file: 'src/example.ts',
        line: null,
        recommendation: 'Handle the error.',
        severity: 'low',
        title: 'Ignored error',
      }],
    },
  );
});

test('parseSkillReview rejects a malformed skill review shape', () => {
  assert.throws(
    () => parseSkillReview(skillReview([{ ...skillFinding, severity: 'urgent' }])),
    /invalid review report/i,
  );
  assert.throws(() => parseSkillReview({ findings: [] }), /invalid review report/i);
  assert.throws(() => parseSkillReview(null), /invalid review report/i);
});

test('tagged review parsing decodes the skill review shape', () => {
  assert.deepEqual(
    parseTaggedReview(`<review>${JSON.stringify(skillReview([skillFinding]))}</review>`),
    { findings: [finding] },
  );
  assert.throws(
    () => parseTaggedReview(`<review>${JSON.stringify(skillReview([{ ...skillFinding, severity: 'urgent' }]))}</review>`),
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
