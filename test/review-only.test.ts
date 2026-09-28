import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.ts';
import { parseArguments } from '../drop-in/github-issue.ts';
import { factoryOptions } from './fixtures.ts';

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

test('parses a --file argument as an alternative to an issue reference', () => {
  assert.deepEqual(parseArguments(['--file', 'issue.md']), {
    filePath: 'issue.md',
    reviewOnly: false,
  });
  assert.deepEqual(parseArguments(['--file', 'issue.md', '--review-only']), {
    filePath: 'issue.md',
    reviewOnly: true,
  });
});

test('rejects both a file and an issue reference, neither, or a missing path', () => {
  assert.throws(() => parseArguments(['--file', 'issue.md', '42']), /usage/i);
  assert.throws(() => parseArguments(['--review-only']), /usage/i);
  assert.throws(() => parseArguments([]), /usage/i);
  assert.throws(() => parseArguments(['--file']), /usage/i);
  assert.throws(() => parseArguments(['--file', '--review-only']), /usage/i);
});

test('review-only skips implementation but still runs checks and review', async () => {
  const events: string[] = [];
  const status: string[] = [];
  const result = await runFactory(factoryOptions({
    execute: async () => {
      events.push('check');
      return { exitCode: 0, timedOut: false, stderr: '', stdout: 'passed' };
    },
    fix: async () => {
      events.push('fix');
    },
    implement: async () => {
      events.push('implement');
    },
    mode: 'review-only',
    onStatus: message => status.push(message),
    review: async () => {
      events.push('review');
      return { findings: [] };
    },
  }));

  assert.equal(result.status, 'passed');
  assert.deepEqual(events, ['check', 'review', 'check']);
  assert.equal(status[0], '[review-only] Skipping implementation');
});
