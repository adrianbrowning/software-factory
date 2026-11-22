import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireFeatureName } from '../src/feature-name.ts';

const MESSAGE = /feature must be kebab-case, at most 48 characters/;

describe('requireFeatureName', () => {
  it('accepts valid names', () => {
    assert.equal(requireFeatureName('issue-475'), 'issue-475');
    const max = 'a'.repeat(48);
    assert.equal(requireFeatureName(max), max);
  });
  it('rejects invalid names', () => {
    for (const bad of ['Upper', '-lead', 'a'.repeat(49)]) assert.throws(() => requireFeatureName(bad), MESSAGE);
  });
});
