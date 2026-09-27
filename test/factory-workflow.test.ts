import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.js';

const issue = {
  body: 'Return a useful error when configuration is missing.',
  number: 42,
  title: 'Handle missing configuration',
  url: 'https://github.com/acme/example/issues/42',
};

test('implements an issue, checks it, processes findings, and verifies fixes', async () => {
  const events: string[] = [];
  let reviewNumber = 0;
  const result = await runFactory({
    baseRef: 'origin/main',
    checks: ['pnpm lint', 'pnpm typecheck', 'pnpm test'],
    execute: async command => {
      events.push(`check:${command}`);
      return { exitCode: 0, stderr: '', stdout: `${command} passed` };
    },
    fix: async prompt => {
      events.push('fix');
      assert.match(prompt, /Ignored error/);
    },
    implement: async prompt => {
      events.push('implement');
      assert.match(prompt, /Handle missing configuration/);
      assert.match(prompt, /issues\/42/);
    },
    issue,
    maxRounds: 2,
    review: async prompt => {
      events.push('review');
      assert.match(prompt, /origin\/main\.\.\.HEAD/);
      reviewNumber += 1;
      return reviewNumber === 1
        ? {
            findings: [{
              evidence: 'The return value is ignored.',
              file: 'src/example.ts',
              line: 12,
              recommendation: 'Handle the returned error.',
              severity: 'high' as const,
              title: 'Ignored error',
            }],
          }
        : { findings: [] };
    },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.rounds, 2);
  assert.deepEqual(events, [
    'implement',
    'check:pnpm lint',
    'check:pnpm typecheck',
    'check:pnpm test',
    'review',
    'fix',
    'check:pnpm lint',
    'check:pnpm typecheck',
    'check:pnpm test',
    'review',
  ]);
});

test('repairs and rechecks deterministic failures before review', async () => {
  const events: string[] = [];
  let checkNumber = 0;
  const result = await runFactory({
    baseRef: 'main',
    checks: ['pnpm test'],
    execute: async () => {
      events.push('check');
      checkNumber += 1;
      return checkNumber === 1
        ? { exitCode: 1, stderr: 'test failed', stdout: '' }
        : { exitCode: 0, stderr: '', stdout: 'test passed' };
    },
    fix: async prompt => {
      events.push('fix');
      assert.match(prompt, /test failed/);
    },
    implement: async () => {
      events.push('implement');
    },
    issue,
    maxRounds: 2,
    review: async () => {
      events.push('review');
      return { findings: [] };
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(events, ['implement', 'check', 'fix', 'check', 'review']);
});

test('returns a failing result when the final round is not clean', async () => {
  const result = await runFactory({
    baseRef: 'main',
    checks: ['pnpm test'],
    execute: async () => ({ exitCode: 1, stderr: 'test failed', stdout: '' }),
    fix: async () => {},
    implement: async () => {},
    issue,
    maxRounds: 1,
    review: async () => {
      throw new Error('review must not run while checks are failing');
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.rounds, 1);
  assert.equal(result.checks[0]?.exitCode, 1);
  assert.equal(result.findings.length, 0);
});
