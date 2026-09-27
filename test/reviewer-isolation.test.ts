import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.js';
import { factoryOptions } from './fixtures.js';

test('reviewer mutations cannot produce an unchecked passing result', async () => {
  let repositoryState = 'clean';
  let checkRuns = 0;

  await assert.rejects(
    runFactory(factoryOptions({
      captureRepositoryState: async () => repositoryState,
      execute: async () => {
        checkRuns += 1;
        return { exitCode: 0, timedOut: false, stderr: '', stdout: 'passed' };
      },
      review: async () => {
        repositoryState = 'reviewer changed src/example.ts';
        return { findings: [] };
      },
    })),
    /reviewer modified the repository/i,
  );

  assert.equal(checkRuns, 1);
});

test('reviewer mutations are detected even when review output fails', async () => {
  let repositoryState = 'clean';

  await assert.rejects(
    runFactory(factoryOptions({
      captureRepositoryState: async () => repositoryState,
      review: async () => {
        repositoryState = 'reviewer changed src/example.ts';
        throw new Error('malformed review');
      },
    })),
    /reviewer modified the repository/i,
  );
});

test('a clean review is rechecked before it can pass', async () => {
  let checks = 0;
  const result = await runFactory(factoryOptions({
    execute: async () => {
      checks += 1;
      return checks === 1
        ? { exitCode: 0, timedOut: false, stderr: '', stdout: 'passed' }
        : { exitCode: 1, timedOut: false, stderr: 'reviewer mutation broke checks', stdout: '' };
    },
  }));

  assert.equal(result.status, 'failed');
  assert.equal(checks, 2);
  assert.match(result.checks[0]?.stderr ?? '', /reviewer mutation broke checks/);
});


test('passing post-review checks cannot mutate the reviewed repository state', async () => {
  let checks = 0;
  let repositoryState = 'reviewed';

  await assert.rejects(
    runFactory(factoryOptions({
      captureRepositoryState: async () => repositoryState,
      execute: async () => {
        checks += 1;
        if (checks === 2) repositoryState = 'changed by verification check';
        return { exitCode: 0, timedOut: false, stderr: '', stdout: 'passed' };
      },
    })),
    /post-review checks modified the repository/i,
  );

  assert.equal(checks, 2);
});
