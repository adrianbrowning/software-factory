import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import softwareFactory, { MAX_IDLE_STOP_ATTEMPTS, stopDecision } from '../src/index.ts';
import { readRun, type Run } from '../src/run.ts';

type Registered = { execute: (...args: unknown[]) => Promise<unknown>; name: string; parameters: { properties?: Record<string, unknown> } };

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

  it('lets only the named agent call each tool', async () => {
    const tools = load();
    const call = (name: string, caller: TestContext) => tools.get(name)?.execute('id', {}, undefined, undefined, caller);
    await assert.rejects(call('factory_review_submit', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the factory-reviewer agent/);
    await assert.rejects(call('factory_review_validate', ctx('sub', 'factory-reviewer')) ?? Promise.resolve(), /Only the factory-review-validator agent/);
    await assert.rejects(call('factory_checks', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the main agent/);
  });
});

describe('factory_decide', () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  });

  /**
   * A repository with `.omp/factory.json` and a started run, driven through the registered tools. `answer` is the
   * user's reply to each dialog; `undefined` means a session without a UI.
   */
  async function started(config: Record<string, unknown>, answer: boolean | undefined) {
    const root = mkdtempSync(join(tmpdir(), 'factory-tool-'));
    roots.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(root, '.omp'));
    writeFileSync(join(root, '.omp', 'factory.json'), JSON.stringify({ baseRef: 'main', checks: ['true'], ...config }));
    git('add', '.');
    git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qm', 'base');
    const asked: string[] = [];
    const context = {
      ...ctx('main', 'main'),
      cwd: root,
      hasUI: answer !== undefined,
      sessionManager: { getSessionId: () => 'session-1' },
      ui: {
        confirm: async (title: string) => {
          asked.push(title);
          return answer ?? assert.fail('no UI in this session');
        },
      },
    };
    const tools = load();
    const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, context);
    await call('factory_start', { feature: 'demo', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
    const decided = () => readRun({ config: { scratchDir: '.scratch' } as never, root }, 'demo').decisions;
    return { asked, decide: (decisions: string[]) => call('factory_decide', { decisions }), decided };
  }

  it('asks the user by default, and records nothing they reject', async () => {
    const run = await started({}, false);
    await run.decide(['Keep the tsx runner.']);
    assert.deepEqual(run.asked, ['Record these decisions for reviewers?']);
    assert.deepEqual(run.decided(), []);
    const unattended = await started({}, undefined);
    await assert.rejects(unattended.decide(['Keep the tsx runner.']) ?? Promise.resolve(), /needs the interactive UI/);
  });

  it('records decisions without a dialog, even with no UI, when confirmDecisions is false', async () => {
    const run = await started({ confirmDecisions: false }, undefined);
    await run.decide(['Keep the tsx runner.']);
    assert.deepEqual(run.asked, []);
    assert.deepEqual(run.decided(), ['Keep the tsx runner.']);
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
