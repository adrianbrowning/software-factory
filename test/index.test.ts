import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';
import { type Command, ctx, type Handler, load, type TestContext } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { MAX_IDLE_STOP_ATTEMPTS, resetModuleState, stopDecision } from '../src/index.ts';
import { readRun, type Run, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, pauseRun, planSlices, resolveStall } from '../src/workflow.ts';
import { commit, finding, green, review, sh, slice, tempDir, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

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

describe('active run in a fresh extension copy', () => {
  const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };
  const reviewer = (root: string) => ({ ...ctx('sub', 'factory-reviewer'), cwd: root });
  const submit = (root: string, reviewId: string) =>
    load().get('factory_review_submit')?.execute('id', { domain: 'bug', findings: [], reviewId }, undefined, undefined, reviewer(root)) ?? Promise.reject(new Error('no tool'));
  /** Calls factory_start in a new extension copy as the main session `mainId` in the checkout at `root`. */
  const startIn = async (root: string, params: unknown, mainId: string) => {
    const main = { ...ctx('main', 'main'), agent: { ...ctx('main', 'main').agent, id: mainId }, cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
    await load().get('factory_start')?.execute('id', params, undefined, undefined, main);
  };
  /** A reviewer child of `parentId` at turn_end in a new extension copy; the audit records it in the run bound to `root`. */
  const turnEnd = async (root: string, parentId: string) => {
    const handlers = new Map<string, Handler>();
    load([], handlers);
    const child = {
      ...ctx('sub', 'factory-reviewer'),
      agent: { ...ctx('sub', 'factory-reviewer').agent, parentId },
      cwd: root,
      sessionManager: { getSessionId: () => `child-of-${parentId}` },
    };
    await handlers.get('turn_end')?.({}, child);
  };
  const auditedSessions = (root: string, feature: string) => readRun({ config: loadConfig(root), root }, feature).agents.map(agent => agent.sessionId);

  /** Runs one slice to an open review through the tools of one extension copy, then resets the module state: the next `load()` is a copy with no binding, like a worker thread's. */
  async function openReview(root: string) {
    const { ws } = await sliceAtCommit(root);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    resetModuleState();
    return { reviewId, ws };
  }

  it('records factory_review_submit for the open review of the run another copy bound, and refuses another review id', async () => {
    using repo = tempRepo('factory-fresh-submit-', CHECKS_OK);
    const { reviewId, ws } = await openReview(repo.root);

    await assert.rejects(submit(repo.root, 'not-the-review'), /Review not-the-review is not the active review\./);
    assert.match(JSON.stringify(await submit(repo.root, reviewId)), /Recorded 0 bug findings for /);
    assert.equal(readRun(ws, 'demo').slices[0]?.review?.submissions.bug?.agentId, 'factory-reviewer-1');
  });

  it('keeps the workspace the run started with when factory.json moves scratchDir', async () => {
    using repo = tempRepo('factory-fresh-scratch-', CHECKS_OK);
    const { reviewId, ws } = await openReview(repo.root);
    writeFileSync(join(repo.root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], scratchDir: '.moved' }));

    assert.match(JSON.stringify(await submit(repo.root, reviewId)), /Recorded 0 bug findings for /);
    // The submission landed in the run state the run started with, and nothing was created under the moved scratchDir.
    assert.equal(readRun(ws, 'demo').slices[0]?.review?.submissions.bug?.agentId, 'factory-reviewer-1');
    assert.equal(existsSync(join(repo.root, '.moved')), false);
  });

  it('treats a pointer whose config or feature would leave the repository as no active run', async () => {
    using repo = tempRepo('factory-fresh-tamper-', CHECKS_OK);
    const { reviewId, ws } = await openReview(repo.root);
    const pointer = join(repo.root, '.git', 'software-factory-active-run.json');
    const bound = JSON.parse(readFileSync(pointer, 'utf8')) as { config: { scratchDir: string }; feature: string };

    writeFileSync(pointer, JSON.stringify({ ...bound, config: { ...bound.config, scratchDir: '../elsewhere' } }));
    await assert.rejects(submit(repo.root, reviewId), /No active factory run/);
    writeFileSync(pointer, JSON.stringify({ ...bound, feature: '../demo' }));
    await assert.rejects(submit(repo.root, reviewId), /No active factory run/);
    assert.equal(readRun(ws, 'demo').slices[0]?.review?.submissions.bug, undefined);
  });

  it('tracks implementer compaction in a copy with no binding', async () => {
    using repo = tempRepo('factory-fresh-compaction-', CHECKS_OK);
    const { ws } = await sliceAtCommit(repo.root);
    resetModuleState();
    const handlers = new Map<string, Handler>();
    load([], handlers);

    await handlers.get('auto_compaction_start')?.({}, { ...ctx('sub', 'factory-implementer'), cwd: repo.root, getContextUsage: () => ({ tokens: 1234 }) });

    const slice = readRun(ws, 'demo').slices[0];
    assert.deepEqual([slice?.compactions, slice?.peakContextTokens], [1, 1234]);
  });

  it('audits a child at turn_end in a copy with no binding, and gives each worktree its own run', async () => {
    using repo = tempRepo('factory-fresh-hook-', CHECKS_OK);
    using other = tempDir('factory-fresh-hook-wt-');
    const worktree = join(other.root, 'wt');
    await startIn(repo.root, { feature: 'one', source: SOURCE }, 'main-one');
    sh(repo.root, 'worktree', 'add', '-q', '-b', 'wt', worktree);
    await startIn(worktree, { feature: 'two', source: SOURCE }, 'main-two');
    resetModuleState();

    await turnEnd(worktree, 'main-two');

    assert.deepEqual(auditedSessions(worktree, 'two'), ['child-of-main-two']);
    resetModuleState();
    await turnEnd(repo.root, 'main-one');

    assert.deepEqual(auditedSessions(repo.root, 'one'), ['child-of-main-one']);
    assert.deepEqual(auditedSessions(worktree, 'two'), ['child-of-main-two']);
  });

  it('binds a resumed run, so a copy with no binding audits into it', async () => {
    using repo = tempRepo('factory-fresh-resume-', CHECKS_OK);
    await startIn(repo.root, { feature: 'demo', source: SOURCE }, 'main-start');
    await startIn(repo.root, { feature: 'other', source: SOURCE }, 'main-other');
    await startIn(repo.root, { resume: 'demo' }, 'main-resume');
    resetModuleState();

    await turnEnd(repo.root, 'main-resume');

    assert.deepEqual(auditedSessions(repo.root, 'demo'), ['child-of-main-resume']);
    assert.deepEqual(auditedSessions(repo.root, 'other'), []);
  });

  /** A run bound in `root` whose state directory was then deleted, in a copy with no binding. */
  const startThenDeleteState = async (root: string) => {
    await startIn(root, { feature: 'demo', source: SOURCE }, 'main-start');
    rmSync(join(root, loadConfig(root).scratchDir, 'demo'), { force: true, recursive: true });
    resetModuleState();
  };

  it('starts a new run when the pointer names a run whose state is gone, and rebinds the pointer', async () => {
    using repo = tempRepo('factory-fresh-stale-start-', CHECKS_OK);
    await startThenDeleteState(repo.root);

    await startIn(repo.root, { feature: 'next', source: SOURCE }, 'main-next');
    resetModuleState();
    await turnEnd(repo.root, 'main-next');

    assert.deepEqual(auditedSessions(repo.root, 'next'), ['child-of-main-next']);
  });

  it('allows a stop when the pointer names a run whose state is gone', async () => {
    using repo = tempRepo('factory-fresh-stale-stop-', CHECKS_OK);
    await startThenDeleteState(repo.root);
    const handlers = new Map<string, Handler>();
    load([], handlers);
    const main = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, ui: { notify() {} } };

    assert.equal(await handlers.get('session_stop')?.({ session_id: 'session' }, main), undefined);
  });

  it('shows the bound feature and the read error in /factory status when its state is gone', async () => {
    using repo = tempRepo('factory-fresh-stale-status-', CHECKS_OK);
    await startThenDeleteState(repo.root);
    const commands = new Map<string, Command>();
    load([], new Map(), commands);
    const notices: string[] = [];
    const main = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, ui: { notify: (message: string) => notices.push(message) } };

    await commands.get('factory')?.handler('status', main);

    assert.match(notices.join('\n'), /Active run: demo: state unreadable \(.*ENOENT/);
  });

  it('reads the pointer file once per tool call', async () => {
    using repo = tempRepo('factory-fresh-pointer-once-', CHECKS_OK);
    await startIn(repo.root, { feature: 'demo', source: SOURCE }, 'main-start');
    resetModuleState();
    const status = load().get('factory_status');
    const main = { ...ctx('main', 'main'), cwd: repo.root };
    const original = fs.readFileSync;
    let reads = 0;
    mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('software-factory-active-run.json')) reads += 1;
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await status?.execute('id', {}, undefined, undefined, main);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(reads, 1);
  });

  it('returns without throwing from turn_end and auto_compaction_start for an implementer whose bound run state is gone', async () => {
    using repo = tempRepo('factory-fresh-stale-track-', CHECKS_OK);
    await startThenDeleteState(repo.root);
    const handlers = new Map<string, Handler>();
    load([], handlers);
    const implementer = { ...ctx('sub', 'factory-implementer'), cwd: repo.root, getContextUsage: () => ({ tokens: 1234 }), sessionManager: { getSessionId: () => 'child' } };

    await handlers.get('auto_compaction_start')?.({}, implementer);
    await handlers.get('turn_end')?.({}, implementer);
  });

  it('uses the bound workspace for /factory submit with no argument after scratchDir moved', async () => {
    using repo = tempRepo('factory-fresh-submit-cmd-', CHECKS_OK);
    await startIn(repo.root, { feature: 'demo', source: SOURCE }, 'main-start');
    resetModuleState();
    writeFileSync(join(repo.root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], scratchDir: '.moved' }));
    const commands = new Map<string, Command>();
    load([], new Map(), commands);
    const asked: string[] = [];
    const ui = {
      confirm: async (title: string) => {
        asked.push(title);
        return false;
      },
      notify() {},
      setStatus() {},
    };
    const main = { ...ctx('main', 'main'), cwd: repo.root, hasUI: true, ui };

    await commands.get('factory')?.handler('submit', main);

    // It read the run from the original scratchDir to build the dialog, and created nothing under the moved one.
    assert.deepEqual(asked, ['Open draft PRs?']);
    assert.equal(existsSync(join(repo.root, '.moved')), false);
  });
});
