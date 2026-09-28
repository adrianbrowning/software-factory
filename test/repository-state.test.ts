import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { captureRepositoryState, type MainSandbox } from '../drop-in/main.mts';

const execFileAsync = promisify(execFile);

async function runCommand(cwd: string, command: string) {
  try {
    const result = await execFileAsync('sh', ['-lc', command], {
      cwd,
      maxBuffer: 2_000_000,
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (value) {
    const error = value as { code?: unknown; stderr?: unknown; stdout?: unknown };
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
    };
  }
}

async function git(cwd: string, ...arguments_: string[]) {
  await execFileAsync('git', arguments_, { cwd });
}

function localSandbox(cwd: string): MainSandbox<never> {
  return {
    close: async () => {},
    exec: command => runCommand(cwd, command),
    run: async () => ({ stdout: '' }),
  };
}

test('repository snapshots detect representative Git and filesystem mutations and enforce bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-state-'));

  try {
    await git(directory, 'init', '--quiet');
    await git(directory, 'config', 'user.email', 'factory@example.test');
    await git(directory, 'config', 'user.name', 'Factory Test');
    await writeFile(join(directory, 'tracked.txt'), 'original');
    await git(directory, 'add', 'tracked.txt');
    await git(directory, 'commit', '--quiet', '-m', 'initial');

    const sandbox = localSandbox(directory);
    const baseline = await captureRepositoryState(sandbox);

    await writeFile(join(directory, 'tracked.txt'), 'changed');
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'tracked content');
    await git(directory, 'reset', '--hard', '--quiet', 'HEAD');

    await writeFile(join(directory, 'untracked.txt'), 'new');
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'untracked content');
    await unlink(join(directory, 'untracked.txt'));

    await unlink(join(directory, 'tracked.txt'));
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'deleted file');
    await git(directory, 'reset', '--hard', '--quiet', 'HEAD');

    await chmod(join(directory, 'tracked.txt'), 0o755);
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'mode change');
    await git(directory, 'reset', '--hard', '--quiet', 'HEAD');

    await symlink('tracked.txt', join(directory, 'link.txt'));
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'untracked symlink');
    await unlink(join(directory, 'link.txt'));

    const hook = join(directory, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, ['#!/bin/sh', 'exit 0', ''].join(String.fromCharCode(10)));
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'Git hook');
    await unlink(hook);

    await git(directory, 'config', 'factory.snapshot', 'changed');
    assert.notEqual(await captureRepositoryState(sandbox), baseline, 'Git metadata');
    await git(directory, 'config', '--unset', 'factory.snapshot');

    await writeFile(join(directory, 'oversized.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(
      captureRepositoryState(sandbox),
      /Unable to capture bounded repository state/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
