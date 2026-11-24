// This file imports no git-env module: the test script's preload alone isolates it from the developer's git config.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { git } from '../src/exec.ts';
import { workspace } from './helpers.ts';

describe('test isolation', () => {
  it("runs the factory's git calls with no config but the repo's own", async () => {
    using ws = workspace();
    const lines = (await git(ws.root, 'config', '--list', '--show-origin')).split('\n').filter(Boolean);
    const foreign = lines.filter(
      (line) => !line.startsWith('file:.git/config\t') && line !== 'command line:\tmaintenance.auto=false',
    );
    assert.deepEqual(foreign, []);
  });
});
