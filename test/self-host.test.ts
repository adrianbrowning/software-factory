import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { selfHostWarning } from '../src/self-host.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

const FACTORY = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
const PLUGIN = JSON.stringify({ name: 'software-factory' });
const LOADED = resolve(import.meta.dirname, '..');
const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

type Reply = { content: { text: string }[] };

function session(root: string, hasUI = true) {
  const tools = load();
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
  const call = async (name: string, params: unknown) => ((await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply).content[0]?.text ?? '';
  return call;
}

describe('self-host warning', () => {
  it('factory_start in the plugin repo at another path warns with both paths and records a run event', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN });
    const text = await session(repo.root)('factory_start', { feature: 'demo', source: SOURCE });
    assert.match(text, /Run \\?"demo\\?" is/);
    const warning = text.split('\n').find(line => line.startsWith('Warning:')) ?? assert.fail(`no warning in ${text}`);
    assert.ok(warning.includes(repo.root), 'names the run repository');
    assert.ok(warning.includes(LOADED), 'names the loaded plugin root');
    assert.match(warning, /gates, agents and references come from the loaded checkout/);
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'warning' && event.detail === warning.slice('Warning: '.length)));
  });

  it('resume and factory_review_start in the plugin repo warn the same way with no UI', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN });
    const call = session(repo.root, false);
    await call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await call('factory_checks', {});
    const resumed = await call('factory_start', { resume: 'demo' });
    assert.ok(resumed.includes(repo.root) && resumed.includes(LOADED));
    const review = await call('factory_review_start', { skip: [] });
    const warning = review.split('\n').find(line => line.startsWith('Warning:')) ?? assert.fail(`no warning in ${review}`);
    assert.ok(warning.includes(repo.root) && warning.includes(LOADED));
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'warning').length, 3);
  });

  it('gives no warning for another package name or no package.json', async () => {
    using other = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': JSON.stringify({ name: 'something-else' }) });
    using bare = tempRepo('factory-selfhost-', FACTORY);
    assert.doesNotMatch(await session(other.root)('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
    resetModuleState();
    assert.doesNotMatch(await session(bare.root)('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
  });

  it('selfHostWarning is silent when the repository is the loaded plugin and names both paths otherwise', () => {
    using repo = tempRepo('factory-selfhost-', { 'package.json': PLUGIN });
    assert.equal(selfHostWarning(repo.root, repo.root), undefined);
    const warning = selfHostWarning(repo.root, '/elsewhere/plugin') ?? assert.fail('no warning');
    assert.ok(warning.includes(repo.root) && warning.includes('/elsewhere/plugin'));
  });
  it('a headless run (started by /factory headless, no UI) is warned on start event, resume and review without being refused or paused', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'ticket.md': '# Add the widget\n\nBuild it.\n' });
    const commands = new Map<string, Command>();
    const tools = load({ commands });
    const caller = { ...ctx('main', 'main'), cwd: repo.root, hasUI: false, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => false, notify() {} } };
    const call = async (name: string, params: unknown) => ((await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply).content[0]?.text ?? '';
    await commands.get('factory')?.handler('headless ticket.md', caller);
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'ticket').mode, 'headless');
    assert.equal(readRun(ws, 'ticket').events.filter(event => event.kind === 'warning').length, 1);
    await withRun(ws, 'ticket', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'ticket', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await call('factory_checks', {});
    const resumed = await call('factory_start', { resume: 'ticket' });
    assert.ok(resumed.includes(repo.root) && resumed.includes(LOADED));
    const review = await call('factory_review_start', { skip: [] });
    assert.ok(review.includes(repo.root) && review.includes(LOADED));
    assert.equal(readRun(ws, 'ticket').status, 'running');
    assert.equal(readRun(ws, 'ticket').events.filter(event => event.kind === 'warning').length, 3);
  });
});
