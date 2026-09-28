import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.ts';
import { factoryOptions } from './fixtures.ts';

test('repair prompts and public results bound and redact check evidence', async () => {
  const secrets = [
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    'AKIA1234567890ABCDEF',
    'npm_abcdefghijklmnopqrstuvwxyz1234567890',
    ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
    'database-password',
  ];
  let checkRun = 0;
  let fixCalls = 0;
  let repairPrompt = '';

  const result = await runFactory(factoryOptions({
    execute: async () => {
      checkRun += 1;
      return checkRun === 1
        ? {
            exitCode: 1,
            timedOut: false,
            stderr: [
              `Authorization: Bearer ${secrets[0]}`,
              `GITHUB_TOKEN=${secrets[1]}`,
              `AWS_SECRET_ACCESS_KEY=${secrets[2]}`,
              `NPM_TOKEN=${secrets[3]}`,
              `Cookie: session=${secrets[4]}`,
              `DATABASE_URL=https://user:${secrets[5]}@example.com/db`,
              '-----BEGIN PRIVATE KEY-----private-material-----END PRIVATE KEY-----',
              'x'.repeat(8_000),
            ].join('\n'),
            stdout: `TOKEN=${secrets[0]}`,
          }
        : { exitCode: 0, timedOut: false, stderr: '', stdout: 'passed' };
    },
    fix: async prompt => {
      fixCalls += 1;
      repairPrompt = prompt;
    },
    maxRounds: 2,
  }));

  assert.equal(result.status, 'passed');
  assert.equal(fixCalls, 1);
  assert.match(repairPrompt, /\\u003cREDACTED\\u003e/);
  assert.match(repairPrompt, /\.\.\.\[truncated\]/);
  assert.ok(repairPrompt.length < 10_000);
  for (const secret of secrets) {
    assert.doesNotMatch(repairPrompt, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test('redacts final-failure check output and reviewer findings', async () => {
  const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
  const checkResult = await runFactory(factoryOptions({
    execute: async () => ({
      exitCode: 1,
      timedOut: false,
      stderr: `NPM_TOKEN=${secret}\n${'x'.repeat(8_000)}`,
      stdout: '',
    }),
  }));
  assert.equal(checkResult.status, 'failed');
  assert.doesNotMatch(JSON.stringify(checkResult), new RegExp(secret));
  assert.match(checkResult.checks[0]?.stderr ?? '', /<REDACTED>/);
  assert.match(checkResult.checks[0]?.stderr ?? '', /\.\.\.\[truncated\]/);

  let repairPrompt = '';
  let reviewCount = 0;
  await runFactory(factoryOptions({
    fix: async prompt => {
      repairPrompt = prompt;
    },
    maxRounds: 2,
    review: async () => {
      reviewCount += 1;
      return reviewCount === 1
        ? {
            findings: [{
              evidence: `Authorization: Bearer ${secret}`,
              file: 'src/example.ts',
              line: 1,
              recommendation: `Set TOKEN=${secret}`,
              severity: 'high',
              title: 'Credential finding',
            }],
          }
        : { findings: [] };
    },
  }));
  assert.doesNotMatch(repairPrompt, new RegExp(secret));
  assert.match(repairPrompt, /\\u003cREDACTED\\u003e/);
});
