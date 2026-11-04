import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig } from '../src/config.ts';
import softwareFactory, { MAX_IDLE_STOP_ATTEMPTS, stopDecision } from '../src/index.ts';
import { readRun, type Run, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, pauseRun, planSlices, resolveStall } from '../src/workflow.ts';
import { commit, finding, green, review, sh, slice, tempRepo } from './helpers.ts';

type Registered = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** Registers the extension against a recording `pi` and returns its tools by name; `activated` collects what setActiveTools gets, `handlers` records its event hooks. */
function load(activated: string[] = [], handlers = new Map<string, Handler>()) {
  const tools = new Map<string, Registered>();
  const pi = {
    getActiveTools: () => [],
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool(tool: Registered) {
      tools.set(tool.name, tool);
    },
    setActiveTools: async (names: string[]) => {
      activated.push(...names);
    },
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

  it('advertises the implementer report fields, fix file items optional', () => {
    const report = load().get('factory_implementer_report');
    assert.deepEqual(Object.keys(report?.parameters.properties ?? {}).toSorted(), ['behaviors', 'commits', 'fixItems', 'open']);
    assert.deepEqual(report?.parameters.required?.toSorted(), ['behaviors', 'commits', 'open']);
  });

  it('lets only the named agent call each tool', async () => {
    const tools = load();
    const call = (name: string, caller: TestContext) => tools.get(name)?.execute('id', {}, undefined, undefined, caller);
    await assert.rejects(call('factory_review_submit', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the factory-reviewer agent/);
    await assert.rejects(call('factory_review_validate', ctx('sub', 'factory-reviewer')) ?? Promise.resolve(), /Only the factory-review-validator agent/);
    await assert.rejects(call('factory_checks', ctx('sub', 'factory-implementer')) ?? Promise.resolve(), /Only the main agent/);
    await assert.rejects(call('factory_implementer_report', ctx('main', 'main')) ?? Promise.resolve(), /Only the factory-implementer agent/);
    await assert.rejects(call('factory_implementer_report', ctx('sub', 'factory-reviewer')) ?? Promise.resolve(), /Only the factory-implementer agent/);
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

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root });

/** A git repository with no package.json and no workflows. */
function emptyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'factory-index-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

describe('implementer sessions', () => {
  it('clears the stored report when the orchestrator spawns a new implementer, not for other agents or spawners', async () => {
    const root = emptyRepo();
    const handlers = new Map<string, Handler>();
    const tools = load([], handlers);
    const main = {
      ...ctx('main', 'main'),
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => 'session' },
      ui: { confirm: async () => true, editor: async () => 'true', notify() {} },
    };
    const implementer = { ...ctx('sub', 'factory-implementer'), cwd: root };
    const call = async (name: string, params: unknown, caller: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, caller));
    const spawn = (agent: string, spawner: unknown = main) =>
      handlers.get('before_subagent_spawn')?.({ agent, invocationKind: 'task', patterns: [], type: 'before_subagent_spawn' }, spawner);
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, main);
    const feature = { acceptance: ['works'], blockedBy: [], estimateTokens: 500, seams: ['cli'], title: 'Feature', whatToBuild: 'Feature' };
    await call('factory_plan', { baseRef: 'main', slices: [feature], trunk: 'main' }, main);
    await call('factory_next', {}, main);
    const report = { behaviors: [], commits: [], open: ['NEEDS SEAM: x'] };
    await call('factory_implementer_report', report, implementer);

    await spawn('factory-reviewer');
    await spawn('factory-implementer', implementer);
    assert.match(await call('factory_implementer_report', report, implementer), /Replaced the stored report/);

    await spawn('factory-implementer');
    writeFileSync(join(root, 'work.txt'), 'x\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'work');
    assert.match(await call('factory_checks', {}, main), /No implementer report was submitted for slice 01/);
  });

  it('clears the report at spawn only after factory_checks that was called first has read it', async () => {
    const root = emptyRepo();
    const handlers = new Map<string, Handler>();
    const tools = load(handlers);
    const main = {
      ...ctx('main', 'main'),
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => 'session' },
      ui: { confirm: async () => true, editor: async () => 'true', notify() {} },
    };
    const implementer = { ...ctx('sub', 'factory-implementer'), cwd: root };
    const call = async (name: string, params: unknown, caller: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, caller));
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, main);
    const feature = { acceptance: ['works'], blockedBy: [], estimateTokens: 500, seams: ['cli'], title: 'Feature', whatToBuild: 'Feature' };
    await call('factory_plan', { baseRef: 'main', slices: [feature], trunk: 'main' }, main);
    await call('factory_next', {}, main);
    writeFileSync(join(root, 'work.txt'), 'x\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'work');
    await call('factory_implementer_report', { behaviors: [], commits: [], open: ['first round'] }, implementer);

    const checks = call('factory_checks', {}, main);
    const spawned = handlers.get('before_subagent_spawn')?.({ agent: 'factory-implementer', invocationKind: 'task', patterns: [], type: 'before_subagent_spawn' }, main);
    assert.match(await checks, /first round/);
    await spawned;
    assert.match(await call('factory_implementer_report', { behaviors: [], commits: [], open: [] }, implementer), /Stored the report/);
  });
});

describe('first-run checks dialog', () => {
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

describe('used-up fix budget', () => {
  type Ui = { confirm?: (title: string, body: string) => Promise<boolean>; select?: () => Promise<string | undefined> };
  type Reply = { content: { text: string }[] };

  /**
   * A run started through the loaded tools with maxRounds 1, its plan approved and slice 01 started. Checks pass once
   * `ok` is committed and `bad` is not. `call` runs a tool with the given dialog stubs; the repo goes when `using` ends.
   */
  async function budgetRun(slices: string[]) {
    const repo = tempRepo('factory-budget-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok', '! test -f bad'], maxRounds: 1 }) });
    const tools = load();
    const call = async (name: string, params: unknown, ui: Ui = {}) => {
      const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {}, ...ui } };
      const tool = tools.get(name);
      if (tool === undefined) throw new Error('no tool');
      return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
    };
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, slices.map(title => slice(title)))));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    return { ...repo, call, ws };
  }

  /**
   * Fails checks once, or twice with the user continuing the stall the second failure hits (roundLimit 2), then takes
   * the slice to green with one thermo observation.
   */
  async function greenWithObservation(ws: Workspace, failures: 1 | 2) {
    commit(ws, 'work.txt');
    for (let i = 0; i < failures; i += 1) await withRun(ws, 'demo', run => runChecks(ws, run));
    if (failures === 2) {
      assert.equal(readRun(ws, 'demo').slices[0]?.stalled, true);
      await withRun(ws, 'demo', run => resolveStall(ws, run, 'continue'));
    }
    commit(ws, 'ok');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
  }

  it('explains the used-up budget after a pause, and resume asks to raise it by maxRounds', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    await greenWithObservation(ws, 2);

    const fixed = await call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' }, { confirm: async () => true, select: async () => 'Pause the run' });
    assert.doesNotMatch(fixed.content[0]?.text ?? '', /The run is (paused|stalled)/);
    assert.match(
      fixed.content[0]?.text ?? '',
      /The user paused the run\. The fix budget of slice 01 "Feature" is used up after 2 fix rounds\. Tell the user that \/factory resume demo asks whether to raise it/,
    );

    const asked: string[] = [];
    const ask = (answer: boolean) => ({ confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), answer) });
    await assert.rejects(
      call('factory_start', { resume: 'demo' }, ask(false)),
      /kept "demo" stalled\. The fix budget of slice 01 "Feature" is used up.*\/factory resume demo asks whether to raise it/,
    );
    assert.match(asked[0] ?? '', /slice 01 "Feature" used up its fix budget of 2 rounds/);
    assert.match(asked[0] ?? '', /Raise the fix budget by 1 rounds and resume\?/);
    assert.equal(readRun(ws, 'demo').status, 'stalled');

    await call('factory_start', { resume: 'demo' }, ask(true));
    const resumed = readRun(ws, 'demo');
    assert.deepEqual([resumed.status, resumed.slices[0]?.stalled, resumed.slices[0]?.roundLimit], ['running', false, 3]);
  });

  it('keeps the plain resume wording for a paused run that is not stalled', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    await withRun(ws, 'demo', current => pauseRun(current, 'test'));
    const asked: string[] = [];
    await assert.rejects(call('factory_start', { resume: 'demo' }, { confirm: async (_title, body) => (asked.push(body), false) }), /The user kept "demo" paused\./);
    assert.deepEqual(asked, ['Resume "demo" (paused)?']);
    assert.equal(readRun(ws, 'demo').status, 'paused');
  });

  it('refuses factory_reopen of a done slice on a paused stall with the stall notice, before any dialog', async () => {
    using run = await budgetRun(['Feature', 'Second']);
    const { call, ws } = run;
    commit(ws, 'ok');
    await green(ws);
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    await withRun(ws, 'demo', current => nextSlice(ws, current));
    commit(ws, 'bad');
    for (let i = 0; i < 2; i += 1) await withRun(ws, 'demo', current => runChecks(ws, current));
    await withRun(ws, 'demo', current => resolveStall(ws, current, 'pause'));

    let dialogs = 0;
    await assert.rejects(
      call('factory_reopen', { reason: 'bug', slice: '01' }, { confirm: async () => (dialogs++, true) }),
      /fix budget of slice 02 "Second" is used up.*\/factory resume demo asks whether to raise it/,
    );
    assert.equal(dialogs, 0);
  });

  it('asks to raise the budget on resume when a stall was interrupted before the user chose', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    await greenWithObservation(ws, 1);
    const interrupted = { confirm: async () => true, select: async () => Promise.reject(new Error('omp exited')) };
    await assert.rejects(call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' }, interrupted));
    assert.deepEqual([readRun(ws, 'demo').status, readRun(ws, 'demo').slices[0]?.stalled], ['running', true]);

    const asked: string[] = [];
    const ask = (answer: boolean) => ({ confirm: async (_title: string, body: string) => (asked.push(body), answer) });
    await assert.rejects(call('factory_start', { resume: 'demo' }, ask(false)), /kept "demo" stalled/);
    assert.match(asked[0] ?? '', /Raise the fix budget by 1 rounds and resume\?/);
    assert.equal(readRun(ws, 'demo').status, 'stalled');

    await call('factory_start', { resume: 'demo' }, ask(true));
    const resumed = readRun(ws, 'demo');
    assert.deepEqual([resumed.status, resumed.slices[0]?.stalled, resumed.slices[0]?.roundLimit], ['running', false, 2]);
  });

  it('sends a green slice back to fix for a bug alone, showing the bug in the dialog', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    commit(ws, 'ok');
    await green(ws);
    const asked: string[] = [];
    const fixed = await call('factory_fix', { bug: 'Empty input crashes the parser.', reason: 'Found while demoing.' }, { confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), true) });
    assert.match(asked[0] ?? '', /^Fix a bug in slice 01 "Feature"\?\nFound while demoing\.\n\n- Bug: Empty input crashes the parser\./);
    assert.match(fixed.content[0]?.text ?? '', /Slice 01 is back in fix for the bug\. Fix file: .*01-f1\.md/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
  });

  it('shows the start of a long bug in the factory_fix dialog', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    commit(ws, 'ok');
    await green(ws);
    const asked: string[] = [];
    await call('factory_fix', { bug: `Saving a draft loses the title.\n${'log line\n'.repeat(600)}`, reason: 'Found while demoing.' }, { confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), true) });
    assert.match(asked[0] ?? '', /- Bug: Saving a draft loses the title\.\n[\s\S]*\.\.\.\[truncated\]/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
  });

  it('refuses factory_fix with neither a bug nor observations, before any dialog', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    commit(ws, 'ok');
    await green(ws);
    let dialogs = 0;
    await assert.rejects(call('factory_fix', { reason: 'tidy' }, { confirm: async () => (dialogs++, true) }), /factory_fix needs a bug, observation ids, or both/);
    assert.equal(dialogs, 0);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
  });

  it('factory_start activates factory_carry', async () => {
    using repo = tempRepo('factory-carry-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) });
    const activated: string[] = [];
    const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {} } };
    await load(activated).get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, caller);
    assert.ok(activated.includes('factory_carry'));
  });

  it('carries an observation and a note into a pending slice after the user confirms, and keeps the active slice green', async () => {
    using run = await budgetRun(['Feature', 'Second']);
    const { call, ws } = run;
    await greenWithObservation(ws, 1);
    const asked: string[] = [];
    const answer = (ok: boolean) => ({ confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), ok) });
    const params = { note: 'Log the parse time.', observations: ['thermo-naming'], to: '02' };

    const declined = await call('factory_carry', params, answer(false));
    assert.match(declined.content[0]?.text ?? '', /The user did not carry/);
    assert.deepEqual(readRun(ws, 'demo').slices[1]?.carried, []);

    const carried = await call('factory_carry', params, answer(true));
    assert.match(asked[0] ?? '', /^Carry into slice 02 "Second"\?\n- Note: Log the parse time\.\n- thermo-naming: naming\n\nSlice 01 keeps its green review/);
    assert.match(carried.content[0]?.text ?? '', /Carried the note, thermo-naming into slice 02 "Second"\. Ticket: .*02-second\.md\nNext: Call factory_complete_slice for slice 01/);
    const state = readRun(ws, 'demo');
    assert.equal(state.slices[0]?.phase, 'ready');
    assert.match(readFileSync(ticketPath(ws, 'demo', state.slices[1] ?? assert.fail('no slice')), 'utf8'), /## Carried-in work[\s\S]*Log the parse time\.[\s\S]*thermo-naming/);
  });

  it('refuses factory_carry to a slice that is not pending, before any dialog', async () => {
    using run = await budgetRun(['Feature', 'Second']);
    const { call, ws } = run;
    await greenWithObservation(ws, 1);
    let dialogs = 0;
    await assert.rejects(call('factory_carry', { note: 'Later.', to: '01' }, { confirm: async () => (dialogs++, true) }), /Slice 01 is active; factory_carry takes a pending slice/);
    assert.equal(dialogs, 0);
  });

  it('queues work for the end with factory_carry, lists it in factory_status, refuses factory_retro, and factory_follow_up takes it', async () => {
    using run = await budgetRun(['Feature']);
    const { call, ws } = run;
    await greenWithObservation(ws, 1);
    const asked: string[] = [];
    const yes = { confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), true) };
    const before = readRun(ws, 'demo').slices;

    const queued = await call('factory_carry', { note: 'Log the parse time.', observations: ['thermo-naming'], to: 'end' }, yes);
    assert.match(asked[0] ?? '', /^Carry to the end of the run\?\n- Note: Log the parse time\.\n- thermo-naming: naming\n\nSlice 01 keeps its green review\. They wait on the run: the next factory_follow_up slice builds them/);
    assert.match(queued.content[0]?.text ?? '', /^Queued the note, thermo-naming for the next factory_follow_up slice \(1 waiting\)\.\nNext: Call factory_complete_slice for slice 01/);
    assert.deepEqual(readRun(ws, 'demo').slices, before);

    const status = await call('factory_status', {});
    assert.match(status.content[0]?.text ?? '', /"waiting": \[\n\s+"### From green review 01-r1 of slice 01 \\"Feature\\"\\n\\nLog the parse time\.\\n\\n#### \[observation\] thermo-naming/);

    await withRun(ws, 'demo', current => completeSlice(ws, current));
    await assert.rejects(call('factory_retro', { findings: [] }), /Carried items wait for the end of the run \(1\)\. Call factory_follow_up for them/);

    const followUp = { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' };
    const added = await call('factory_follow_up', followUp, yes);
    assert.match(asked[1] ?? '', /The slice also takes the carried items waiting on the run \(1\)\./);
    assert.match(added.content[0]?.text ?? '', /^Slice 02 "Polish" is added on .*, with the waiting carried items \(1\)\.\nNext: Call factory_next/);
    const state = readRun(ws, 'demo');
    assert.deepEqual(state.waiting, []);
    assert.match(readFileSync(ticketPath(ws, 'demo', state.slices[1] ?? assert.fail('no slice')), 'utf8'), /## Carried-in work[\s\S]*Log the parse time\./);
  });

  it('does not send a paused stall to the retro while carried items wait', async () => {
    using run = await budgetRun(['Feature', 'Second']);
    const { call, ws } = run;
    await greenWithObservation(ws, 1);
    await call('factory_carry', { note: 'Log the parse time.', to: 'end' }, { confirm: async () => true });
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    await withRun(ws, 'demo', current => nextSlice(ws, current));
    commit(ws, 'bad');
    await call('factory_checks', {});
    const paused = await call('factory_checks', {}, { select: async () => 'Pause the run' });
    const text = paused.content[0]?.text ?? '';
    assert.match(text, /The user paused the run\. The fix budget of slice 02 "Second" is used up/);
    assert.match(text, /Carried items wait on the run \(1\), so the retro waits: after \/factory resume, a factory_follow_up slice takes them \(Next: asks for it once every existing slice is done\)\. Stop now\./);
    assert.doesNotMatch(text, /Run the retro now/);
  });
});
