import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitArchWarning, type GitArchHost } from '../src/git-arch.ts';

const host = (over: Partial<GitArchHost> = {}): GitArchHost => ({
  arch: 'arm64',
  describe: () => 'Mach-O 64-bit executable x86_64',
  exists: p => p === '/opt/x/git' || p === '/usr/bin/git',
  path: '/nope:/opt/x:/usr/bin',
  realpath: p => p,
  platform: 'darwin',
  ...over,
});

test('x86_64-only git warns with its path and /usr/bin/git', () => {
  const w = gitArchWarning(host());
  assert.match(w ?? '', /\/opt\/x\/git/);
  assert.match(w ?? '', /Rosetta/);
  assert.match(w ?? '', /\/usr\/bin\/git/);
});

test('universal or arm64 git gives no warning', () => {
  assert.equal(gitArchWarning(host({ describe: () => 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]' })), undefined);
  assert.equal(gitArchWarning(host({ describe: () => 'Mach-O 64-bit executable arm64' })), undefined);
});

test('other hosts never call describe', () => {
  const describe = () => { throw new Error('called'); };
  assert.equal(gitArchWarning(host({ describe, platform: 'linux' })), undefined);
  assert.equal(gitArchWarning(host({ arch: 'x64', describe })), undefined);
});

test('no git or throwing describe gives no warning', () => {
  assert.equal(gitArchWarning(host({ exists: () => false })), undefined);
  assert.equal(gitArchWarning(host({ describe: () => { throw new Error('x'); } })), undefined);
});

test('a symlinked git is described by its target', () => {
  const w = gitArchWarning(host({
    describe: p => (p === '/cellar/git' ? 'Mach-O 64-bit executable x86_64' : `symbolic link to ${p}`),
    realpath: p => (p === '/opt/x/git' ? '/cellar/git' : p),
  }));
  assert.match(w ?? '', /\/opt\/x\/git/);
});
