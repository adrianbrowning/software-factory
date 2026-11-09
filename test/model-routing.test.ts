import './git-env.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import type * as agents from '../src/agents.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, statePath, type Workspace, withRun } from '../src/run.ts';
import { runChecks } from '../src/review.ts';
import { approvePlan, nextAction, nextSlice, planSlices } from '../src/workflow.ts';
import { type Command, ctx, type Handler, load, type TestContext } from './extension.ts';
import { commit, slice, tempRepo } from './helpers.ts';

describe('model routing', () => {
  beforeEach(() => resetModuleState());

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
    const notes: string[] = [];
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
      ui: {
        confirm: async () => true,
        notify(message: string) {
          notes.push(message);
        },
      },
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
    return { ...repo, available, call, child, command, live, notes, spawn, statusModels, stop };
  }

  /** A directory outside any git repo, removed when `using` ends. */
  function outsideGit() {
    const path = mkdtempSync(join(tmpdir(), 'factory-nogit-'));
    return { path, [Symbol.dispose]: () => rmSync(path, { force: true, recursive: true }) };
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

  it('does not route or block factory-role and scout spawns in a repo with no run while another repo has one, which keeps routing', async () => {
    const models = { explorer: { model: 'x/e' }, reviewer: { model: 'x/r' } };
    using other = routedRepo(models);
    for (const spec of ['x/e', 'x/r']) other.available.add(spec);
    await other.call('factory_start', { feature: 'demo', source: SOURCE });
    using repo = routedRepo(models);
    for (const spec of ['x/e', 'x/r']) repo.available.add(spec);
    assert.equal(await repo.spawn('scout'), undefined);
    assert.equal(await repo.spawn('factory-reviewer'), undefined);
    assert.deepEqual(await other.spawn('scout'), { model: ['x/e'], note: 'Software factory: models.explorer from the run snapshot.' });
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
    using outside = outsideGit();
    assert.equal(await repo.spawn('scout', outside.path), undefined);
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

  it('records nothing, without throwing, for a scout turn outside any factory run', async () => {
    using repo = routedRepo(undefined);
    writeFileSync(join(repo.root, '.omp/factory.json'), '{not json');
    await repo.child('scout', 'x/e', 'low').turn();
  });

  it('records nothing, without throwing, for a scout turn outside any git repo while a run is active', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    using outside = outsideGit();
    await repo.child('scout', 'x/e', 'low', undefined, outside.path).turn();
    assert.deepEqual(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').agents, []);
  });

  it("records a child session that runs no model as model 'unset'", async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    await repo.child('scout', undefined, 'low').turn();
    assert.deepEqual(
      readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').agents.map(agent => [agent.model, agent.thinking]),
      [['unset', 'low']],
    );
  });

  it('records a child on a later turn once when its first audit write fails, and still tracks the implementer on the failed turn', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    const path = statePath(ws, 'demo');
    const saved = readFileSync(path, 'utf8');
    const implementer = repo.child('factory-implementer', 'x/i', 'medium');
    writeFileSync(path, '{not json');
    await assert.rejects(Promise.resolve(implementer.turn()), /changed outside the factory tools/);
    assert.equal(implementer.usage.reads, 1);
    writeFileSync(path, saved);
    await implementer.turn();
    await implementer.turn();
    assert.deepEqual(
      readRun(ws, 'demo').agents.map(agent => agent.sessionId),
      [`child-session-1@${repo.root}`],
    );
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

  it('finds the run through the workspace it started with for implementer tracking, session_stop and /factory status and pause, after a factory.json edit', async () => {
    using repo = routedRepo(undefined);
    await repo.call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    writeFileSync(join(repo.root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], scratchDir: 'elsewhere' }));
    const implementer = repo.child('factory-implementer', 'x/i', 'medium');
    implementer.usage.tokens = 1234;
    await implementer.turn();
    assert.equal(readRun(ws, 'demo').slices[0]?.peakContextTokens, 1234);
    assert.deepEqual(await repo.stop(), { decision: 'block', reason: `Software factory run "demo" is not finished. Next: ${nextAction(readRun(ws, 'demo'))}` });
    await repo.command('status');
    assert.match(repo.notes.at(-1) ?? '', /Active run: demo: .*\nRuns: demo$/);
    writeFileSync(join(repo.root, '.omp/factory.json'), '{not json');
    await repo.command('pause');
    assert.equal(readRun(ws, 'demo').status, 'paused');
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
