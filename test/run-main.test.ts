import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runMain, type MainDependencies, type MainOptions } from '../drop-in/main.mts';

const options: MainOptions = {
  baseRef: 'origin/main',
  branchPrefix: 'sandcastle/factory',
  checks: ['pnpm test'],
  checkTimeoutMs: 1_000,
  maxRounds: 1,
  setupCommand: 'pnpm install --frozen-lockfile',
  trustPolicy: {
    requiredLabel: 'factory-approved',
    trustedAuthors: ['octocat'],
    trustedRepositories: ['acme/example'],
  },
};

const issueJson = JSON.stringify({
  author: { login: 'octocat' },
  body: 'Requested behavior',
  labels: [{ name: 'factory-approved' }],
  number: 42,
  title: 'Add behavior',
  url: 'https://github.com/acme/example/issues/42',
});

type FakeAgent = { name: string };

const buildAgent: FakeAgent = { name: 'fake-build-agent' };
const reviewAgent: FakeAgent = { name: 'fake-review-agent' };

function taggedSkillReview(findings: unknown[] = []) {
  const critical = findings.filter((finding): finding is { severity: string } => (
    typeof finding === 'object' && finding !== null && (finding as { severity?: unknown }).severity === 'critical'
  )).length;
  const high = findings.filter((finding): finding is { severity: string } => (
    typeof finding === 'object' && finding !== null && (finding as { severity?: unknown }).severity === 'high'
  )).length;
  return `<review>${JSON.stringify({
    counts: { critical, high, observations: findings.length - critical - high },
    findings,
    summary: 'Reviewed.',
    verdict: critical > 0 ? 'CHANGES_REQUESTED' : high > 0 ? 'APPROVED_WITH_SUGGESTIONS' : 'APPROVED',
  })}</review>`;
}

function harness(overrides: Partial<MainDependencies<FakeAgent>> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  let exitCode = 0;

  const sandbox = {
    close: async () => {
      events.push('close');
    },
    exec: async (command: string) => {
      events.push(`exec:${command}`);
      if (command.startsWith('git rev-parse')) {
        return { exitCode: 0, stderr: '', stdout: 'abc123\n' };
      }
      if (command.startsWith('git status')) {
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      return { exitCode: 0, stderr: '', stdout: 'passed' };
    },
    run: async ({ agent, name }: { agent: FakeAgent; name: string }) => {
      events.push(`run:${name}:${agent.name}`);
      return {
        stdout: name === 'review' ? taggedSkillReview() : '',
      };
    },
  };

  const dependencies: MainDependencies<FakeAgent> = {
    buildAgent,
    createSandbox: async input => {
      events.push(`create:${input.branch}`);
      return sandbox;
    },
    loadIssue: async command => {
      events.push(`load:${command}`);
      return { exitCode: 0, stderr: '', stdout: issueJson };
    },
    now: () => 123,
    output: {
      error: message => errors.push(message),
      log: message => logs.push(message),
    },
    readFile: async path => {
      events.push(`readFile:${path}`);
      throw new Error(`unexpected readFile: ${path}`);
    },
    reviewAgent,
    setExitCode: code => {
      exitCode = code;
    },
    ...overrides,
  };

  return {
    dependencies,
    errors,
    events,
    exitCode: () => exitCode,
    logs,
    sandbox,
  };
}

test('runMain completes successfully and prints the final result', async () => {
  const testHarness = harness();
  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'completed');
  assert.equal(testHarness.exitCode(), 0);
  assert.equal(testHarness.events[0], 'load:gh issue view 42 --repo acme/example --json author,body,labels,number,title,url');
  assert.equal(testHarness.events[1], 'create:sandcastle/factory/123');
  assert.equal(testHarness.events.at(-1), 'close');
  assert.match(testHarness.logs.at(-2) ?? '', /"status": "passed"/);
  assert.equal(testHarness.logs.at(-1), '[setup] Closing sandbox');
});

test('implement and fix runs use the build agent, and the review run uses the review agent', async () => {
  const testHarness = harness();
  await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(testHarness.events.some(event => event === `run:implement:${buildAgent.name}`), true);
  assert.equal(testHarness.events.some(event => event === `run:review:${reviewAgent.name}`), true);
  assert.equal(testHarness.events.some(event => event.startsWith('run:') && event.includes(reviewAgent.name) && !event.startsWith('run:review:')), false);
});

test('runs from a file without calling gh, deriving the issue and branch from the file', async () => {
  const testHarness = harness({
    readFile: async path => {
      assert.equal(path, 'issue.md');
      return '# Add a widget\n\nBuild the thing.';
    },
  });

  const outcome = await runMain(testHarness.dependencies, ['--file', 'issue.md'], options);

  assert.equal(outcome.status, 'completed');
  assert.equal(testHarness.events.some(event => event.startsWith('load:')), false);
  assert.equal(testHarness.events[0], 'create:sandcastle/factory/file-issue-123');
  assert.match(testHarness.logs.at(-2) ?? '', /"status": "passed"/);
});

test('--file combined with --review-only skips implementation but still reviews', async () => {
  const testHarness = harness({
    readFile: async () => '# Add a widget\n\nBuild the thing.',
  });

  const outcome = await runMain(testHarness.dependencies, ['--file', 'issue.md', '--review-only'], options);

  assert.equal(outcome.status, 'completed');
  assert.equal(testHarness.logs.includes('[review-only] Skipping implementation'), true);
  assert.equal(testHarness.events.some(event => event === `run:implement:${buildAgent.name}`), false);
  assert.equal(testHarness.events.some(event => event === `run:review:${reviewAgent.name}`), true);
});

test('issue-load failure does not provision a sandbox and propagates exit code', async () => {
  const testHarness = harness({
    loadIssue: async () => ({ exitCode: 1, stderr: 'not found', stdout: '' }),
  });
  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.equal(testHarness.events.some(event => event.startsWith('create:')), false);
  assert.match(testHarness.errors[0] ?? '', /unable to load GitHub issue/i);
});

test('agent failure reports an error and always closes the sandbox', async () => {
  const testHarness = harness();
  testHarness.sandbox.run = async () => {
    throw new Error('agent unavailable');
  };

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.deepEqual(testHarness.events.filter(event => event === 'close'), ['close']);
  assert.match(testHarness.errors[0] ?? '', /agent unavailable/);
});

test('malformed tagged review JSON fails and closes the sandbox', async () => {
  const testHarness = harness();
  testHarness.sandbox.run = async ({ name }: { name: string }) => ({
    stdout: name === 'review' ? '<review>{bad json}</review>' : '',
  });

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.deepEqual(testHarness.events.filter(event => event === 'close'), ['close']);
  assert.match(testHarness.errors[0] ?? '', /invalid review JSON/i);
});

test('unresolved final-round findings produce failure output and exit code', async () => {
  const testHarness = harness();
  testHarness.sandbox.run = async ({ name }: { name: string }) => ({
    stdout: name === 'review'
      ? taggedSkillReview([{
          domain: 'bug',
          fix: 'fix',
          fix_prompt: 'Fix the bug in src/a.ts at line 1.',
          id: 'bug-broken',
          line: 1,
          path: 'src/a.ts',
          problem: 'broken',
          severity: 'high',
          title: 'bug',
        }])
      : '',
  });

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.status, 'failed');
  assert.equal(testHarness.exitCode(), 1);
  assert.match(testHarness.logs.at(-2) ?? '', /"status": "failed"/);
  assert.equal(testHarness.events.at(-1), 'close');
});

test('close failure propagates an error outcome and exit code', async () => {
  const testHarness = harness();
  testHarness.sandbox.close = async () => {
    throw new Error('close failed');
  };

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.match(testHarness.errors.at(-1) ?? '', /Unable to close sandbox: close failed/);
});

test('content changes to an existing dirty file are detected after review', async () => {
  const testHarness = harness();
  let snapshot = 'dirty-file hash-before';
  testHarness.sandbox.exec = async command => {
    if (command.includes('sha256sum')) {
      return { exitCode: 0, stderr: '', stdout: snapshot };
    }
    return { exitCode: 0, stderr: '', stdout: 'passed' };
  };
  testHarness.sandbox.run = async ({ name }: { name: string }) => {
    if (name === 'review') snapshot = 'dirty-file hash-after';
    return {
      stdout: name === 'review' ? taggedSkillReview() : '',
    };
  };

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.match(testHarness.errors[0] ?? '', /reviewer modified the repository/i);
});

test('Git metadata changes are detected after review', async () => {
  const testHarness = harness();
  let gitState = 'head-and-index-before';
  testHarness.sandbox.exec = async command => {
    if (command.includes('git rev-parse HEAD')) {
      return { exitCode: 0, stderr: '', stdout: gitState };
    }
    return { exitCode: 0, stderr: '', stdout: 'unchanged-file-hashes' };
  };
  testHarness.sandbox.run = async ({ name }: { name: string }) => {
    if (name === 'review') gitState = 'head-and-index-after';
    return {
      stdout: name === 'review' ? taggedSkillReview() : '',
    };
  };

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.match(testHarness.errors[0] ?? '', /reviewer modified the repository/i);
});

test('production adapter wraps checks with timeout and classifies timeout exits', async () => {
  const testHarness = harness();
  let checkCommand = '';
  testHarness.sandbox.exec = async command => {
    if (command.startsWith('timeout ')) {
      checkCommand = command;
      return { exitCode: 124, stderr: '', stdout: '' };
    }
    return { exitCode: 0, stderr: '', stdout: 'snapshot' };
  };

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.checks[0]?.timedOut, true);
  assert.match(checkCommand, /timeout .* 1s sh -lc 'pnpm test'/);
  assert.ok(testHarness.logs.includes('[check] pnpm test timed out after 1000ms'));
});

test('repository snapshot probe failures fail closed and close the sandbox', async () => {
  const testHarness = harness();
  testHarness.sandbox.exec = async command => (
    command.includes('git status --porcelain')
      ? { exitCode: 1, stderr: 'snapshot failed', stdout: '' }
      : { exitCode: 0, stderr: '', stdout: 'snapshot' }
  );

  const outcome = await runMain(testHarness.dependencies, ['42'], options);

  assert.equal(outcome.status, 'error');
  assert.equal(testHarness.exitCode(), 1);
  assert.match(testHarness.errors[0] ?? '', /Unable to capture bounded repository state/i);
  assert.deepEqual(testHarness.events.filter(event => event === 'close'), ['close']);
});
