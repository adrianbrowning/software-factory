import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.ts';
import { factoryOptions } from './fixtures.ts';

test('reports human-readable progress throughout a successful run', async () => {
  const status: string[] = [];
  const result = await runFactory(factoryOptions({
    onStatus: message => status.push(message),
  }));

  assert.equal(result.status, 'passed');
  assert.deepEqual(status, [
    '[implement] Starting issue #42',
    '[implement] Complete',
    '[round 1/1] Starting',
    '[check] pnpm test',
    '[check] pnpm test ✓',
    '[review] Starting',
    '[verify] Rechecking after clean review',
    '[check] pnpm test',
    '[check] pnpm test ✓',
    '[review] Clean',
    '[complete] Passed in round 1',
  ]);
});
