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

describe('parseConfig rerunFiles', () => {
  it('accepts templates and a tries count', () => {
    const config = parseConfig({ rerunFiles: { 'pnpm run test': 'pnpm exec vitest run {files}' }, rerunFilesTries: 2 });
    assert.deepEqual(config.rerunFiles, { 'pnpm run test': 'pnpm exec vitest run {files}' });
    assert.equal(config.rerunFilesTries, 2);
  });
  it('defaults to no templates and 3 tries', () => {
    const config = parseConfig({});
    assert.deepEqual(config.rerunFiles, {});
    assert.equal(config.rerunFilesTries, 3);
  });
  it('rejects a template without {files}, naming rerunFiles and the key', () => {
    assert.throws(() => parseConfig({ rerunFiles: { 'pnpm run test': 'pnpm exec vitest run' } }), /rerunFiles[\s\S]*pnpm run test/);
  });
  it('rejects zero tries', () => {
    assert.throws(() => parseConfig({ rerunFilesTries: 0 }), /rerunFilesTries/);
  });
});
