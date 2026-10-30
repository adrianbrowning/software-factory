import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checksPrompt, detectChecks, loadConfig, parseChecks, runCommands, suggestChecks } from '../src/config.ts';
import { evidence } from '../src/evidence.ts';
import { runShell } from '../src/exec.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
});

function dir(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-unit-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const scripts = (names: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scripts: Object.fromEntries(names.map(name => [name, 'x'])), ...extra });

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runShell', () => {
  // A real child process: the process-group kill is the behavior under test, so the timeout uses the real clock.
  it('kills the whole process group on timeout', async () => {
    const root = dir();
    const result = await runShell(`sleep 30 & echo $! > ${join(root, 'pid')}; wait`, root, 200);
    assert.equal(result.timedOut, true);
    assert.equal(alive(Number(readFileSync(join(root, 'pid'), 'utf8'))), false);
  });

  it('stops a running command when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = runShell('sleep 30', dir(), 60_000, controller.signal);
    controller.abort();
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.durationMs < 10_000);
  });

  it('keeps the tail of output past the capture limit', async () => {
    const result = await runShell(`head -c 1500000 /dev/zero | tr '\\0' a; echo END`, dir(), 10_000);
    assert.ok(result.stdout.endsWith('END\n'));
    assert.ok(Buffer.byteLength(result.stdout) <= 1_000_000);
  });

  it('reports a missing working directory as exit 127', async () => {
    const result = await runShell('true', join(dir(), 'missing'), 1_000);
    assert.equal(result.exitCode, 127);
  });
});

describe('loadConfig', () => {
  it('detects lint, typecheck and test in that order with the declared package manager', () => {
    const root = dir({ 'package.json': scripts(['test', 'build', 'lint', 'typecheck'], { packageManager: 'pnpm@10.0.0' }) });
    assert.deepEqual(detectChecks(root), ['pnpm run lint', 'pnpm run typecheck', 'pnpm run test']);
  });

  it('falls back to the lockfile, then npm', () => {
    assert.deepEqual(detectChecks(dir({ 'package.json': scripts(['test']), 'yarn.lock': '' })), ['yarn run test']);
    assert.deepEqual(detectChecks(dir({ 'bun.lock': '', 'package.json': scripts(['test']) })), ['bun run test']);
    assert.deepEqual(detectChecks(dir({ 'package.json': scripts(['test']) })), ['npm run test']);
  });

  it('rejects invalid and unknown keys, naming the file', () => {
    const config = (value: unknown) => dir({ '.omp/factory.json': JSON.stringify(value), 'package.json': scripts(['test']) });
    assert.throws(() => loadConfig(config({ maxRounds: 0 })), /factory\.json[\s\S]*maxRounds/);
    assert.throws(() => loadConfig(config({ checks: [] })), /factory\.json[\s\S]*checks/);
    assert.throws(() => loadConfig(config({ maxRound: 3 })), /factory\.json[\s\S]*maxRound/);
    assert.throws(() => loadConfig(config(null)), /factory\.json/);
    assert.throws(() => loadConfig(dir({ '.omp/factory.json': '{ nope', 'package.json': scripts(['test']) })), /factory\.json: invalid JSON/);
    assert.throws(() => loadConfig(config({ scratchDir: '../outside' })), /scratchDir/);
  });

  it('expands ~/ in checkPath and rejects relative entries', () => {
    const config = (value: unknown) => dir({ '.omp/factory.json': JSON.stringify(value), 'package.json': scripts(['test']) });
    assert.deepEqual(loadConfig(config({ checkPath: ['~/Library/pnpm/bin', '/opt/bin'] })).checkPath, [join(homedir(), 'Library/pnpm/bin'), '/opt/bin']);
    assert.throws(() => loadConfig(config({ checkPath: ['node_modules/.bin'] })), /factory\.json: "checkPath" entry "node_modules\/\.bin"/);
  });

  it('normalizes scratchDir', () => {
    const root = dir({ '.omp/factory.json': JSON.stringify({ scratchDir: './runs/' }), 'package.json': scripts(['test']) });
    assert.equal(loadConfig(root).scratchDir, 'runs');
  });
});

describe('check setup suggestions', () => {
  const workflow = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: pnpm install --frozen-lockfile',
    '      - name: Build',
    '        run: |',
    '          pnpm check:build',
    '          # a comment',
    '          pnpm exec playwright test \\',
    '            --project=chromium',
    '      - run: >-',
    '          node scripts/verify.js',
    '          --strict',
    '      - run: "pnpm run lint"',
    '    env:',
    '      CI: true',
  ].join('\n');

  it('reads inline, literal block, and folded block run steps', () => {
    assert.deepEqual(runCommands(workflow), [
      'pnpm install --frozen-lockfile',
      'pnpm check:build',
      'pnpm exec playwright test --project=chromium',
      'node scripts/verify.js --strict',
      'pnpm run lint',
    ]);
  });

  it('offers nothing from a run block whose lines depend on each other', () => {
    const steps = ['steps:', '  - run: |', '      cd app', '      pnpm test', '  - run: |', '      if [ -n "$CI" ]; then', '        pnpm e2e', '      fi', '  - run: |', '      export NODE_ENV=test', '      pnpm verify'];
    assert.deepEqual(runCommands(steps.join('\n')), []);
  });

  it('chooses lint/typecheck/test and offers other check scripts and CI commands not already covered', () => {
    const root = dir({
      '.github/workflows/build.yml': workflow,
      'package.json': scripts(['lint', 'test', 'test:watch', 'lint:fix', 'check:build', 'dev'], { packageManager: 'pnpm@10.0.0' }),
    });
    assert.deepEqual(suggestChecks(root, {}), {
      chosen: ['pnpm run lint', 'pnpm run test'],
      scripts: ['pnpm run check:build'],
      workflows: ['pnpm exec playwright test --project=chromium', 'node scripts/verify.js --strict'],
    });
  });

  it('chooses the configured checks, and works with no package.json', () => {
    assert.deepEqual(suggestChecks(dir(), { checks: ['make test'] }), { chosen: ['make test'], scripts: [], workflows: [] });
    assert.deepEqual(suggestChecks(dir(), {}), { chosen: [], scripts: [], workflows: [] });
  });

  it('runs the chosen lines and ignores the commented suggestions until uncommented', () => {
    const prompt = checksPrompt({ chosen: ['pnpm run lint'], scripts: ['pnpm run check:build'], workflows: ['make e2e'] });
    assert.deepEqual(parseChecks(prompt), ['pnpm run lint']);
    assert.deepEqual(parseChecks(prompt.replace('# pnpm run check:build', 'pnpm run check:build')), ['pnpm run lint', 'pnpm run check:build']);
  });
});

describe('evidence', () => {
  const secrets = {
    aws: 'AKIAABCDEFGHIJKLMNOP',
    bearer: 'Authorization: Bearer abc.def',
    cookie: 'Cookie: session=abc',
    env: 'DATABASE_URL=postgres://u:p@h/db',
    github: `ghp_${'a'.repeat(36)}`,
    githubPat: `github_pat_${'b'.repeat(30)}`,
    npm: `npm_${'c'.repeat(36)}`,
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    slack: 'xoxb-1234567890-abc',
    url: 'https://user:hunter2@example.com/repo',
  };
  for (const [name, secret] of Object.entries(secrets)) {
    it(`redacts ${name}`, () => {
      const redacted = evidence(`the value is ${secret} here`);
      assert.match(redacted, /<REDACTED>/);
      assert.doesNotMatch(redacted, /aaaa|bbbb|cccc|ABCDEFGH|abc\.def|session=abc|hunter2|MIIE|1234567890|u:p@/);
    });
  }

  it('keeps the tail of long output', () => {
    assert.equal(evidence('xxxxxxxxxxEND', 5), '...[truncated]\nxxEND');
  });
});
