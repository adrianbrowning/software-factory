import './git-env-guard.ts';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gitArchWarning, type GitArchHost } from '../src/git-arch.ts';

const host = (over: Partial<GitArchHost> = {}): GitArchHost => ({
  arch: 'arm64',
  describe: () => 'Mach-O 64-bit executable x86_64',
  exists: p => p === '/opt/x/git' || p === '/usr/bin/git',
  path: '/nope:/opt/x:/usr/bin',
  realpath: p => p,
  isExecutable: p => p === '/opt/x/git',
  sysctlArm64: () => '0\n',
  platform: 'darwin',
  ...over,
});

test('x86_64-only git warns with its path and /usr/bin/git', () => {
  const w = gitArchWarning(host());
  assert.match(w ?? '', /\/opt\/x\/git/);
  assert.match(w ?? '', /Rosetta/);
  assert.match(w ?? '', /\/usr\/bin\/git/);
});

test('without /usr/bin/git the warning names the resolved git and not /usr/bin/git', () => {
  const w = gitArchWarning(host({ exists: () => false }));
  assert.match(w ?? '', /\/opt\/x\/git/);
  assert.doesNotMatch(w ?? '', /\/usr\/bin\/git/);
});

test('universal or arm64 git gives no warning', () => {
  assert.equal(gitArchWarning(host({ describe: () => 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]' })), undefined);
  assert.equal(gitArchWarning(host({ describe: () => 'Mach-O 64-bit executable arm64' })), undefined);
});

test('other hosts never call describe', () => {
  const calls: string[] = [];
  const describe = (p: string) => { calls.push(p); return 'Mach-O 64-bit executable x86_64'; };
  assert.equal(gitArchWarning(host({ describe, platform: 'linux' })), undefined);
  assert.equal(gitArchWarning(host({ arch: 'x64', describe })), undefined);
  assert.deepEqual(calls, []);
});

test('no git or throwing describe gives no warning', () => {
  assert.equal(gitArchWarning(host({ isExecutable: () => false })), undefined);
  assert.equal(gitArchWarning(host({ describe: () => { throw new Error('x'); } })), undefined);
});

test('a Rosetta-run Node on Apple Silicon hardware still warns', () => {
  assert.match(gitArchWarning(host({ arch: 'x64', sysctlArm64: () => '1\n' })) ?? '', /\/opt\/x\/git/);
});

test('sysctl failing or not printing 1 gives no warning', () => {
  assert.equal(gitArchWarning(host({ arch: 'x64', sysctlArm64: () => '0\n' })), undefined);
  assert.equal(gitArchWarning(host({ arch: 'x64', sysctlArm64: () => { throw new Error('x'); } })), undefined);
});

test('off darwin sysctl is never called', () => {
  let called = false;
  const sysctlArm64 = () => { called = true; return '1'; };
  assert.equal(gitArchWarning(host({ arch: 'x64', platform: 'linux', sysctlArm64 })), undefined);
  assert.equal(called, false);
});

test('a symlinked git is described by its target', () => {
  const w = gitArchWarning(host({
    describe: p => (p === '/cellar/git' ? 'Mach-O 64-bit executable x86_64' : `symbolic link to ${p}`),
    realpath: p => (p === '/opt/x/git' ? '/cellar/git' : p),
  }));
  assert.match(w ?? '', /\/opt\/x\/git/);
});

test('a non-executable git earlier on PATH is skipped', () => {
  const seen: string[] = [];
  const w = gitArchWarning(host({
    describe: p => { seen.push(p); return 'Mach-O 64-bit executable x86_64'; },
    path: '/early:/opt/x',
  }));
  assert.deepEqual(seen, ['/opt/x/git']);
  assert.match(w ?? '', /\/opt\/x\/git/);
});

test('an empty PATH component means the working directory', () => {
  const cwdGit = `${process.cwd()}/git`;
  const seen: string[] = [];
  gitArchWarning(host({
    describe: p => { seen.push(p); return 'x86_64'; },
    isExecutable: p => p === cwdGit || p === '/opt/x/git',
    path: ':/opt/x',
  }));
  assert.deepEqual(seen, [cwdGit]);
});

function runProbes(scripts: Record<string, string>, body: string, check: (dir: string, r: SpawnSyncReturns<string>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    for (const [name, content] of Object.entries(scripts)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${content}`);
      chmodSync(join(dir, name), 0o755);
    }
    const src = fileURLToPath(new URL('../src/git-arch.ts', import.meta.url));
    const script = `import { defaultGitArchHost } from ${JSON.stringify(src)};
const h = defaultGitArchHost();
${body}`;
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir },
    });
    assert.equal(r.status, 0, String(r.stderr));
    check(dir, r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a failing file or sysctl probe runs and writes nothing to the parent stderr', () => {
  const dir0 = (name: string) => `: > "\${0%/*}/${name}.ran"\necho "probe noise" >&2\nexit 1\n`;
  runProbes(
    { file: dir0('file'), sysctl: dir0('sysctl') },
    `for (const probe of [() => h.describe('/x'), () => h.sysctlArm64()]) { try { probe(); } catch {} }`,
    (dir, r) => {
      assert.ok(existsSync(join(dir, 'file.ran')), 'file probe did not run');
      assert.ok(existsSync(join(dir, 'sysctl.ran')), 'sysctl probe did not run');
      assert.doesNotMatch(String(r.stderr), /probe noise/);
    },
  );
});

test('a succeeding file or sysctl probe returns its stdout', () => {
  runProbes(
    { file: 'echo "Mach-O 64-bit executable x86_64"\n', sysctl: 'echo 1\n' },
    `console.log('D=' + h.describe('/x').trim()); console.log('S=' + h.sysctlArm64().trim());`,
    (_dir, r) => {
      assert.match(String(r.stdout), /D=Mach-O 64-bit executable x86_64/);
      assert.match(String(r.stdout), /S=1/);
    },
  );
});
