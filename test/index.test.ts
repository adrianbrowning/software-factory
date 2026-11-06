import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig } from '../src/config.ts';
import type * as agents from '../src/agents.ts';
import softwareFactory, { MAX_IDLE_STOP_ATTEMPTS, stopDecision } from '../src/index.ts';
import { readRun, type Run, statePath, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, pauseRun, planSlices, resolveStall } from '../src/workflow.ts';
import { commit, finding, green, review, sh, slice, tempDir, tempRepo } from './helpers.ts';

type Registered = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

/** Registers the extension against a recording `pi` and returns its tools by name; `activated` collects what setActiveTools gets, `handlers` records its event hooks, `commands` its slash commands, `thinking` gives pi.getThinkingLevel. */
function load(activated: string[] = [], handlers = new Map<string, Handler>(), commands = new Map<string, Command>(), thinking: () => string | undefined = () => 'off') {
  const tools = new Map<string, Registered>();
  const pi = {
    getActiveTools: () => [],
    getThinkingLevel: thinking,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
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
  it('advertises each tool schema as JSON Schema, with the scope fix item verdicts as one shape per status', () => {
    const submit = load().get('factory_review_submit');
    assert.deepEqual(Object.keys(submit?.parameters.properties ?? {}).toSorted(), ['domain', 'findings', 'fixItems', 'reviewId']);
    assert.deepEqual(submit?.parameters.required?.toSorted(), ['domain', 'findings', 'reviewId']);
    type Shape = { properties?: { status?: { const?: string; enum?: string[] } }; required?: string[] };
    const fixItems = submit?.parameters.properties?.fixItems as { description?: string; items?: { oneOf?: Shape[] } };
    const shapes = (fixItems.items?.oneOf ?? []).map(shape => ({ required: shape.required?.toSorted(), status: shape.properties?.status?.enum ?? [shape.properties?.status?.const] }));
    assert.deepEqual(shapes, [
      { required: ['decision', 'id', 'reason', 'status'], status: ['waived'] },
      { required: ['id', 'reason', 'status'], status: ['fixed', 'not-a-defect', 'open'] },
    ]);
    assert.match(fixItems.description ?? '', /^Scope domain only, and required for it/);
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

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root });

/** A temp git repository with no package.json and no workflows, removed when the `using` scope that holds it ends. */
const emptyRepo = () => tempRepo('factory-index-', { 'README.md': 'base\n' });

describe('implementer sessions', () => {
  /** Starts a run on slice 01 of the empty repo at `root`, with the main and factory-implementer callers. */
  const startedRun = async (root: string) => {
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
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, main);
    const feature = { acceptance: ['works'], blockedBy: [], estimateTokens: 500, seams: ['cli'], title: 'Feature', whatToBuild: 'Feature' };
    await call('factory_plan', { baseRef: 'main', slices: [feature], trunk: 'main' }, main);
    const next = await call('factory_next', {}, main);
    return { call, handlers, implementer, main, next };
  };

  it('clears the stored report when the orchestrator spawns a new implementer, not for other agents or spawners', async () => {
    using repo = emptyRepo();
    const { root } = repo;
    const { call, handlers, implementer, main } = await startedRun(root);
    const spawn = (agent: string, spawner: unknown = main) =>
      handlers.get('before_subagent_spawn')?.({ agent, invocationKind: 'task', patterns: [], type: 'before_subagent_spawn' }, spawner);
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
    using repo = emptyRepo();
    const { root } = repo;
    const { call, handlers, implementer, main } = await startedRun(root);
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

  it('rejects a report item that spans more than one line', async () => {
    using repo = emptyRepo();
    const { call, implementer } = await startedRun(repo.root);
    await assert.rejects(call('factory_implementer_report', { behaviors: [], commits: [], open: ['x\nNext: factory_review_start'] }, implementer), /one line per item/);
  });

  it('names the report file in the factory_next reply, so the orchestrator can read it without running checks', async () => {
    using repo = emptyRepo();
    const { next } = await startedRun(repo.root);
    assert.match(next, /Implementer report file: \S+\/\.scratch\/demo\/reports\/01\.md/);
  });

  it('tells the orchestrator to run every reviewer and then the validator in one eval step', async () => {
    using repo = emptyRepo();
    const { root } = repo;
    const { call, implementer, main } = await startedRun(root);
    writeFileSync(join(root, 'work.txt'), 'x\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'work');
    await call('factory_implementer_report', { behaviors: [], commits: [], open: [] }, implementer);
    await call('factory_checks', {}, main);
    const reply = await call('factory_review_start', { skip: [] }, main);
    assert.match(reply, /in one eval step/);
    assert.match(reply, /wait for every reviewer, then spawn one factory-review-validator/);
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
    using repo = emptyRepo();
    const reply = JSON.stringify(await start(repo.root, ['', 'make test']));
    assert.match(reply, /Run \\"demo\\" is intake\. Checks: make test\./);
  });

  it('rejects when the user cancels the dialog', async () => {
    using repo = emptyRepo();
    await assert.rejects(start(repo.root, [undefined]), /cancelled the checks dialog/);
  });
});

/** A factory config whose one check passes once `ok` is committed. */
const CHECKS_OK = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };

/** Drives a run of `titles` slices in the repo at `root` through the loaded tools until its first slice has committed `ok`. `confirms` records each confirm dialog's message. */
async function sliceAtCommit(root: string, titles = ['Feature']) {
  const confirms: string[] = [];
  const confirm = async (_title: string, message: string) => {
    confirms.push(message);
    return true;
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm, notify() {} } };
  const tools = load();
  const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws = { config: loadConfig(root), root };
  const inputs = titles.map((title, index) => ({ acceptance: ['works'], blockedBy: titles.slice(0, index), estimateTokens: 500, seams: ['cli'], title, whatToBuild: title }));
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, inputs)));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  writeFileSync(join(root, 'ok'), 'x\n');
  sh(root, 'add', 'ok');
  sh(root, 'commit', '-qm', 'add ok');
  return { call, confirms, ws };
}

const BUILT_BY_SECOND = 'Built by slice 02 (Second): this slice need not build it; report only code that contradicts it.';

describe('factory_decide', () => {
  it('tells the orchestrator in its Next line to stop the discarded review, then call factory_review_start', async () => {
    using repo = tempRepo('factory-decide-', CHECKS_OK);
    const { call, ws } = await sliceAtCommit(repo.root);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));

    const reply = (await call('factory_decide', { decisions: ['Late decision.'] })) as { content: { text: string }[] };
    const next = reply.content[0]?.text.split('\n').find(line => line.startsWith('Next: '));
    assert.match(next ?? '', new RegExp(`^Next: Stop the running reviewers and validator of review ${reviewId}; their submissions are refused\\. .*factory_review_start`));
  });

  it('stores a decision on the slice that builds it, marks it in earlier tickets and review data, and shows the owner in the confirm dialog', async () => {
    using repo = tempRepo('factory-decide-owner-', CHECKS_OK);
    const { call, confirms, ws } = await sliceAtCommit(repo.root, ['First', 'Second']);

    await call('factory_decide', { decisions: ['Plain decision.', { slice: '02', text: 'Second builds the export.' }] });
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.decisions, ['Plain decision.', 'Second builds the export.']);
    assert.deepEqual(run.slices.map(item => item.ownsDecisions), [[], [2]]);
    assert.match(confirms.at(-1) ?? '', /^- Plain decision\.\n- Second builds the export\. \(built by slice 02 \(Second\)\)$/);
    assert.equal(run.events.at(-1)?.detail, 'Plain decision.; Second builds the export. (built by slice 02 (Second))');
    const ticket = (index: number) => readFileSync(ticketPath(ws, 'demo', run.slices[index] ?? assert.fail('no slice')), 'utf8');
    assert.match(ticket(0), new RegExp(`\\n1\\. Plain decision\\.\\n2\\. Second builds the export\\. ${BUILT_BY_SECOND.replace(/[.()]/g, '\\$&')}\\n`));
    assert.match(ticket(1), /\n1\. Plain decision\.\n2\. Second builds the export\.\n/);

    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { dataFile } = await withRun(ws, 'demo', run => startReview(ws, run));
    assert.ok(readFileSync(dataFile, 'utf8').includes(`2. Second builds the export. ${BUILT_BY_SECOND}\n`));
  });

  it('lists the decisions each slice builds in the plan approval and split dialogs', async () => {
    using repo = tempRepo('factory-plan-owners-', CHECKS_OK);
    const { root } = repo;
    const confirms: string[] = [];
    const confirm = async (_title: string, message: string) => {
      confirms.push(message);
      return true;
    };
    const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm, notify() {} } };
    const tools = load();
    const call = (name: string, params: unknown) => tools.get(name)?.execute('id', params, undefined, undefined, caller) ?? Promise.reject(new Error('no tool'));
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
    const ws = { config: loadConfig(root), root };
    await call('factory_decide', { decisions: ['Plain decision.', 'Big builds the export.'] });
    const input = (title: string, blockedBy: string[] = []) => ({ acceptance: ['works'], blockedBy, estimateTokens: 500, seams: ['cli'], title, whatToBuild: title });
    await call('factory_plan', { baseRef: 'main', slices: [{ ...input('Big'), ownsDecisions: [2] }, input('After', ['Big'])], trunk: 'main' });
    assert.match(confirms.at(-1) ?? '', /01\. Big\n[^]*\n {3}builds decisions: 2\n {3}~500 tokens\n02\. After\n(?![^]*builds decisions)/);
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    // The factory_reslice schema has no ownsDecisions, so a child's claim is dropped rather than stored.
    await call('factory_reslice', { slices: [{ ...input('Part one'), ownsDecisions: [1] }, input('Part two', ['Part one'])] });
    assert.match(confirms.at(-1) ?? '', /^01\. Part one\n(?:(?!builds decisions)[^])*02\. Part two\n[^]*\n {3}builds decisions: 2\n {3}~500 tokens\n03\. After\n/);
    assert.deepEqual(readRun(ws, 'demo').slices.map(item => item.ownsDecisions), [[], [2], []]);
    const parameters = tools.get('factory_reslice')?.parameters as { properties: { slices: { items: { properties: Record<string, unknown> } } } };
    assert.ok(!('ownsDecisions' in parameters.properties.slices.items.properties));
    assert.ok('title' in parameters.properties.slices.items.properties);
  });

  it('refuses a decision naming a done or unknown slice before the confirm dialog, and records nothing', async () => {
    using repo = tempRepo('factory-decide-refuse-', CHECKS_OK);
    const { call, confirms, ws } = await sliceAtCommit(repo.root, ['First', 'Second']);
    await green(ws);
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const before = readRun(ws, 'demo');

    await assert.rejects(call('factory_decide', { decisions: ['Plain.', { slice: '01', text: 'Built by First.' }] }), /Slice 01 is done/);
    await assert.rejects(call('factory_decide', { decisions: [{ slice: '07', text: 'Built by nobody.' }] }), /No slice 07/);
    assert.deepEqual(confirms, []);
    assert.deepEqual(readRun(ws, 'demo'), before);
  });
});

describe('factory_checks', () => {
  it('factory_checks says it reuses the results that passed on the same commit', async () => {
    using repo = tempRepo('factory-checks-', CHECKS_OK);
    const { root } = repo;
    const { call } = await sliceAtCommit(root);
    await call('factory_checks', {});

    const reply = (await call('factory_checks', {})) as { content: { text: string }[] };
    const sha = sh(root, 'rev-parse', 'HEAD');
    assert.match(reply.content[0]?.text ?? '', new RegExp(`All checks already passed on ${sha}; reusing their results, no check ran\\.`));
  });
});

describe('used-up fix budget', () => {
  type Ui = { confirm?: (title: string, body: string) => Promise<boolean>; select?: () => Promise<string | undefined> };
  type Reply = { content: { text: string }[] };

  /** A temp repo whose checks pass once `ok` is committed and `bad` is not, with maxRounds 1; removed when `using` ends. */
  const budgetRepo = () => tempRepo('factory-budget-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok', '! test -f bad'], maxRounds: 1 }) });

  /**
   * Starts a run in the budget repo at `root` through the loaded tools, its plan approved and slice 01 started.
   * `call` runs a tool with the given dialog stubs.
   */
  async function budgetRun(root: string, slices: string[]) {
    const tools = load();
    const call = async (name: string, params: unknown, ui: Ui = {}) => {
      const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {}, ...ui } };
      const tool = tools.get(name);
      if (tool === undefined) throw new Error('no tool');
      return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
    };
    await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
    const ws: Workspace = { config: loadConfig(root), root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, slices.map(title => slice(title)))));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    return { call, ws };
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
    await withRun(ws, 'demo', current => pauseRun(current, 'test'));
    const asked: string[] = [];
    await assert.rejects(call('factory_start', { resume: 'demo' }, { confirm: async (_title, body) => (asked.push(body), false) }), /The user kept "demo" paused\./);
    assert.deepEqual(asked, ['Resume "demo" (paused)?']);
    assert.equal(readRun(ws, 'demo').status, 'paused');
  });

  it('refuses factory_reopen of a done slice on a paused stall with the stall notice, before any dialog', async () => {
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature', 'Second']);
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
    commit(ws, 'ok');
    await green(ws);
    const asked: string[] = [];
    const fixed = await call('factory_fix', { bug: 'Empty input crashes the parser.', reason: 'Found while demoing.' }, { confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), true) });
    assert.match(asked[0] ?? '', /^Fix a bug in slice 01 "Feature"\?\nFound while demoing\.\n\n- Bug: Empty input crashes the parser\./);
    assert.match(fixed.content[0]?.text ?? '', /Slice 01 is back in fix for the bug\. Fix file: .*01-f1\.md/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
  });

  it('shows the start of a long bug in the factory_fix dialog', async () => {
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
    commit(ws, 'ok');
    await green(ws);
    const asked: string[] = [];
    await call('factory_fix', { bug: `Saving a draft loses the title.\n${'log line\n'.repeat(600)}`, reason: 'Found while demoing.' }, { confirm: async (title: string, body: string) => (asked.push(`${title}\n${body}`), true) });
    assert.match(asked[0] ?? '', /- Bug: Saving a draft loses the title\.\n[\s\S]*\.\.\.\[truncated\]/);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
  });

  it('refuses factory_fix with neither a bug nor observations, before any dialog', async () => {
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
    commit(ws, 'ok');
    await green(ws);
    let dialogs = 0;
    await assert.rejects(call('factory_fix', { reason: 'tidy' }, { confirm: async () => (dialogs++, true) }), /factory_fix needs a bug, observation ids, or both/);
    assert.equal(dialogs, 0);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready');
  });

  it('factory_start activates factory_carry', async () => {
    using repo = tempRepo('factory-carry-', CHECKS_OK);
    const activated: string[] = [];
    const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {} } };
    await load(activated).get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, caller);
    assert.ok(activated.includes('factory_carry'));
  });

  it('carries an observation and a note into a pending slice after the user confirms, and keeps the active slice green', async () => {
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature', 'Second']);
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature', 'Second']);
    await greenWithObservation(ws, 1);
    let dialogs = 0;
    await assert.rejects(call('factory_carry', { note: 'Later.', to: '01' }, { confirm: async () => (dialogs++, true) }), /Slice 01 is active; factory_carry takes a pending slice/);
    assert.equal(dialogs, 0);
  });

  it('queues work for the end with factory_carry, lists it in factory_status, refuses factory_retro, and factory_follow_up takes it', async () => {
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature']);
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
    using repo = budgetRepo();
    const { call, ws } = await budgetRun(repo.root, ['Feature', 'Second']);
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

describe('model routing', () => {
  const IMPLEMENTER_MODEL = { fallbacks: ['openai/gpt-5.2', '@slow'], model: 'anthropic/claude-sonnet-4-5' };
  const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

  /**
   * A repo whose factory.json holds `models` (omitted when undefined), with the extension loaded. `available` is the set
   * of specs ctx.models.resolve finds; tests may change it. `live` is the session's model (ctx.models.current), the
   * ctx.model omp falls back on (`ctxModel`), and the thinking level; tests may change it. `call` runs a tool as main;
   * `spawn` fires before_subagent_spawn for `agent` from main, or from the subagent `from`; `stop` fires session_stop
   * in main. The repo goes when `using` ends.
   */
  function routedRepo(models: unknown) {
    const config = { baseRef: 'main', checks: ['test -f ok'], ...(models === undefined ? {} : { models }) };
    const repo = tempRepo('factory-models-', { '.omp/factory.json': JSON.stringify(config) });
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, Command>();
    const live: { ctxModel: string | undefined; model: string | undefined; thinking: string | undefined } = { ctxModel: undefined, model: undefined, thinking: 'off' };
    const tools = load([], handlers, commands, () => live.thinking);
    const available = new Set<string>();
    const asModel = (spec: string) => ({ id: spec.slice(spec.indexOf('/') + 1), provider: spec.slice(0, spec.indexOf('/')) });
    const main = {
      ...ctx('main', 'main'),
      get model() {
        return live.ctxModel === undefined ? undefined : asModel(live.ctxModel);
      },
      cwd: repo.root,
      hasUI: true,
      models: {
        current: () => (live.model === undefined ? undefined : asModel(live.model)),
        resolve: (spec: string) => (available.has(spec) ? asModel(spec === '@slow' ? 'anthropic/claude-sonnet-4-5' : spec) : undefined),
      },
      sessionManager: { getSessionId: () => 'session' },
      ui: { confirm: async () => true, notify() {} },
    };
    const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
    const spawn = (agent: string, cwd = repo.root, from: TestContext['agent'] = main.agent) =>
      handlers.get('before_subagent_spawn')?.({ agent, invocationKind: 'task', patterns: ['@task'], type: 'before_subagent_spawn' }, { ...main, agent: from, cwd });
    const stop = () => handlers.get('session_stop')?.({ session_id: 'session', type: 'session_stop' }, main);
    const command = (args: string) => commands.get('factory')?.handler(args, main);
    const statusModels = async () => {
      const status: { details: { models: unknown } } = JSON.parse(await call('factory_status', {}));
      return status.details.models;
    };
    let children = 0;
    /**
     * A child session of agent `name` that runs `model` (none when undefined) at `thinking` in `cwd`: its own extension
     * instance, as omp loads one per session, sharing this process's module state. `parentId` is the spawning agent, by
     * default this main session. `turn` fires turn_end in it; `usage` sets the context tokens it reports and counts
     * how often the extension asked.
     */
    const child = (name: string, model: string | undefined, thinking: string | undefined, parentId = main.agent.id, cwd = repo.root) => {
      children += 1;
      const childHandlers = new Map<string, Handler>();
      load([], childHandlers, new Map(), () => thinking);
      // Session ids are unique across repos, so no record from another test's run can match.
      const sessionId = `child-session-${children}@${repo.root}`;
      const usage = { reads: 0, tokens: 0 };
      const context = {
        agent: { depth: 1, id: `${children}-${name}`, kind: 'sub', name, parentId },
        cwd,
        getContextUsage: () => {
          usage.reads += 1;
          return { tokens: usage.tokens };
        },
        hasUI: false,
        model: model === undefined ? undefined : asModel(model),
        sessionManager: { getSessionId: () => sessionId },
      };
      return { context, turn: () => childHandlers.get('turn_end')?.({ type: 'turn_end' }, context), usage };
    };
    return { ...repo, available, call, child, command, live, spawn, statusModels, stop };
  }

  it('refuses to start when a configured model does not resolve, naming the role', async () => {
    using repo = routedRepo({ implementer: IMPLEMENTER_MODEL, reviewer: { model: 'anthropic/claude-opus-4-5' } });
    for (const spec of [IMPLEMENTER_MODEL.model, ...IMPLEMENTER_MODEL.fallbacks]) repo.available.add(spec);
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /models\.reviewer: model "anthropic\/claude-opus-4-5" is not available/);
    repo.available.add('anthropic/claude-opus-4-5');
    repo.available.delete('@slow');
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /models\.implementer: fallback "@slow" is not available/);
  });

  it('starts when the session runs the configured orchestrator model and effort, and fails naming both selections when it does not', async () => {
    using repo = routedRepo({ orchestrator: { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'high' } });
    repo.available.add('anthropic/claude-opus-4-5');
    repo.live.model = 'openai/gpt-5.2';
    repo.live.thinking = 'high';
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), (error: Error) => {
      assert.match(error.message, /models\.orchestrator: .*anthropic\/claude-opus-4-5 effort high.*openai\/gpt-5\.2 effort high.*--model anthropic\/claude-opus-4-5 --thinking high/);
      assert.doesNotMatch(error.message, /model matches/);
      return true;
    });
    repo.live.model = 'openrouter/claude-opus-4-5';
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /models\.orchestrator: .*this omp session runs openrouter\/claude-opus-4-5 effort high/);
    repo.live.model = 'anthropic/claude-opus-4-5';
    repo.live.thinking = 'low';
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /models\.orchestrator: .*effort high.*anthropic\/claude-opus-4-5 effort low/);
    repo.live.thinking = 'high';
    assert.match(await repo.call('factory_start', { feature: 'demo', source: SOURCE }), /Run \\"demo\\" is/);
  });

  it("falls back on ctx.model when omp reports no current model, and names 'no model' when it has neither", async () => {
    using repo = routedRepo({ orchestrator: { model: 'anthropic/claude-opus-4-5' } });
    repo.available.add('anthropic/claude-opus-4-5');
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /models\.orchestrator: .*runs no model/);
    repo.live.ctxModel = 'anthropic/claude-opus-4-5';
    assert.match(await repo.call('factory_start', { feature: 'demo', source: SOURCE }), /Run \\"demo\\" is/);
  });

  it('explains that omp clamps the thinking level when the model matches but the effort differs, and names an unset effort', async () => {
    using repo = routedRepo({ orchestrator: { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'max' } });
    repo.available.add('anthropic/claude-opus-4-5');
    repo.live.model = 'anthropic/claude-opus-4-5';
    repo.live.thinking = 'xhigh';
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), (error: Error) => {
      assert.match(error.message, /configured effort max; omp's effective \(clamped\) level is xhigh/);
      assert.match(error.message, /omp clamps --thinking to what the model supports.*set models\.orchestrator\.reasoningEffort to a level this model supports/);
      return true;
    });
    repo.live.thinking = undefined;
    await assert.rejects(repo.call('factory_start', { feature: 'demo', source: SOURCE }), /anthropic\/claude-opus-4-5 effort unset.*omp's effective \(clamped\) level is unset.*omp clamps/);
  });

  it('ignores the effort when the orchestrator entry sets none, and checks nothing without an orchestrator entry', async () => {
    using repo = routedRepo({ orchestrator: { model: '@slow' } });
    repo.available.add('@slow');
    repo.live.model = 'anthropic/claude-sonnet-4-5';
    repo.live.thinking = 'minimal';
    assert.match(await repo.call('factory_start', { feature: 'demo', source: SOURCE }), /Run \\"demo\\" is/);
    using bare = routedRepo(undefined);
    bare.live.model = 'openai/gpt-5.2';
    assert.match(await bare.call('factory_start', { feature: 'demo', source: SOURCE }), /Run \\"demo\\" is/);
  });

  it('checks the orchestrator snapshotted in the run on resume, not a later factory.json', async () => {
    using repo = routedRepo({ orchestrator: { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'high' } });
    repo.available.add('anthropic/claude-opus-4-5');
    repo.live.model = 'anthropic/claude-opus-4-5';
    repo.live.thinking = 'high';
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    writeFileSync(join(repo.root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }));
    repo.live.thinking = 'medium';
    await assert.rejects(repo.call('factory_start', { resume: 'demo' }), (error: Error) => {
      assert.match(error.message, /models\.orchestrator: .*effort high.*effort medium.*--thinking high/);
      assert.match(error.message, /start a new run with another models\.orchestrator.*run snapshot/);
      assert.doesNotMatch(error.message, /change models\.orchestrator/);
      return true;
    });
    repo.live.thinking = 'high';
    assert.match(await repo.call('factory_start', { resume: 'demo' }), /Run \\"demo\\" is/);
  });

  it('gives the new-run remedy in the clamp hint on resume, as the run keeps its snapshotted effort', async () => {
    using repo = routedRepo({ orchestrator: { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'max' } });
    repo.available.add('anthropic/claude-opus-4-5');
    repo.live.model = 'anthropic/claude-opus-4-5';
    repo.live.thinking = 'max';
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    repo.live.thinking = 'xhigh';
    await assert.rejects(repo.call('factory_start', { resume: 'demo' }), (error: Error) => {
      assert.match(error.message, /The model matches but the effort does not.*start a new run with a models\.orchestrator\.reasoningEffort this model supports/);
      assert.doesNotMatch(error.message, /set models\.orchestrator\.reasoningEffort/);
      return true;
    });
  });

  it('snapshots the role mapping into the run: factory_start and factory_status show it, and a later factory.json edit or a resume does not change it', async () => {
    const orchestrator = { model: 'anthropic/claude-opus-4-5', reasoningEffort: 'xhigh' };
    using repo = routedRepo({ implementer: IMPLEMENTER_MODEL, orchestrator });
    for (const spec of [IMPLEMENTER_MODEL.model, ...IMPLEMENTER_MODEL.fallbacks, orchestrator.model]) repo.available.add(spec);
    repo.live.model = orchestrator.model;
    repo.live.thinking = orchestrator.reasoningEffort;
    const started = await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    assert.match(
      started,
      /Models: orchestrator anthropic\/claude-opus-4-5 effort xhigh; implementer anthropic\/claude-sonnet-4-5 \(fallbacks: openai\/gpt-5\.2, @slow\); reviewer inherit; validator inherit; explorer inherit\./,
    );
    const expected = { explorer: 'inherit', implementer: IMPLEMENTER_MODEL, orchestrator, reviewer: 'inherit', validator: 'inherit' };
    writeFileSync(join(repo.root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { implementer: { model: 'openai/gpt-5.2' } } }));
    assert.deepEqual(await repo.statusModels(), expected);
    const resumed = await repo.call('factory_start', { resume: 'demo' });
    assert.match(resumed, /Models: orchestrator anthropic\/claude-opus-4-5 effort xhigh; implementer anthropic\/claude-sonnet-4-5 /);
    assert.deepEqual(await repo.statusModels(), expected);
  });

  it('shows every role as inherit without a models key', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    assert.deepEqual(await repo.statusModels(), { explorer: 'inherit', implementer: 'inherit', orchestrator: 'inherit', reviewer: 'inherit', validator: 'inherit' });
  });

  it('routes every factory-implementer spawn, fix mode included, to the snapshotted model with only the configured fallbacks', async () => {
    using repo = routedRepo({ implementer: IMPLEMENTER_MODEL });
    for (const spec of [IMPLEMENTER_MODEL.model, ...IMPLEMENTER_MODEL.fallbacks]) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const routed = { model: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.2', '@slow'], note: 'Software factory: models.implementer from the run snapshot.' };
    assert.deepEqual(await repo.spawn('factory-implementer'), routed);
    assert.equal(await repo.spawn('factory-reviewer'), undefined);

    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'work.txt');
    await withRun(ws, 'demo', run => runChecks(ws, run));
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'fix');
    assert.deepEqual(await repo.spawn('factory-implementer'), routed);
  });

  it('blocks the implementer spawn, naming the role, when the snapshotted model no longer resolves', async () => {
    using repo = routedRepo({ implementer: { model: 'anthropic/claude-sonnet-4-5' } });
    repo.available.add('anthropic/claude-sonnet-4-5');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    repo.available.delete('anthropic/claude-sonnet-4-5');
    assert.deepEqual(await repo.spawn('factory-implementer'), {
      block: true,
      reason:
        'Software factory: models.implementer: model "anthropic/claude-sonnet-4-5" from the run snapshot no longer resolves in this omp session, so the spawn is refused rather than switched to another model. Make the model available, or start a new run with another models.implementer.',
    });
  });

  it('returns no model without a models key', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    assert.equal(await repo.spawn('factory-implementer'), undefined);
  });

  it('routes reviewer, validator and scout spawns to their own snapshotted models, independently of the implementer', async () => {
    const models = {
      explorer: { model: 'google/gemini-flash' },
      implementer: { model: 'anthropic/claude-sonnet-4-5' },
      reviewer: { fallbacks: ['openai/gpt-5.2'], model: 'anthropic/claude-opus-4-5' },
      validator: { model: 'openai/o3' },
    };
    using repo = routedRepo(models);
    for (const spec of ['google/gemini-flash', 'anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-5', 'openai/gpt-5.2', 'openai/o3']) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    assert.deepEqual(await repo.spawn('factory-reviewer'), { model: ['anthropic/claude-opus-4-5', 'openai/gpt-5.2'], note: 'Software factory: models.reviewer from the run snapshot.' });
    assert.deepEqual(await repo.spawn('factory-review-validator'), { model: ['openai/o3'], note: 'Software factory: models.validator from the run snapshot.' });
    assert.deepEqual(await repo.spawn('scout'), { model: ['google/gemini-flash'], note: 'Software factory: models.explorer from the run snapshot.' });
    assert.deepEqual(await repo.spawn('factory-implementer'), { model: ['anthropic/claude-sonnet-4-5'], note: 'Software factory: models.implementer from the run snapshot.' });
    assert.equal(await repo.spawn('task'), undefined);
  });

  it('blocks a reviewer, validator or scout spawn, naming the role, when its snapshotted model no longer resolves', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' }, reviewer: { model: 'x/r' }, validator: { model: 'x/v' } });
    for (const spec of ['x/e', 'x/r', 'x/v']) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    repo.available.clear();
    for (const [agent, role, model] of [
      ['factory-reviewer', 'reviewer', 'x/r'],
      ['factory-review-validator', 'validator', 'x/v'],
      ['scout', 'explorer', 'x/e'],
    ] as const) {
      const result = (await repo.spawn(agent)) as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, new RegExp(`models\\.${role}: model "${model}" from the run snapshot no longer resolves`));
    }
  });

  it('does not route or block factory-role and scout spawns in a repo with no run while another repo has one', async () => {
    const models = { explorer: { model: 'x/e' }, reviewer: { model: 'x/r' } };
    using other = routedRepo(models);
    using repo = routedRepo(models);
    for (const each of [other, repo]) for (const spec of ['x/e', 'x/r']) each.available.add(spec);
    await other.call('factory_start', { feature: 'demo', source: SOURCE });
    assert.equal(await repo.spawn('scout'), undefined);
    assert.equal(await repo.spawn('factory-reviewer'), undefined);
  });

  it('does not route spawns a subagent makes during an active run', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' }, reviewer: { model: 'x/r' } });
    for (const spec of ['x/e', 'x/r']) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const reviewer = ctx('sub', 'factory-reviewer').agent;
    assert.equal(await repo.spawn('scout', repo.root, reviewer), undefined);
    assert.equal(await repo.spawn('factory-reviewer', repo.root, reviewer), undefined);
  });

  it('does not route or block a spawn of an agent named after an Object prototype key', async () => {
    using repo = routedRepo({ reviewer: { model: 'x/r' } });
    repo.available.add('x/r');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    writeFileSync(statePath({ config: loadConfig(repo.root), root: repo.root }, 'demo'), '{not json');
    for (const agent of ['constructor', 'toString', 'hasOwnProperty']) assert.equal(await repo.spawn(agent), undefined);
  });

  it('routes reviewer, validator and scout spawns without saving the run state; an implementer spawn saves it', async () => {
    const models = { explorer: { model: 'x/e' }, implementer: { model: 'x/i' }, reviewer: { model: 'x/r' }, validator: { model: 'x/v' } };
    using repo = routedRepo(models);
    for (const spec of ['x/e', 'x/i', 'x/r', 'x/v']) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const path = statePath({ config: loadConfig(repo.root), root: repo.root }, 'demo');
    const saved = statSync(path).ino;
    for (const agent of ['factory-reviewer', 'factory-review-validator', 'scout']) await repo.spawn(agent);
    assert.equal(statSync(path).ino, saved);
    await repo.spawn('factory-implementer');
    assert.notEqual(statSync(path).ino, saved);
  });

  it('returns no model, without throwing, for a scout spawn from a cwd outside any git repo', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' } });
    repo.available.add('x/e');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    using outside = tempDir('factory-nogit-');
    assert.equal(await repo.spawn('scout', outside.root), undefined);
  });

  it('keeps routing every factory role and scout to the snapshot after factory.json is edited mid-run', async () => {
    const models = { explorer: { model: 'x/e' }, implementer: { model: 'x/i' }, reviewer: { model: 'x/r' }, validator: { model: 'x/v' } };
    using repo = routedRepo(models);
    for (const spec of ['x/e', 'x/i', 'x/r', 'x/v', 'y/other']) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const routes = async () => {
      for (const [agent, role, model] of [
        ['factory-reviewer', 'reviewer', 'x/r'],
        ['factory-review-validator', 'validator', 'x/v'],
        ['factory-implementer', 'implementer', 'x/i'],
        ['scout', 'explorer', 'x/e'],
      ] as const) {
        assert.deepEqual(await repo.spawn(agent), { model: [model], note: `Software factory: models.${role} from the run snapshot.` });
      }
    };
    const config = join(repo.root, '.omp/factory.json');
    const other = { model: 'y/other' };
    writeFileSync(config, JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { reviewer: { model: 'x/r', reasoningEffort: 'high' } } }));
    assert.throws(() => loadConfig(repo.root), /omp cannot set a subagent's reasoning effort[\s\S]*at models\.reviewer\.reasoningEffort/);
    await routes();
    writeFileSync(config, JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models: { explorer: other, implementer: other, reviewer: other, validator: other } }));
    await routes();
    writeFileSync(config, JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], models, scratchDir: 'elsewhere' }));
    await routes();
  });

  it('returns no model for a scout spawn, and blocks a factory-role spawn, when the run state cannot be read', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' }, reviewer: { model: 'x/r' } });
    repo.available.add('x/e');
    repo.available.add('x/r');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    writeFileSync(statePath(ws, 'demo'), '{not json');
    assert.equal(await repo.spawn('scout'), undefined);
    const result = (await repo.spawn('factory-reviewer')) as { block: boolean; reason: string };
    assert.equal(result.block, true);
    assert.match(result.reason, /models\.reviewer: .*run state/);
  });

  it('does not route or block scout spawns once the run is paused', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' } });
    repo.available.add('x/e');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    assert.equal(readRun(ws, 'demo').status, 'running');
    assert.deepEqual(await repo.spawn('scout'), { model: ['x/e'], note: 'Software factory: models.explorer from the run snapshot.' });
    await repo.command('pause');
    assert.equal(readRun(ws, 'demo').status, 'paused');
    repo.available.clear();
    assert.equal(await repo.spawn('scout'), undefined);
  });

  it('records each factory child and a scout once per session with its actual model and thinking level, and factory_status lists them per slice', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' }, implementer: IMPLEMENTER_MODEL, reviewer: { model: 'x/r' }, validator: { model: 'x/v' } });
    for (const spec of ['x/e', 'x/r', 'x/v', IMPLEMENTER_MODEL.model, ...IMPLEMENTER_MODEL.fallbacks]) repo.available.add(spec);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await repo.spawn('scout');
    await repo.child('scout', 'x/e', 'low').turn();
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    // omp ran the implementer on its configured fallback, so the record names the fallback, not the routed model.
    for (const agent of ['factory-implementer', 'factory-reviewer', 'factory-review-validator']) await repo.spawn(agent);
    const implementer = repo.child('factory-implementer', 'openai/gpt-5.2', 'medium');
    await implementer.turn();
    assert.equal(readRun(ws, 'demo').agents.length, 2);
    await implementer.turn();
    await implementer.turn();
    const reviewer = repo.child('factory-reviewer', 'x/r', 'high');
    await reviewer.turn();
    await reviewer.turn();
    await repo.child('factory-review-validator', 'x/v', undefined).turn();
    await repo.child('task', 'x/t', 'off').turn();
    const status: { details: { agentsOutsideSlices: unknown; slices: { agents: unknown }[] } } = JSON.parse(await repo.call('factory_status', {}));
    const session = (n: number) => `child-session-${n}@${repo.root}`;
    assert.deepEqual(status.details.agentsOutsideSlices, [{ agentId: '1-scout', model: 'x/e', name: 'scout', role: 'explorer', sessionId: session(1), thinking: 'low' }]);
    assert.deepEqual(status.details.slices[0]?.agents, [
      { agentId: '2-factory-implementer', model: 'openai/gpt-5.2', name: 'factory-implementer', role: 'implementer', sessionId: session(2), slice: '01', thinking: 'medium' },
      { agentId: '3-factory-reviewer', model: 'x/r', name: 'factory-reviewer', role: 'reviewer', sessionId: session(3), slice: '01', thinking: 'high' },
      { agentId: '4-factory-review-validator', model: 'x/v', name: 'factory-review-validator', role: 'validator', sessionId: session(4), slice: '01', thinking: 'unset' },
    ]);
  });

  it('records each session once from the run records, though two children share an agent name and turn several times', async () => {
    using repo = routedRepo({ reviewer: { model: 'x/r' } });
    repo.available.add('x/r');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await repo.spawn('factory-reviewer');
    await repo.spawn('factory-reviewer');
    const a = repo.child('factory-reviewer', 'x/r', 'high');
    await a.turn();
    await a.turn();
    // A's session resumed in a new process: a fresh audit module has seen no turn of it, so only the run's stored
    // records keep it from being recorded twice.
    // A dynamic import with a query string loads a second module instance, as a new process would.
    const fresh: typeof agents = await import(new URL('../src/agents.ts?process=2', import.meta.url).href);
    await fresh.auditChild(a.context as never, 'high', { feature: 'demo', mainId: 'main-1', ws });
    const b = repo.child('factory-reviewer', 'x/r', 'high');
    await b.turn();
    assert.deepEqual(
      readRun(ws, 'demo').agents.map(agent => agent.sessionId),
      [`child-session-1@${repo.root}`, `child-session-2@${repo.root}`],
    );
  });

  it('does not record a child whose first turn ended before the run started, on its later turns in the run', async () => {
    using repo = routedRepo(undefined);
    const early = repo.child('scout', 'x/e', 'low');
    await early.turn();
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    await early.turn();
    assert.deepEqual(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').agents, []);
  });

  it('records what actually ran for a scout spawned while the run is paused, and for a child once the run is done', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' } });
    repo.available.add('x/e');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await repo.command('pause');
    assert.equal(await repo.spawn('scout'), undefined);
    await repo.child('scout', 'openai/gpt-5.2', 'low').turn();
    await withRun(ws, 'demo', run => {
      run.status = 'done';
    });
    await repo.child('factory-implementer', 'x/i', 'medium').turn();
    assert.deepEqual(
      readRun(ws, 'demo').agents.map(agent => [agent.name, agent.model, agent.thinking]),
      [
        ['scout', 'openai/gpt-5.2', 'low'],
        ['factory-implementer', 'x/i', 'medium'],
      ],
    );
  });

  it('records nothing, without throwing, for a scout turn outside any factory run or outside any git repo', async () => {
    using repo = routedRepo(undefined);
    writeFileSync(join(repo.root, '.omp/factory.json'), '{not json');
    await repo.child('scout', 'x/e', 'low').turn();
    using outside = tempDir('factory-nogit-');
    await repo.child('scout', 'x/e', 'low', undefined, outside.root).turn();
  });

  it('records a scout through the run remembered when it started, without reloading factory.json', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' } });
    repo.available.add('x/e');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    writeFileSync(join(repo.root, '.omp/factory.json'), '{not json');
    await repo.spawn('scout');
    await repo.child('scout', 'x/e', 'low').turn();
    assert.deepEqual(
      readRun(ws, 'demo').agents.map(agent => agent.role),
      ['explorer'],
    );
  });

  it('does not record a scout another subagent spawned, as only children of the run main session are recorded', async () => {
    using repo = routedRepo({ explorer: { model: 'x/e' } });
    repo.available.add('x/e');
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    await repo.spawn('scout');
    await repo.child('scout', 'x/e', 'low', '9-task').turn();
    assert.deepEqual(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').agents, []);
  });

  it('records nothing, without throwing, for a child named after an Object prototype key', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    await repo.child('constructor', 'x/c', 'low').turn();
    assert.deepEqual(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').agents, []);
  });
});
