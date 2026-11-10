import assert from 'node:assert/strict';
import fs, { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { lockPath, readRun, runDir, type Workspace, withRun } from '../src/run.ts';
import { evictLock, removeLock } from '../src/state-lock.ts';
import { start, workspace } from './helpers.ts';

const COUNT = 25;

function writer(ws: Workspace, id: string, count = COUNT, onAttempt?: () => void) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const worker = new Worker(new URL('./lock-worker.ts', import.meta.url), { workerData: { count, id, ws } });
  worker.on('message', message => message === 'attempting' && onAttempt?.());
  worker.once('error', reject);
  worker.once('exit', code => (code === 0 ? resolve() : reject(new Error(`worker ${id} exited with ${code}`))));
  return promise;
}

describe('withRun lock', () => {
  it('keeps every update from writers in separate worker threads', async () => {
    using ws = workspace();
    await start(ws);
    await Promise.all([writer(ws, 'a'), writer(ws, 'b')]);
    const expected = ['a', 'b'].flatMap(id => Array.from({ length: COUNT }, (_, index) => `${id}-${index}`));
    assert.deepEqual(readRun(ws, 'demo').waiting.toSorted(), expected.toSorted());
  });

  it('recovers a lock left by a dead holder past the stale timeout', async () => {
    using ws = workspace();
    await start(ws);
    writeFileSync(lockPath(ws, 'demo'), '');
    utimesSync(lockPath(ws, 'demo'), 0, 0);
    await withRun(ws, 'demo', run => {
      run.waiting.push('after the stale lock');
    });
    assert.deepEqual(readRun(ws, 'demo').waiting, ['after the stale lock']);
    assert.equal(existsSync(lockPath(ws, 'demo')), false);
  });

  it('keeps every update when writers in separate threads both find a stale lock', async () => {
    using ws = workspace();
    await start(ws);
    writeFileSync(lockPath(ws, 'demo'), '');
    utimesSync(lockPath(ws, 'demo'), 0, 0);
    await Promise.all([writer(ws, 'a'), writer(ws, 'b')]);
    assert.equal(readRun(ws, 'demo').waiting.length, 2 * COUNT);
  });

  it('does not remove a lock that replaced the one judged stale, and leaves no moved file behind', async () => {
    using ws = workspace();
    await start(ws);
    const before = readdirSync(runDir(ws, 'demo')).toSorted();
    // The breaker read token 'dead holder' from a stale lock; a new holder has since taken the path.
    writeFileSync(lockPath(ws, 'demo'), 'new holder');
    removeLock(lockPath(ws, 'demo'), 'dead holder');
    assert.equal(readFileSync(lockPath(ws, 'demo'), 'utf8'), 'new holder');
    assert.deepEqual(readdirSync(runDir(ws, 'demo')).toSorted(), [...before, 'state.json.lock'].toSorted());
    removeLock(lockPath(ws, 'demo'), 'new holder');
    assert.deepEqual(readdirSync(runDir(ws, 'demo')).toSorted(), before);
  });

  it('never vacates the path of a holder that took it after the first eviction, so no competitor can slip in', async () => {
    using ws = workspace();
    await start(ws);
    const path = lockPath(ws, 'demo');
    const before = readdirSync(runDir(ws, 'demo')).toSorted();
    writeFileSync(path, 'dead holder');
    utimesSync(path, 0, 0);
    // Waiters A and B both read 'dead holder' as stale. A evicts, then a new holder takes the path.
    evictLock(path, 'dead holder');
    assert.equal(existsSync(path), false);
    writeFileSync(path, 'new holder', { flag: 'wx' });
    utimesSync(path, 0, 0);
    // A third acquirer creates the lock the moment anything is renamed off the path.
    let competitorGotLock = false;
    const original = fs.renameSync;
    mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      original(...args);
      try {
        writeFileSync(path, 'competitor', { flag: 'wx' });
        competitorGotLock = true;
      } catch {
        // The path is still taken.
      }
    });
    syncBuiltinESMExports();
    try {
      evictLock(path, 'dead holder');
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(competitorGotLock, false);
    assert.equal(readFileSync(path, 'utf8'), 'new holder');
    removeLock(path, 'new holder');
    assert.deepEqual(readdirSync(runDir(ws, 'demo')).toSorted(), before);
  });

  it('keeps a lock whose holder is alive past the stale timeout, because the heartbeat refreshes it', async () => {
    using ws = workspace();
    await start(ws);
    const path = lockPath(ws, 'demo');
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    try {
      const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
      const { promise: finish, resolve: finishFirst } = Promise.withResolvers<void>();
      const first = withRun(ws, 'demo', async run => {
        markStarted();
        await finish;
        run.waiting.push('first');
      });
      await started;
      mock.timers.tick(31_000);
      evictLock(path, readFileSync(path, 'utf8'));
      assert.equal(existsSync(path), true);
      // A worker thread has its own withRun queue, so it is a real competing acquirer.
      const { promise: attempting, resolve: markAttempting } = Promise.withResolvers<void>();
      let competitorDone = false;
      const competitor = writer(ws, 'w', 1, markAttempting).then(() => {
        competitorDone = true;
      });
      await attempting;
      await sleep(100);
      assert.equal(competitorDone, false);
      finishFirst();
      await first;
      await competitor;
      assert.deepEqual(readRun(ws, 'demo').waiting, ['first', 'w-0']);
    } finally {
      mock.timers.reset();
    }
  });

  it('does not evict a lock with the stale token whose heartbeat refreshed it after the waiter judged it stale', async () => {
    using ws = workspace();
    await start(ws);
    const path = lockPath(ws, 'demo');
    writeFileSync(path, 'holder');
    evictLock(path, 'holder');
    assert.equal(readFileSync(path, 'utf8'), 'holder');
    assert.equal(existsSync(`${path}.evict`), false);
  });

  it('readRun accepts valid state when two saves land between its state read and its saved-hash read', async () => {
    using ws = workspace();
    await start(ws);
    await withRun(ws, 'demo', run => {
      run.waiting.push('one');
    });
    const original = fs.readFileSync;
    let staleServed = false;
    mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (!staleServed && String(args[0]).endsWith('state.json.saved')) {
        staleServed = true;
        return 'newer-hash-1\nnewer-hash-2\n';
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(readRun(ws, 'demo').waiting, ['one']);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(staleServed, true);
  });

  it('names the eviction guard to delete when a dead evictor left it past the stale timeout', async () => {
    using ws = workspace();
    await start(ws);
    const guard = `${lockPath(ws, 'demo')}.evict`;
    writeFileSync(lockPath(ws, 'demo'), 'dead holder');
    utimesSync(lockPath(ws, 'demo'), 0, 0);
    writeFileSync(guard, '');
    utimesSync(guard, 0, 0);
    await assert.rejects(
      withRun(ws, 'demo', () => {}),
      error => error instanceof Error && error.message.includes(`${guard} `) && /delete/i.test(error.message),
    );
    assert.equal(existsSync(guard), true);
    assert.throws(() => evictLock(lockPath(ws, 'demo'), 'dead holder'), error => error instanceof Error && error.message.includes(`${guard} `));
  });

  it('waits for a live holder and leaves its lock alone', async () => {
    using ws = workspace();
    await start(ws);
    writeFileSync(lockPath(ws, 'demo'), 'another holder');
    let ran = false;
    const pending = withRun(ws, 'demo', () => {
      ran = true;
    });
    await sleep(100);
    assert.equal(ran, false);
    assert.equal(readFileSync(lockPath(ws, 'demo'), 'utf8'), 'another holder');
    rmSync(lockPath(ws, 'demo'));
    await pending;
    assert.equal(ran, true);
  });

  it('releases the lock when a mutation throws, so the next withRun proceeds', async () => {
    using ws = workspace();
    await start(ws);
    await assert.rejects(
      withRun(ws, 'demo', () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(existsSync(lockPath(ws, 'demo')), false);
    await withRun(ws, 'demo', run => {
      run.waiting.push('next');
    });
    assert.deepEqual(readRun(ws, 'demo').waiting, ['next']);
  });
});
