import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.js';

test('reports human-readable progress throughout a successful run', async () => {
  const status: string[] = [];
  const result = await runFactory({
    baseRef: 'main',
    checks: ['pnpm test'],
    execute: async () => ({ exitCode: 0, stderr: '', stdout: 'passed' }),
    fix: async () => {},
    implement: async () => {},
    issue: {
      body: 'Requested behavior',
      number: 42,
      title: 'Add behavior',
      url: 'https://github.com/acme/example/issues/42',
    },
    maxRounds: 1,
    onStatus: message => status.push(message),
    review: async () => ({ findings: [] }),
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(status, [
    '[implement] Starting issue #42',
    '[implement] Complete',
    '[round 1/1] Starting',
    '[check] pnpm test',
    '[check] pnpm test ✓',
    '[review] Starting',
    '[review] Clean',
    '[complete] Passed in round 1',
  ]);
});
