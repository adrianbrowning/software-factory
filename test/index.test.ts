import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig } from '../src/config.ts';
import softwareFactory, { MAX_IDLE_STOP_ATTEMPTS, stopDecision } from '../src/index.ts';
import { type Run, withRun } from '../src/run.ts';
import { runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { sh, tempRepo } from './helpers.ts';

type Registered = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

/** Registers the extension against a recording `pi` and returns its tools by name. */
function load() {
  const tools = new Map<string, Registered>();
  const pi = {
    getActiveTools: () => [],
    on() {},
    registerCommand() {},
    registerTool(tool: Registered) {
      tools.set(tool.name, tool);
    },
    setActiveTools: async () => {},
    setLabel() {},
  };
  softwareFactory(pi as unknown as ExtensionAPI);
  return tools;
}

type TestContext = { agent: { depth: number; id: string; kind: 'main' | 'sub'; name: string }; cwd: string; hasUI: boolean };

const ctx = (kind: 'main' | 'sub', name: string): TestContext => ({ agent: { depth: 1, id: `${name}-1`, kind, name }, cwd: process.cwd(), hasUI: false });

describe('tool registration', () => {
  it('advertises each tool schema as JSON Schema', () => {
    const submit = load().get('factory_review_submit');
    assert.deepEqual(Object.keys(submit?.parameters.properties ?? {}).toSorted(), ['domain', 'findings', 'reviewId']);
  });

  it('makes the orchestrator choose the review domains to skip', () => {
    assert.deepEqual(load().get('factory_review_start')?.parameters.required, ['skip']);
  });

  it('lets only the named agent call each tool', async () => {
    const tools = load();
    const call = (name: string, caller: TestContext) => tools.get(name)?.execute('id', {}, undefined, undefined, caller);
    await assert.rejects(call('factory_review_submit', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the factory-reviewer agent/);
    await assert.rejects(call('factory_review_validate', ctx('sub', 'factory-reviewer')) ?? Promise.resolve(), /Only the factory-review-validator agent/);
    await assert.rejects(call('factory_checks', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the main agent/);
  });
});

describe('stopDecision', () => {
  const run = (overrides: Partial<Run> = {}) => ({ events: [{}, {}], ownerSessionId: 'owner', status: 'running', ...overrides }) as unknown as Run;

  it('allows stops for other sessions and for runs that are not running', () => {
    assert.equal(stopDecision(run(), 'someone-else', undefined).action, 'allow');
    assert.equal(stopDecision(run({ status: 'paused' }), 'owner', undefined).action, 'allow');
  });

  it(`blocks idle stops, then pauses on attempt ${MAX_IDLE_STOP_ATTEMPTS}`, () => {
    let attempts: { count: number; events: number } | undefined;
    const actions: string[] = [];
    for (let i = 0; i < MAX_IDLE_STOP_ATTEMPTS; i += 1) {
      const decision = stopDecision(run(), 'owner', attempts);
      actions.push(decision.action);
      if (decision.action === 'block') attempts = decision.attempts;
    }
    assert.deepEqual(actions, [...Array(MAX_IDLE_STOP_ATTEMPTS - 1).fill('block'), 'pause']);
  });

  it('restarts the count when the run made progress', () => {
    const decision = stopDecision(run(), 'owner', { count: MAX_IDLE_STOP_ATTEMPTS - 1, events: 1 });
    assert.equal(decision.action, 'block');
  });
});

describe('first-run checks dialog', () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  });

  /** A git repository with no package.json and no workflows. */
  function emptyRepo() {
    const root = mkdtempSync(join(tmpdir(), 'factory-index-'));
    roots.push(root);
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: root });
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 'test@example.com');
    sh('config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'base\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    return root;
  }

  const start = (root: string, answers: (string | undefined)[]) => {
    const caller = {
      ...ctx('main', 'main'),
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => 'session' },
      ui: { editor: async () => answers.shift(), notify() {} },
    };
    const params = { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } };
    return load().get('factory_start')?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
  };

  it('asks again after an empty submission and starts the run with the typed checks', async () => {
    const reply = JSON.stringify(await start(emptyRepo(), ['', 'make test']));
    assert.match(reply, /Run \\"demo\\" is intake\. Checks: make test\./);
  });

  it('rejects when the user cancels the dialog', async () => {
    await assert.rejects(start(emptyRepo(), [undefined]), /cancelled the checks dialog/);
  });
});

/** A run whose one slice has committed `ok`, driven through the loaded tools; the repo is removed when `using` ends. */
async function sliceAtCommit(prefix: string) {
  const repo = tempRepo(prefix, { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) });
  const { root } = repo;
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
  const tools = load();
  const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws = { config: loadConfig(root), root };
  const input = { acceptance: ['works'], blockedBy: [], estimateTokens: 500, seams: ['cli'], title: 'Feature', whatToBuild: 'Feature' };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [input])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  writeFileSync(join(root, 'ok'), 'x\n');
  sh(root, 'add', 'ok');
  sh(root, 'commit', '-qm', 'add ok');
  return { ...repo, call, ws };
}

describe('factory_decide', () => {
  it('tells the orchestrator in its Next line to stop the discarded review, then call factory_review_start', async () => {
    using slice = await sliceAtCommit('factory-decide-');
    const { call, ws } = slice;
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));

    const reply = (await call('factory_decide', { decisions: ['Late decision.'] })) as { content: { text: string }[] };
    const next = reply.content[0]?.text.split('\n').find(line => line.startsWith('Next: '));
    assert.match(next ?? '', new RegExp(`^Next: Stop the running reviewers and validator of review ${reviewId}; their submissions are refused\\. .*factory_review_start`));
  });
});

describe('factory_checks', () => {
  it('factory_checks says it reuses the results that passed on the same commit', async () => {
    using slice = await sliceAtCommit('factory-checks-');
    const { call, root } = slice;
    await call('factory_checks', {});

    const reply = (await call('factory_checks', {})) as { content: { text: string }[] };
    const sha = sh(root, 'rev-parse', 'HEAD');
    assert.match(reply.content[0]?.text ?? '', new RegExp(`All checks already passed on ${sha}; reusing their results, no check ran\\.`));
  });
});
