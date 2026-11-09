import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { lockPath, readRun, type Workspace, withRun } from '../src/run.ts';
import { start, workspace } from './helpers.ts';

const COUNT = 25;

function writer(ws: Workspace, id: string) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const worker = new Worker(new URL('./lock-worker.ts', import.meta.url), { workerData: { count: COUNT, id, ws } });
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
