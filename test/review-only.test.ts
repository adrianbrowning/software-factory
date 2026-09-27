import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.js';
import { parseArguments } from '../drop-in/github-issue.js';

test('parses the review-only flag with one issue reference', () => {
  assert.deepEqual(parseArguments(['42', '--review-only']), {
    issueReference: '42',
    reviewOnly: true,
  });
  assert.deepEqual(parseArguments(['owner/repo#7']), {
    issueReference: 'owner/repo#7',
    reviewOnly: false,
  });
  assert.throws(() => parseArguments(['42', '--unknown']), /usage/i);
  assert.throws(() => parseArguments(['42', '43']), /usage/i);
});

test('review-only skips implementation but still runs checks and review', async () => {
  const events: string[] = [];
  const status: string[] = [];
  const result = await runFactory({
    baseRef: 'main',
    checks: ['pnpm test'],
    execute: async () => {
      events.push('check');
      return { exitCode: 0, stderr: '', stdout: 'passed' };
    },
    fix: async () => {
      events.push('fix');
    },
    implement: async () => {
      events.push('implement');
    },
    issue: {
      body: 'Requested behavior',
      number: 42,
      title: 'Add behavior',
      url: 'https://github.com/acme/example/issues/42',
    },
    maxRounds: 1,
    mode: 'review-only',
    onStatus: message => status.push(message),
    review: async () => {
      events.push('review');
      return { findings: [] };
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(events, ['check', 'review']);
  assert.equal(status[0], '[review-only] Skipping implementation');
});
