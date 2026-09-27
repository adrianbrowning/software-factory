import assert from 'node:assert/strict';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { runFactory } from '../drop-in/factory.js';
import { commandWithTimeout, isTimeoutExitCode } from '../drop-in/main.mjs';
import { factoryOptions } from './fixtures.js';

const exec = promisify(execCallback);

test('actively terminates a deterministic check after its timeout', async () => {
  const status: string[] = [];
  const result = await runFactory(factoryOptions({
    checks: ['sleep 2'],
    checkTimeoutMs: 100,
    execute: async (command, { timeoutMs }) => {
      try {
        const output = await exec(commandWithTimeout(command, timeoutMs));
        return { exitCode: 0, timedOut: false, stderr: output.stderr, stdout: output.stdout };
      } catch (error) {
        const failure = <{ code?: number; stderr?: string; stdout?: string }>error;
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
          stderr: failure.stderr ?? '',
          stdout: failure.stdout ?? '',
          timedOut: typeof failure.code === 'number' && isTimeoutExitCode(failure.code),
        };
      }
    },
    onStatus: message => status.push(message),
    review: async () => {
      throw new Error('review must not run after a timed-out check');
    },
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.timedOut, true);
  assert.ok(status.includes('[check] sleep 2 timed out after 100ms'));
});

test('preserves a forced timeout kill classification from the executor', async () => {
  const result = await runFactory(factoryOptions({
    checks: ['ignores-term'],
    checkTimeoutMs: 100,
    execute: async () => ({
      exitCode: 137,
      stderr: '',
      stdout: '',
      timedOut: isTimeoutExitCode(137),
    }),
    review: async () => {
      throw new Error('review must not run');
    },
  }));

  assert.equal(result.checks[0]?.timedOut, true);
});
