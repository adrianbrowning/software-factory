import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { pluginDigest, selfHostWarning, setLoadedPlugin } from '../src/self-host.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, sh, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

const FACTORY = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
const PLUGIN = JSON.stringify({ name: 'software-factory' });
const LOADED = resolve(import.meta.dirname, '..');
const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

type Reply = { content: { text: string }[] };

function session(root: string, hasUI = true, { commands = new Map<string, Command>(), confirm = true }: { commands?: Map<string, Command>; confirm?: boolean } = {}) {
  const tools = load({ commands });
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => confirm, notify() {} } };
  const call = async (name: string, params: unknown) => ((await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply).content[0]?.text ?? '';
  return { call, caller };
}

const warningsOf = (root: string, feature: string) => readRun({ config: loadConfig(root), root }, feature).events.filter(event => event.kind === 'warning');

describe('self-host warning', () => {
  it('factory_start in the plugin repo at another path warns with both paths and records a run event', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN });
    const text = await session(repo.root).call('factory_start', { feature: 'demo', source: SOURCE });
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
    const { call } = session(repo.root, false);
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
    assert.doesNotMatch(await session(other.root).call('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
    assert.equal(warningsOf(other.root, 'demo').length, 0);
    resetModuleState();
    assert.doesNotMatch(await session(bare.root).call('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
    assert.equal(warningsOf(bare.root, 'demo').length, 0);
  });

  it('selfHostWarning is silent when the repository is the loaded plugin and names both paths otherwise', () => {
    using repo = tempRepo('factory-selfhost-', { 'package.json': PLUGIN });
    assert.equal(selfHostWarning(repo.root, { digest: pluginDigest(repo.root), root: repo.root }), undefined);
    const warning = selfHostWarning(repo.root, { digest: 'x', root: '/elsewhere/plugin' }) ?? assert.fail('no warning');
    assert.ok(warning.includes(repo.root) && warning.includes('/elsewhere/plugin'));
  });

  describe('stale loaded plugin', () => {
    const write = (root: string, path: string, content: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const tree = () => tempRepo('factory-selfhost-', { 'agents/a.md': 'agent', 'package.json': PLUGIN, 'skills/s.md': 'skill', 'src/index.ts': 'one' });

    it('the digest changes when a file under src/ or agents/ is changed or added, and not for skills/', () => {
      using repo = tree();
      const before = pluginDigest(repo.root);
      assert.equal(pluginDigest(repo.root), before);
      write(repo.root, 'skills/s.md', 'edited skill');
      write(repo.root, 'README.md', 'docs');
      assert.equal(pluginDigest(repo.root), before);
      write(repo.root, 'src/index.ts', 'two');
      const edited = pluginDigest(repo.root);
      assert.notEqual(edited, before);
      write(repo.root, 'agents/b.md', 'new agent');
      assert.notEqual(pluginDigest(repo.root), edited);
    });

    it('warns that a new session is needed when src/ or agents/ changed since load', () => {
      using repo = tree();
      const loaded = { digest: pluginDigest(repo.root), root: repo.root };
      write(repo.root, 'src/new-gate.ts', 'export {}');
      const warning = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      assert.match(warning, /stale/);
      assert.match(warning, /new omp session/);
    });

    it('gives no warning when only skills/ changed or nothing changed', () => {
      using repo = tree();
      const loaded = { digest: pluginDigest(repo.root), root: repo.root };
      assert.equal(selfHostWarning(repo.root, loaded), undefined);
      write(repo.root, 'skills/s.md', 'edited skill');
      assert.equal(selfHostWarning(repo.root, loaded), undefined);
    });
  });
  it('a headless run records a start warning, and its resume and review warn without being refused or paused', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'ticket.md': '# Add the widget\n\nBuild it.\n' });
    const commands = new Map<string, Command>();
    const { call, caller } = session(repo.root, false, { commands, confirm: false });
    await commands.get('factory')?.handler('headless ticket.md', caller);
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'ticket').mode, 'headless');
    assert.equal(warningsOf(repo.root, 'ticket').length, 1);
    await withRun(ws, 'ticket', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'ticket', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await call('factory_checks', {});
    const resumed = await call('factory_start', { resume: 'ticket' });
    assert.ok(resumed.includes(repo.root) && resumed.includes(LOADED));
    const review = await call('factory_review_start', { skip: [] });
    assert.ok(review.includes(repo.root) && review.includes(LOADED));
    assert.equal(readRun(ws, 'ticket').status, 'running');
    assert.equal(warningsOf(repo.root, 'ticket').length, 3);
  });

  it('factory_start and factory_review_start in the loaded plugin checkout warn that the gates are stale once src/ changed, and record it', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
    setLoadedPlugin({ digest: pluginDigest(repo.root), root: repo.root });
    writeFileSync(join(repo.root, 'src/index.ts'), 'two');
    sh(repo.root, 'commit', '-qam', 'change a gate');
    const { call } = session(repo.root, false);
    const started = await call('factory_start', { feature: 'demo', source: SOURCE });
    assert.match(started, /\nWarning: .*stale.*new omp session/);
    assert.equal(warningsOf(repo.root, 'demo').length, 1);
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    assert.deepEqual(readRun(ws, 'demo').events.map(event => event.kind), ['start', 'warning']);
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok');
    await call('factory_checks', {});
    assert.match(await call('factory_review_start', { skip: [] }), /\nWarning: .*stale.*new omp session/);
    assert.equal(warningsOf(repo.root, 'demo').length, 2);
    assert.equal(readRun(ws, 'demo').status, 'running');
  });

  it('factory_start in the loaded plugin checkout gives no warning while src/ and agents/ are unchanged, even when skills/ changed', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'skills/s.md': 'one', 'src/index.ts': 'one' });
    setLoadedPlugin({ digest: pluginDigest(repo.root), root: repo.root });
    writeFileSync(join(repo.root, 'skills/s.md'), 'two');
    assert.doesNotMatch(await session(repo.root).call('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
    assert.equal(warningsOf(repo.root, 'demo').length, 0);
  });
});
