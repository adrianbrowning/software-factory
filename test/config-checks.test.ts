import './git-env-guard.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';

describe('parseConfig checks', () => {
  it('trims, drops blanks and dedupes in first-seen order', () => {
    assert.deepEqual(parseConfig({ checks: [' pnpm test ', 'pnpm test', '', '  ', 'pnpm lint'] }).checks, ['pnpm test', 'pnpm lint']);
  });
  it('rejects a list empty after normalization, naming checks', () => {
    assert.throws(() => parseConfig({ checks: ['   '] }), /checks/);
    assert.throws(() => parseConfig({ checks: [] }), /checks/);
  });
});
