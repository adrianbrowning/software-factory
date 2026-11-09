import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checksPrompt, detectChecks, loadConfig, parseChecks, runCommands, suggestChecks } from '../src/config.ts';
import { evidence, evidenceLine } from '../src/evidence.ts';
import { runShell } from '../src/exec.ts';
import { tempDir, workspace } from './helpers.ts';

/** Writes `files` (path → content) under `root` and returns `root`. */
function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A temp dir holding `files`, removed when the `using` scope that holds it ends. */
function dir(files: Record<string, string> = {}) {
  const temp = tempDir('factory-unit-');
  writeFiles(temp.root, files);
  return temp;
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

describe('test temp dirs', () => {
  it('removes a temp dir and a workspace repo when the using scope that holds them ends', () => {
    let roots: string[];
    {
      using dir = tempDir('factory-unit-');
      using ws = workspace();
      roots = [dir.root, ws.root];
      assert.ok(roots.every(root => existsSync(root)));
    }
    assert.deepEqual(roots.filter(root => existsSync(root)), []);
  });
});

describe('runShell', () => {
  // A real child process: the process-group kill is the behavior under test, so the timeout uses the real clock.
  it('kills the whole process group on timeout', async () => {
    using temp = dir();
    const { root } = temp;
    const result = await runShell(`sleep 30 & echo $! > ${join(root, 'pid')}; wait`, root, 200);
    assert.equal(result.timedOut, true);
    assert.equal(alive(Number(readFileSync(join(root, 'pid'), 'utf8'))), false);
  });

  it('stops a running command when the signal aborts', async () => {
    const controller = new AbortController();
    using temp = dir();
    const pending = runShell('sleep 30', temp.root, 60_000, controller.signal);
    controller.abort();
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.durationMs < 10_000);
  });

  it('keeps the tail of output past the capture limit', async () => {
    using temp = dir();
    const result = await runShell(`head -c 1500000 /dev/zero | tr '\\0' a; echo END`, temp.root, 10_000);
    assert.ok(result.stdout.endsWith('END\n'));
    assert.ok(Buffer.byteLength(result.stdout) <= 1_000_000);
  });

  it('reports a missing working directory as exit 127', async () => {
    using temp = dir();
    const result = await runShell('true', join(temp.root, 'missing'), 1_000);
    assert.equal(result.exitCode, 127);
  });
});

describe('loadConfig', () => {
  it('detects lint, typecheck and test in that order with the declared package manager', () => {
    using temp = dir({ 'package.json': scripts(['test', 'build', 'lint', 'typecheck'], { packageManager: 'pnpm@10.0.0' }) });
    assert.deepEqual(detectChecks(temp.root), ['pnpm run lint', 'pnpm run typecheck', 'pnpm run test']);
  });

  it('falls back to the lockfile, then npm', () => {
    using yarn = dir({ 'package.json': scripts(['test']), 'yarn.lock': '' });
    using bun = dir({ 'bun.lock': '', 'package.json': scripts(['test']) });
    using npm = dir({ 'package.json': scripts(['test']) });
    assert.deepEqual(detectChecks(yarn.root), ['yarn run test']);
    assert.deepEqual(detectChecks(bun.root), ['bun run test']);
    assert.deepEqual(detectChecks(npm.root), ['npm run test']);
  });

  it('rejects invalid and unknown keys, naming the file', () => {
    using temp = dir({ 'package.json': scripts(['test']) });
    const config = (value: unknown) => writeFiles(temp.root, { '.omp/factory.json': JSON.stringify(value) });
    assert.throws(() => loadConfig(config({ maxRounds: 0 })), /factory\.json[\s\S]*maxRounds/);
    assert.throws(() => loadConfig(config({ checks: [] })), /factory\.json[\s\S]*checks/);
    assert.throws(() => loadConfig(config({ maxRound: 3 })), /factory\.json[\s\S]*maxRound/);
    assert.throws(() => loadConfig(config(null)), /factory\.json/);
    assert.throws(() => loadConfig(writeFiles(temp.root, { '.omp/factory.json': '{ nope' })), /factory\.json: invalid JSON/);
    assert.throws(() => loadConfig(config({ scratchDir: '../outside' })), /scratchDir/);
  });

  it('expands ~/ in checkPath and rejects relative entries', () => {
    using temp = dir({ 'package.json': scripts(['test']) });
    const config = (value: unknown) => writeFiles(temp.root, { '.omp/factory.json': JSON.stringify(value) });
    assert.deepEqual(loadConfig(config({ checkPath: ['~/Library/pnpm/bin', '/opt/bin'] })).checkPath, [join(homedir(), 'Library/pnpm/bin'), '/opt/bin']);
    assert.throws(() => loadConfig(config({ checkPath: ['node_modules/.bin'] })), /factory\.json: "checkPath" entry "node_modules\/\.bin"/);
  });

  it('normalizes scratchDir', () => {
    using temp = dir({ '.omp/factory.json': JSON.stringify({ scratchDir: './runs/' }), 'package.json': scripts(['test']) });
    assert.equal(loadConfig(temp.root).scratchDir, 'runs');
  });

  it('reads a models block and rejects a bad effort, an empty model or an unknown key, naming the role', () => {
    const load = (value: unknown) => {
      using temp = dir({ '.omp/factory.json': JSON.stringify(value), 'package.json': scripts(['test']) });
      return loadConfig(temp.root);
    };
    const models = { implementer: { fallbacks: ['openai/gpt-5.2'], model: 'anthropic/claude-sonnet-4-5' }, orchestrator: { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'xhigh' } };
    assert.deepEqual(load({ models }).models, models);
    assert.deepEqual(load({}).models, {});
    assert.throws(() => load({ models: { orchestrator: { model: 'x', reasoningEffort: 'huge' } } }), /factory\.json[\s\S]*models\.orchestrator\.reasoningEffort/);
    assert.throws(() => load({ models: { reviewer: { model: '' } } }), /factory\.json[\s\S]*models\.reviewer\.model/);
    assert.throws(() => load({ models: { implementer: { model: 'x', effort: 'high' } } }), /factory\.json[\s\S]*"effort"[\s\S]*models\.implementer/);
    assert.throws(() => load({ models: { coder: { model: 'x' } } }), /factory\.json[\s\S]*coder/);
  });

  it('rejects reasoningEffort on a subagent role, naming the role and that omp cannot set subagent effort', () => {
    const load = (value: unknown) => {
      using temp = dir({ '.omp/factory.json': JSON.stringify(value), 'package.json': scripts(['test']) });
      return loadConfig(temp.root);
    };
    for (const role of ['implementer', 'reviewer', 'validator', 'explorer']) {
      assert.throws(
        () => load({ models: { [role]: { model: 'x', reasoningEffort: 'high' } } }),
        new RegExp(`factory\\.json[\\s\\S]*omp cannot set a subagent's reasoning effort from the factory[\\s\\S]*models\\.${role}\\.reasoningEffort`),
      );
    }
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
    using temp = dir({
      '.github/workflows/build.yml': workflow,
      'package.json': scripts(['lint', 'test', 'test:watch', 'lint:fix', 'check:build', 'dev'], { packageManager: 'pnpm@10.0.0' }),
    });
    assert.deepEqual(suggestChecks(temp.root, {}), {
      chosen: ['pnpm run lint', 'pnpm run test'],
      scripts: ['pnpm run check:build'],
      workflows: ['pnpm exec playwright test --project=chromium', 'node scripts/verify.js --strict'],
    });
  });

  it('chooses the configured checks, and works with no package.json', () => {
    using temp = dir();
    assert.deepEqual(suggestChecks(temp.root, { checks: ['make test'] }), { chosen: ['make test'], scripts: [], workflows: [] });
    assert.deepEqual(suggestChecks(temp.root, {}), { chosen: [], scripts: [], workflows: [] });
  });

  it('runs the chosen lines and ignores the commented suggestions until uncommented', () => {
    const prompt = checksPrompt({ chosen: ['pnpm run lint'], scripts: ['pnpm run check:build'], workflows: ['make e2e'] });
    assert.deepEqual(parseChecks(prompt), ['pnpm run lint']);
    assert.deepEqual(parseChecks(prompt.replace('# pnpm run check:build', 'pnpm run check:build')), ['pnpm run lint', 'pnpm run check:build']);
  });

  it('tells the user to type the checks only when nothing is suggested', () => {
    assert.match(checksPrompt({ chosen: [], scripts: [], workflows: [] }), /No check commands were found/);
    assert.doesNotMatch(checksPrompt({ chosen: [], scripts: [], workflows: ['make e2e'] }), /No check commands were found/);
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

  it('keeps the first characters of a long line, marking the cut', () => {
    assert.equal(evidenceLine('a b c d e f', 5), 'a b c…');
  });

  it('redacts a multi-line value before joining it onto one line', () => {
    assert.equal(evidenceLine(`Failed:\n  ${secrets.privateKey}\n  done`), 'Failed: <REDACTED> done');
  });
});
