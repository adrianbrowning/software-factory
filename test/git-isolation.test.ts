// This file imports no git-env module: the test script's preload alone isolates it from the developer's git config.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { git } from '../src/exec.ts';
import { workspace } from './helpers.ts';

describe('test isolation', () => {
  it("runs the factory's git calls without the developer's global git config", async () => {
    using ws = workspace();
    assert.equal(await git(ws.root, 'config', '--global', '--list'), '');
  });
});
