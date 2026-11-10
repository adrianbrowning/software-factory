import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, futimesSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** Lease length: a lock file not touched by its holder's heartbeat for this long is treated as abandoned and may be evicted. A live holder blocked for longer than this loses the lock. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 5;

/** The lock file's age in milliseconds and token, read from one open file, or undefined when it does not exist. */
function inspectLock(path: string) {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return { age: Date.now() - fstatSync(fd).mtimeMs, token: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/**
 * The holder's release: removes the lock file only if it holds `token`. The file is renamed to a private name
 * first, so it is checked and deleted as one instance. If it holds another token (the holder's lock was evicted
 * and a new holder took the path), it is linked back, which never overwrites; if the path was taken again
 * meanwhile, the path is left alone.
 */
export function removeLock(path: string, token: string) {
  const moved = `${path}.${randomUUID()}`;
  try {
    renameSync(path, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (readFileSync(moved, 'utf8') !== token) linkSync(moved, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    rmSync(moved, { force: true });
  }
}

/**
 * Removes a lock a waiter judged stale after reading `staleToken`. Evictors take an exclusive guard file
 * (`<lock>.evict`) first, so one runs at a time; under the guard the lock's token and age are read again, and the
 * lock is renamed away and removed only if it still holds `staleToken` and is still stale. A waiter holding an
 * old judgement therefore cannot displace a holder that took the path after another eviction. Returns without
 * evicting when another evictor holds the guard. The guard has no automatic recovery: one left by a dead evictor
 * and older than LOCK_STALE_MS makes the waiter throw, naming the file to delete.
 */
export function evictLock(path: string, staleToken: string) {
  const guard = `${path}.evict`;
  try {
    writeFileSync(guard, '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const held = inspectLock(guard);
    if (held !== undefined && held.age > LOCK_STALE_MS) {
      throw new Error(
        `The eviction guard ${guard} has been held for more than ${LOCK_STALE_MS / 1000} s, so an omp session died while evicting a stale state lock. Delete ${guard} once no omp session is writing this run.`,
      );
    }
    return;
  }
  try {
    const lock = inspectLock(path);
    if (lock === undefined || lock.token !== staleToken || lock.age <= LOCK_STALE_MS) return;
    removeLock(path, staleToken);
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Takes the run's lock file: created exclusively with a token unique to this acquisition, so one holder at a time
 * across threads and processes. While held, a timer keeps touching the file; a file untouched for LOCK_STALE_MS is
 * taken to belong to a dead holder and removed with `evictLock`, which serializes evictors and never removes a lock
 * other than the one judged stale. The only accepted exclusion failure is a live holder blocked for longer than the
 * LOCK_STALE_MS lease.
 */
async function acquireLock(path: string) {
  const token = randomUUID();
  for (;;) {
    try {
      writeFileSync(path, token, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const lock = inspectLock(path);
    // Released since the failed create: try again at once.
    if (lock === undefined) continue;
    if (lock.age > LOCK_STALE_MS) evictLock(path, lock.token);
    await sleep(LOCK_POLL_MS);
  }
  // The failure of the most recent tick, if it failed: a later tick that touches the file clears it.
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    // Touch the file only while it still holds this acquisition's token; after an eviction it belongs to another holder.
    // No error may escape the timer, and a failed tick must not end the refresh while the holder still works, or the
    // lease would lapse and a waiter could evict a live holder: the next tick retries and the error is kept for `release`.
    try {
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        clearInterval(heartbeat);
        return;
      }
      try {
        if (readFileSync(fd, 'utf8') === token) {
          const now = new Date();
          futimesSync(fd, now, now);
          heartbeatError = undefined;
        } else {
          clearInterval(heartbeat);
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      heartbeatError = error;
    }
  }, LOCK_STALE_MS / 3);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    removeLock(path, token);
    return heartbeatError;
  };
}

/** Runs `fn` while holding the lock file at `path`, and releases it when `fn` returns or throws. A heartbeat failure that no later tick recovered from is thrown after the release, unless `fn` threw. */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireLock(path);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    release();
    throw error;
  }
  const heartbeatError = release();
  if (heartbeatError !== undefined) throw heartbeatError;
  return result;
}
