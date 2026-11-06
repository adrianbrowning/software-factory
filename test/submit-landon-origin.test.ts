import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { submitStack } from '../src/submit.ts';
import { resolveBase } from '../src/workflow.ts';
import { commit, sh, step, tempDir, workspace } from './helpers.ts';
import { doneRun, fakeGh, withPrs } from './submit-fixtures.ts';

describe('landOn origin check', () => {
  it('refuses a landOn run whose branch is not on origin, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using remote = tempDir('factory-origin-');
    sh(remote.root, 'init', '-q', '--bare');
    sh(ws.root, 'remote', 'add', 'origin', remote.root);
    sh(ws.root, 'push', '-q', 'origin', 'main');
    const before = sh(ws.root, 'for-each-ref', '--format=%(refname) %(objectname)');
    const checkedOut = sh(ws.root, 'branch', '--show-current');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is not on origin.*[Pp]ush it/s);
    assert.deepEqual(gh.calls(), []);
    assert.equal(sh(ws.root, 'for-each-ref', '--format=%(refname) %(objectname)'), before, 'no ref moved');
    assert.equal(sh(ws.root, 'branch', '--show-current'), checkedOut);
  });

  it('refuses a landOn run whose branch on origin is behind the local one, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    using remote = tempDir('factory-origin-');
    sh(remote.root, 'init', '-q', '--bare');
    sh(ws.root, 'remote', 'add', 'origin', remote.root);
    sh(ws.root, 'push', '-q', 'origin', 'ext-953');
    // A local commit on ext-953 that origin lacks; the slices build on it.
    sh(ws.root, 'switch', '-q', 'ext-953');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 on origin \([0-9a-f]{12}\) is not the local ext-953.*Push your local commits \(git push origin ext-953\)/s);
    assert.deepEqual(gh.calls(), []);
  });

  it('refuses a landOn run whose branch on origin is ahead of the local one, telling the user to update the local branch, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    using remote = tempDir('factory-origin-');
    sh(remote.root, 'init', '-q', '--bare');
    sh(ws.root, 'remote', 'add', 'origin', remote.root);
    // A teammate's commit on origin's ext-953 that the local branch lacks.
    sh(ws.root, 'switch', '-q', 'ext-953');
    commit(ws, 'teammate.txt');
    sh(ws.root, 'push', '-q', 'origin', 'ext-953');
    sh(ws.root, 'reset', '-q', '--hard', 'HEAD~1');
    sh(ws.root, 'switch', '-q', 'main');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 on origin \([0-9a-f]{12}\) is not the local ext-953.*if origin is ahead, update the local ext-953 first \(switch to ext-953 and run git pull --ff-only origin ext-953\)/s);
    assert.deepEqual(gh.calls(), []);
  });

  it('refuses a landOn run whose branch has diverged from origin, telling the user to merge (not rebase) then push, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    using remote = tempDir('factory-origin-');
    sh(remote.root, 'init', '-q', '--bare');
    sh(ws.root, 'remote', 'add', 'origin', remote.root);
    // A teammate's commit on origin's ext-953, and a different local commit the origin lacks.
    sh(ws.root, 'switch', '-q', 'ext-953');
    commit(ws, 'teammate.txt');
    sh(ws.root, 'push', '-q', 'origin', 'ext-953');
    sh(ws.root, 'reset', '-q', '--hard', 'HEAD~1');
    commit(ws, 'local.txt');
    sh(ws.root, 'switch', '-q', 'main');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /if both have new commits, merge origin's ext-953 into the local ext-953 \(do not rebase: the slices build on its current commits\) and push it.*Nothing was submitted\./s);
    assert.deepEqual(gh.calls(), []);
  });

  it('refuses a landOn run with no origin remote with the push-first message, before any gh call', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), (error: Error) => {
      assert.match(error.message, /could not read origin to check for ext-953.*git push origin ext-953/s);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.deepEqual(gh.calls(), []);
  });

  it('refuses at plan time a landOn that is a revision expression or not a local branch', async () => {
    using ws = workspace();
    sh(ws.root, 'update-ref', 'refs/remotes/origin/main', 'main');
    for (const name of ['main^{commit}', 'main~0', 'origin/main', 'refs/heads/main', '../main', '-main', 'missing']) {
      await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: name }), /is not an existing local branch/, name);
    }
    assert.equal((await resolveBase(ws, { baseRef: 'main', landOn: 'main' })).landOn, 'main');
  });
});
