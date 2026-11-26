import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { pluginHashes, recordSelfHostWarning, selfHostWarning, setLoadedPlugin } from '../src/self-host.ts';
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
    const events = readRun(ws, 'demo').events;
    assert.ok(events.find(event => event.kind === 'warning' && event.detail === warning.slice('Warning: '.length)), `no matching warning event in ${JSON.stringify(events)}`);
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
    assert.doesNotMatch(resumed, /Warning:/);
    const review = await call('factory_review_start', { skip: [] });
    assert.doesNotMatch(review, /Warning:/);
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'warning').length, 1);
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
    assert.equal(selfHostWarning(repo.root, { hashes: pluginHashes(repo.root), root: repo.root }), undefined);
    const warning = selfHostWarning(repo.root, { hashes: {}, root: '/elsewhere/plugin' }) ?? assert.fail('no warning');
    assert.ok(warning.includes(repo.root) && warning.includes('/elsewhere/plugin'));
  });

  describe('stale loaded plugin', () => {
    const write = (root: string, path: string, content: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const tree = () => tempRepo('factory-selfhost-', { 'agents/a.md': 'agent', 'package.json': PLUGIN, 'skills/s.md': 'skill', 'src/index.ts': 'one' });

    it('the hashes change per file when a file under src/ or agents/ is changed or added, and not for skills/', () => {
      using repo = tree();
      const before = pluginHashes(repo.root);
      assert.deepEqual(pluginHashes(repo.root), before);
      write(repo.root, 'skills/s.md', 'edited skill');
      write(repo.root, 'README.md', 'docs');
      assert.deepEqual(pluginHashes(repo.root), before);
      write(repo.root, 'src/index.ts', 'two');
      write(repo.root, 'agents/b.md', 'new agent');
      const after = pluginHashes(repo.root);
      assert.deepEqual(Object.keys(after).sort(), ['agents/a.md', 'agents/b.md', 'src/index.ts']);
      assert.notEqual(after['src/index.ts'], before['src/index.ts']);
      assert.equal(after['agents/a.md'], before['agents/a.md']);
    });

    const changes: [string, string, string][] = [['an added src/ file', 'src/new-gate.ts', 'export {}'], ['an edited agents/ file', 'agents/a.md', 'edited agent'], ['an added agents/ file', 'agents/b.md', 'new agent']];
    for (const [name, path, content] of changes) {
      it(`warns that a new session is needed when ${name} changed since load`, () => {
        using repo = tree();
        const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
        write(repo.root, path, content);
        const warning = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
        assert.match(warning, /and these src\/ or agents\/ files are stale: loaded copy differs from the file on disk: /);
        assert.doesNotMatch(warning, /outside the run's own commits|The loaded gates are stale/);
        assert.match(warning, new RegExp(path.replace('.', '\\.')));
        assert.match(warning, /new omp session/);
        assert.match(warning, /headless run goes on with the loaded gates/);
      });
    }

    it('gives no warning when only skills/ changed or nothing changed', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      assert.equal(selfHostWarning(repo.root, loaded), undefined);
      write(repo.root, 'skills/s.md', 'edited skill');
      assert.equal(selfHostWarning(repo.root, loaded), undefined);
    });

    it('gives no warning for a file the run renamed, old and new path alike', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      sh(repo.root, 'mv', 'src/index.ts', 'src/renamed.ts');
      sh(repo.root, 'commit', '-qm', 'rename');
      assert.equal(selfHostWarning(repo.root, loaded, base), undefined);
    });

    it('leads a base-clause warning without claiming the files are outside the run commits', () => {
      using repo = tree();
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/index.ts', 'two');
      sh(repo.root, 'commit', '-qam', 'edit');
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      const warning = selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning');
      assert.match(warning, /files are stale: loaded copy differs from the run base [0-9a-f]{7}: src\/index\.ts\. An interactive/);
      assert.doesNotMatch(warning, /outside the run's own commits|The loaded gates are stale/);
    });

    it('gives no warning for a committed rename of a non-ASCII src/ file', () => {
      using repo = tempRepo('factory-selfhost-', { 'package.json': PLUGIN, 'src/café.ts': 'one' });
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      sh(repo.root, 'mv', 'src/café.ts', 'src/ünï.ts');
      sh(repo.root, 'commit', '-qm', 'rename');
      assert.equal(selfHostWarning(repo.root, loaded, base), undefined);
    });

    it('warns for a file the run edited when the loaded content differs from the run base', () => {
      using repo = tree();
      write(repo.root, 'src/x.ts', 'A');
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      write(repo.root, 'src/x.ts', 'B');
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/x.ts', 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      assert.match(selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning'), /src\/x\.ts/);
    });

    it('gives no warning for a file the run edited when the loaded content equals the run base', () => {
      using repo = tree();
      write(repo.root, 'src/x.ts', 'A');
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/x.ts', 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      assert.equal(selfHostWarning(repo.root, loaded, base), undefined);
    });

    it('warns for a file absent when loaded, added at the run base and edited by the run', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      write(repo.root, 'src/x.ts', 'B');
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/x.ts', 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      assert.match(selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning'), /src\/x\.ts/);
    });

    it('warns for a run-edited file whose content at the run base exceeds 1 MiB', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      write(repo.root, 'src/big.ts', 'x'.repeat(2 * 1024 * 1024));
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/big.ts', 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      assert.match(selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning'), /src\/big\.ts/);
    });

    it('gives a different warning text when only a file beyond the listed ones differs', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) write(repo.root, `src/${name}.ts`, name);
      write(repo.root, 'src/g.ts', 'g');
      const first = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      rmSync(join(repo.root, 'src/g.ts'));
      write(repo.root, 'src/h.ts', 'h');
      const second = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      assert.notEqual(first, second);
    });

    it('labels the file-set id only when the listed files are truncated', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      for (const name of ['a', 'b', 'c', 'd', 'e']) write(repo.root, `src/${name}.ts`, name);
      assert.doesNotMatch(selfHostWarning(repo.root, loaded) ?? assert.fail('no warning'), /file-set id/);
      for (const name of ['f', 'g']) write(repo.root, `src/${name}.ts`, name);
      const text = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      assert.match(text, /and 2 more \(file-set id [0-9a-f]{7}\)/);
      assert.doesNotMatch(text, /\(set /);
    });

    it('names a src/ file removed since load', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      rmSync(join(repo.root, 'src/index.ts'));
      assert.match(selfHostWarning(repo.root, loaded) ?? assert.fail('no warning'), /src\/index\.ts/);
    });

    it('still names the differing file when the base does not resolve', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/index.ts', 'two');
      sh(repo.root, 'commit', '-qam', 'slice');
      assert.equal(selfHostWarning(repo.root, loaded, base), undefined);
      assert.match(selfHostWarning(repo.root, loaded, 'no-such-ref') ?? assert.fail('no warning'), /src\/index\.ts/);
    });

    it('names which comparison failed per file: run base for committed files, disk for the rest', () => {
      using repo = tree();
      write(repo.root, 'src/x.ts', 'A');
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      write(repo.root, 'src/x.ts', 'B');
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      write(repo.root, 'src/x.ts', 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      const only = selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning');
      assert.ok(only.includes(`loaded copy differs from the run base ${base.slice(0, 7)}: src/x.ts`));
      assert.doesNotMatch(only, /differs from the file on disk/);
      write(repo.root, 'src/index.ts', 'two');
      const both = selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning');
      assert.match(both, /differs from the run base [0-9a-f]{7}: src\/x\.ts[.;]/);
      assert.match(both, /differs from the file on disk: src\/index\.ts/);
      assert.doesNotMatch(both, /run base [0-9a-f]{7}: [^;.]*src\/index\.ts/);
      const disk = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      assert.doesNotMatch(disk, /run base/);
      assert.match(disk, /differs from the file on disk: src\/index\.ts, src\/x\.ts/);
      const unresolved = selfHostWarning(repo.root, loaded, 'no-such-ref') ?? assert.fail('no warning');
      assert.equal(unresolved, `This run's repository ${repo.root} is the loaded software-factory plugin, and these src/ or agents/ files are stale: loaded copy differs from the file on disk: src/index.ts, src/x.ts. The run base did not resolve, so every file was compared with the file on disk. An interactive run can start a new omp session to load them; a headless run goes on with the loaded gates and needs no action.`);
      assert.doesNotMatch(unresolved, /\.;/);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) write(repo.root, `src/${name}.ts`, name);
      assert.match(selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning'), /differs from the file on disk: .* and 2 more \(file-set id [0-9a-f]{7}\)/);
    });

    it('truncates the run-base clause beyond five files and each clause lists only its own files', () => {
      using repo = tree();
      const names = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const name of names) write(repo.root, `src/${name}.ts`, 'A');
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      for (const name of names) write(repo.root, `src/${name}.ts`, 'B');
      sh(repo.root, 'add', '-A');
      sh(repo.root, 'commit', '-qm', 'base');
      const base = sh(repo.root, 'rev-parse', 'HEAD');
      for (const name of names) write(repo.root, `src/${name}.ts`, 'C');
      sh(repo.root, 'commit', '-qam', 'slice');
      const short = base.slice(0, 7);
      const baseOnly = selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning');
      assert.match(baseOnly, new RegExp(`differs from the run base ${short}: src/a\\.ts, src/b\\.ts, src/c\\.ts, src/d\\.ts, src/e\\.ts and 1 more \\(file-set id [0-9a-f]{7}\\)\\. An interactive`));
      assert.doesNotMatch(baseOnly, /src\/f\.ts|file on disk/);
      for (const name of ['g', 'h', 'i', 'j', 'k', 'l', 'm']) write(repo.root, `src/${name}.ts`, name);
      const both = selfHostWarning(repo.root, loaded, base) ?? assert.fail('no warning');
      const baseClause = /differs from the run base [0-9a-f]{7}: ([^;]*?); loaded copy/.exec(both)?.[1] ?? assert.fail('no base clause');
      const diskClause = /differs from the file on disk: (.*?)\. An interactive/.exec(both)?.[1] ?? assert.fail('no disk clause');
      assert.match(baseClause, /^src\/a\.ts, .*src\/e\.ts and 1 more \(file-set id [0-9a-f]{7}\)$/);
      assert.match(diskClause, /^src\/g\.ts, src\/h\.ts, src\/i\.ts, src\/j\.ts, src\/k\.ts and 2 more \(file-set id [0-9a-f]{7}\)$/);
      assert.doesNotMatch(baseClause, /src\/[g-m]\.ts/);
      assert.doesNotMatch(diskClause, /src\/[a-f]\.ts/);
    });

    it('treats a base starting with "-" as unresolved: git writes no file and the on-disk comparison applies', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      write(repo.root, 'src/index.ts', 'two');
      assert.match(selfHostWarning(repo.root, loaded, '--output=x') ?? assert.fail('no warning'), /src\/index\.ts/);
      assert.equal(existsSync(join(repo.root, 'x..HEAD')), false);
      assert.equal(existsSync(join(repo.root, 'x')), false);
    });

    it('says "and 2 more" when seven files changed', () => {
      using repo = tree();
      const loaded = { hashes: pluginHashes(repo.root), root: repo.root };
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) write(repo.root, `src/${name}.ts`, name);
      write(repo.root, 'src/index.ts', 'two');
      const text = selfHostWarning(repo.root, loaded) ?? assert.fail('no warning');
      assert.match(text, /and 2 more/);
      assert.ok(text.includes('src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts and 2 more'));
      assert.doesNotMatch(text, /src\/f\.ts|src\/index\.ts/);
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
    assert.doesNotMatch(resumed, /Warning:/);
    const review = await call('factory_review_start', { skip: [] });
    assert.doesNotMatch(review, /Warning:/);
    assert.equal(readRun(ws, 'ticket').status, 'running');
    assert.equal(warningsOf(repo.root, 'ticket').length, 1);
  });

  it('factory_start and factory_review_start in the loaded plugin checkout warn that the gates are stale once src/ changed, and record it', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
    setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
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
    assert.doesNotMatch(await call('factory_review_start', { skip: [] }), /Warning:/);
    assert.equal(warningsOf(repo.root, 'demo').length, 1);
    writeFileSync(join(repo.root, 'src/new.ts'), 'x');
    setLoadedPlugin({ hashes: { ...pluginHashes(repo.root), 'src/new.ts': 'old' }, root: repo.root });
    assert.match(await call('factory_start', { resume: 'demo' }), /\nWarning: .*loaded copy differs from the file on disk: src\/new\.ts/);
    assert.equal(warningsOf(repo.root, 'demo').length, 2);
    assert.doesNotMatch(await call('factory_start', { resume: 'demo' }), /Warning:/);
    assert.equal(warningsOf(repo.root, 'demo').length, 2);
    assert.equal(readRun(ws, 'demo').status, 'running');
  });

  it('factory_start in the loaded plugin checkout gives no warning while src/ and agents/ are unchanged, even when skills/ changed', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'skills/s.md': 'one', 'src/index.ts': 'one' });
    setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
    writeFileSync(join(repo.root, 'skills/s.md'), 'two');
    assert.doesNotMatch(await session(repo.root).call('factory_start', { feature: 'demo', source: SOURCE }), /Warning:/);
    assert.equal(warningsOf(repo.root, 'demo').length, 0);
  });

  it('factory_review_start gives no stale warning for src/ the slice commits changed, but names an uncommitted edit to another file', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one', '.gitignore': 'src/other.ts\n' });
    writeFileSync(join(repo.root, 'src/other.ts'), 'one'); // git-ignored but on disk at load, so the later write is an edit
    setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
    const { call } = session(repo.root, false);
    await call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    writeFileSync(join(repo.root, 'src/index.ts'), 'two');
    sh(repo.root, 'commit', '-qam', 'change a gate');
    commit(ws, 'ok');
    await call('factory_checks', {});
    assert.doesNotMatch(await call('factory_review_start', { skip: [] }), /Warning:/);
    writeFileSync(join(repo.root, 'src/other.ts'), 'edited'); // git-ignored, so the dirty-tree refusal does not block the review start
    const reply = await call('factory_review_start', { skip: [] });
    assert.match(reply, /Warning:.*loaded copy differs from the file on disk: src\/other\.ts/);
    assert.doesNotMatch(reply, /src\/index\.ts/);
  });

  it('factory_review_start names the run base sha for a run-committed file whose loaded copy differs from the base', async () => {
    using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
    setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
    writeFileSync(join(repo.root, 'src/index.ts'), 'two');
    sh(repo.root, 'commit', '-qam', 'edit before the run');
    const { call } = session(repo.root, false);
    await call('factory_start', { feature: 'demo', source: SOURCE });
    const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
    await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    const baseSha = sh(repo.root, 'rev-parse', 'HEAD');
    writeFileSync(join(repo.root, 'src/index.ts'), 'three');
    sh(repo.root, 'commit', '-qam', 'slice edits a gate');
    commit(ws, 'ok');
    await call('factory_checks', {});
    const reply = await call('factory_review_start', { skip: [] });
    assert.ok(reply.includes(`loaded copy differs from the run base ${baseSha.slice(0, 7)}: src/index.ts`), reply);
  });

  describe('slices not done yet', () => {
    const SENTENCE = ' Slices not done yet, which run with these loaded gates:';

    async function planned(root: string, titles: string[]) {
      const { call } = session(root, false);
      await call('factory_start', { feature: 'demo', source: SOURCE });
      const ws: Workspace = { config: loadConfig(root), root };
      await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, titles.map(title => slice(title)))));
      return { call, ws };
    }

    it('factory_start resume names the pending slices and not the done one, in the reply and the event', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
      setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
      const { call, ws } = await planned(repo.root, ['Alpha', 'Beta', 'Gamma']);
      await withRun(ws, 'demo', run => { run.slices[0]!.status = 'done'; });
      writeFileSync(join(repo.root, 'src/new.ts'), 'x');
      const reply = await call('factory_start', { resume: 'demo' });
      const line = reply.split('\n').find(l => l.startsWith('Warning:')) ?? assert.fail(reply);
      const ending = `${SENTENCE} 02 "Beta", 03 "Gamma".`;
      assert.ok(line.endsWith(ending), line);
      assert.doesNotMatch(line, /01 "Alpha"/);
      assert.equal(warningsOf(repo.root, 'demo').at(-1)?.detail, line.slice('Warning: '.length));
    });

    it('names the active slice at factory_review_start', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, '.gitignore': 'src/fresh.ts\n', 'src/index.ts': 'one' });
      writeFileSync(join(repo.root, 'src/fresh.ts'), 'one');
      setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
      const { call, ws } = await planned(repo.root, ['Alpha']);
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      commit(ws, 'ok');
      await call('factory_checks', {});
      writeFileSync(join(repo.root, 'src/fresh.ts'), 'edited');
      const reply = await call('factory_review_start', { skip: [] });
      assert.match(reply, /\nWarning: .*src\/fresh\.ts.* Slices not done yet, which run with these loaded gates: 01 "Alpha"\.$/m);
    });

    it('appends no sentence when no slice is active or pending', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
      setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
      writeFileSync(join(repo.root, 'src/new.ts'), 'x');
      const reply = await session(repo.root, false).call('factory_start', { feature: 'demo', source: SOURCE });
      const line = reply.split('\n').find(l => l.startsWith('Warning:')) ?? assert.fail(reply);
      assert.doesNotMatch(line, /Slices not done yet/);
      assert.ok(line.endsWith('headless run goes on with the loaded gates and needs no action.'), line);
    });

    it('follows the other-checkout form of the warning', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN });
      const { ws } = await planned(repo.root, ['Alpha']);
      const detail = warningsOf(repo.root, 'demo').at(-1)?.detail ?? assert.fail('no warning');
      assert.match(detail, /omp loaded the plugin from/);
      assert.ok(detail.endsWith(`${SENTENCE} 01 "Alpha".`) === false, 'recorded before the plan');
      const run = readRun(ws, 'demo');
      run.events = [];
      assert.ok(recordSelfHostWarning(run, repo.root).endsWith(`${SENTENCE} 01 "Alpha".`));
    });

    it('de-duplicates on the warning text alone, whatever slices the earlier event named', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
      setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
      const { call, ws } = await planned(repo.root, ['Alpha', 'Beta']);
      writeFileSync(join(repo.root, 'src/new.ts'), 'x');
      assert.match(await call('factory_start', { resume: 'demo' }), /01 "Alpha", 02 "Beta"\./);
      await withRun(ws, 'demo', run => { run.slices[0]!.status = 'done'; });
      assert.doesNotMatch(await call('factory_start', { resume: 'demo' }), /Warning:/);
      assert.equal(warningsOf(repo.root, 'demo').length, 1);
    });

    it('records one slice-bearing warning after a pre-plan warning held no slice sentence', async () => {
      using repo = tempRepo('factory-selfhost-', { ...FACTORY, 'package.json': PLUGIN, 'src/index.ts': 'one' });
      setLoadedPlugin({ hashes: pluginHashes(repo.root), root: repo.root });
      writeFileSync(join(repo.root, 'src/new.ts'), 'x');
      const { call } = session(repo.root, false);
      const ws: Workspace = { config: loadConfig(repo.root), root: repo.root };
      await call('factory_start', { feature: 'demo', source: SOURCE });
      assert.equal(warningsOf(repo.root, 'demo').length, 1);
      await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Alpha')])));
      assert.match(await call('factory_start', { resume: 'demo' }), /\nWarning: .*Slices not done yet, which run with these loaded gates: 01 "Alpha"\.$/m);
      assert.equal(warningsOf(repo.root, 'demo').length, 2);
      assert.doesNotMatch(await call('factory_start', { resume: 'demo' }), /Warning:/);
      assert.equal(warningsOf(repo.root, 'demo').length, 2);
    });
  });
});
