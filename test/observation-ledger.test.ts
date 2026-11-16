import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { findingLocation, renderedObservation } from '../src/ledger.ts';
import { type Finding, forgetRun, type ObservationEntry, readRun, statePath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, renderFinding, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, review, slice, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

type Reply = { content: { text: string }[]; details?: { dataFile?: string } };
type Ui = { confirm?: (title: string, body: string) => Promise<boolean> };

/** The problem text of the thermo observation `name`: distinct per observation, so a ledger entry's problem is told apart from `finding`'s default. */
const problemOf = (name: string) => `${name} misleads the reader`;

/**
 * An interactive run of slices Feature and Second, with a file deferred sink, whose slice 01 is green with one thermo
 * observation per name in `names`. `dialogs` collects the title of every confirm dialog the tools ask, all answered yes.
 */
async function ledgerRun(root: string, names: string[], shape: (finding: Finding) => Finding = same => same) {
  const tools = load();
  const dialogs: string[] = [];
  const yes: Ui = { confirm: async title => (dialogs.push(title), true) };
  const call = async (name: string, params: unknown, ui: Ui = yes) => {
    const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {}, ...ui } };
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return (await tool.execute('id', params, undefined, undefined, caller)) as Reply;
  };
  await call('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } });
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature'), slice('Second', ['Feature'])])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, names.map(name => shape({ ...finding('thermo', 'observation', name), problem: problemOf(name) })));
  assert.equal((await withRun(ws, 'demo', run => recordReview(ws, run))).kind, 'green');
  return { call, dialogs, ws };
}

const repo = () =>
  tempRepo('factory-ledger-', { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], deferred: { kind: 'file' } }) });

const entry = (name: string, placement: ObservationEntry['placement'], to?: string) => ({
  id: `thermo-${name}`,
  key: `01-r1:thermo-${name}`,
  location: 'ok:1',
  placement,
  problem: problemOf(name),
  review: '01-r1',
  slice: '01',
  title: name,
  ...(to === undefined ? {} : { to }),
});

describe('observation ledger', () => {
  it('factory_carry, factory_defer, factory_leave and factory_fix each add a ledger entry with the review, observation, location, title, problem and placement', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'style', 'length', 'tidy', 'order']);
    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_carry', { observations: ['thermo-order'], to: 'end' });
    await call('factory_defer', { observations: ['thermo-style'] });
    await call('factory_leave', { observations: ['thermo-length'] });
    await call('factory_fix', { observations: ['thermo-tidy'], reason: 'tidy now' });

    const run = readRun(ws, 'demo');
    assert.deepEqual(run.observations, [entry('naming', 'carried', '02'), entry('order', 'carried', 'end'), entry('style', 'deferred'), entry('length', 'left'), entry('tidy', 'fixed')]);
    assert.equal('carriedObservations' in run, false, 'the ledger replaces the carried list');
    const status = JSON.parse((await call('factory_status', {})).content[0]?.text ?? '') as { observations: unknown };
    assert.deepEqual(status.observations, run.observations, 'factory_status shows the ledger');
  });

  it('refuses an observation the ledger holds in every placement tool, naming its placement, before any dialog', async () => {
    using dir = repo();
    const { call, dialogs, ws } = await ledgerRun(dir.root, ['naming', 'style', 'length']);
    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_defer', { observations: ['thermo-style'] });
    await call('factory_leave', { observations: ['thermo-length'] });
    const before = readRun(ws, 'demo');
    dialogs.length = 0;

    for (const [name, placement] of [['naming', 'carried'], ['style', 'deferred'], ['length', 'left']] as const) {
      const message = new RegExp(`Observations already ${placement}: thermo-${name}\\.`);
      await assert.rejects(call('factory_carry', { observations: [`thermo-${name}`], to: 'end' }), message);
      await assert.rejects(call('factory_defer', { observations: [`thermo-${name}`] }), message);
      await assert.rejects(call('factory_fix', { observations: [`thermo-${name}`], reason: 'tidy' }), message);
      await assert.rejects(call('factory_leave', { observations: [`thermo-${name}`] }), message);
    }
    assert.deepEqual(dialogs, [], 'a refusal asks nothing');
    assert.deepEqual(readRun(ws, 'demo'), before, 'a refusal changes nothing');
  });

  it('refuses an observation the ledger holds as fixed', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming']);
    await withRun(ws, 'demo', run => void run.observations.push(entry('naming', 'fixed')));
    await assert.rejects(call('factory_carry', { observations: ['thermo-naming'], to: 'end' }), /Observations already fixed: thermo-naming\./);
    await assert.rejects(call('factory_defer', { observations: ['thermo-naming'] }), /Observations already fixed: thermo-naming\./);
    await assert.rejects(call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' }), /Observations already fixed: thermo-naming\./);
    await assert.rejects(call('factory_leave', { observations: ['thermo-naming'] }), /Observations already fixed: thermo-naming\./);
  });

  it('factory_leave in an interactive run asks once and records nothing when the user declines', async () => {
    using dir = repo();
    const { call, dialogs, ws } = await ledgerRun(dir.root, ['naming', 'style']);
    const asked: string[] = [];
    const declined = await call('factory_leave', { observations: ['thermo-naming', 'thermo-style'] }, { confirm: async (title, body) => (asked.push(`${title}\n${body}`), false) });
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', /Leave 2 observations\?[\s\S]*thermo-naming: naming[\s\S]*thermo-style: style/);
    assert.match(declined.content[0]?.text ?? '', /The user did not leave/);
    assert.deepEqual(readRun(ws, 'demo').observations, []);

    const left = await call('factory_leave', { observations: ['thermo-naming', 'thermo-style'] });
    assert.equal(dialogs.length, 1);
    assert.match(left.content[0]?.text ?? '', /Left thermo-naming, thermo-style/);
    assert.deepEqual(readRun(ws, 'demo').observations, [entry('naming', 'left'), entry('style', 'left')]);
    assert.equal(readRun(ws, 'demo').slices[0]?.phase, 'ready', 'the slice keeps its green review');
  });

  it('factory_leave in a headless run records with no dialog', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming']);
    await withRun(ws, 'demo', run => void (run.mode = 'headless'));
    const noDialog = {
      confirm: async (title: string) => {
        throw new Error(`dialog: ${title}`);
      },
    };
    await call('factory_leave', { observations: ['thermo-naming'] }, noDialog);
    assert.deepEqual(readRun(ws, 'demo').observations, [entry('naming', 'left')]);
  });

  it('factory_leave refuses an empty list and an id the green review does not list', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming']);
    await assert.rejects(call('factory_leave', { observations: [] }));
    await assert.rejects(call('factory_leave', { observations: ['bug-made-up'] }), /Not observations of green review 01-r1: bug-made-up\. Its observations: thermo-naming/);
    assert.deepEqual(readRun(ws, 'demo').observations, []);
  });

  it('is active for the orchestrator when a run starts', async () => {
    using dir = repo();
    const activated: string[] = [];
    const caller = { ...ctx('main', 'main'), cwd: dir.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {} } };
    await load({ activated }).get('factory_start')?.execute('id', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, undefined, undefined, caller);
    assert.ok(activated.includes('factory_leave'));
  });

  it('lists the ledger entries in the KNOWN OBSERVATIONS section of every later review data file, and None for the first', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'style']);
    const first = readFileSync(`${ws.root}/.scratch/demo/reviews/01-r1/data.md`, 'utf8');
    assert.match(first, /## KNOWN OBSERVATIONS\n\n[^\n]*\n\nNone\.\n/);

    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_leave', { observations: ['thermo-style'] });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    assert.match(known, /- `01-r1:thermo-naming` \(carried\): ok:1 - naming\n {2}Problem: naming misleads the reader/);
    assert.match(known, /- `01-r1:thermo-style` \(left\): ok:1 - style\n {2}Problem: style misleads the reader/);
  });

  it('keeps the whole problem of a finding, with a credential redacted, and lists it on one line in the next data file', async () => {
    using dir = repo();
    const long = `${'x'.repeat(2_500)} end`;
    const { call, ws } = await ledgerRun(dir.root, ['naming'], same => ({ ...same, problem: `first line\nsecond token=hunter2secret ${long}` }));
    await call('factory_leave', { observations: ['thermo-naming'] });
    const [kept] = readRun(ws, 'demo').observations;
    assert.equal(kept?.problem, `first line\nsecond token=<REDACTED> ${long}`);

    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    assert.match(data, /\n {2}Problem: first line second token=<REDACTED> x{100}/);
    assert.doesNotMatch(data, /hunter2secret/);
    const problemLine = /\n {2}Problem: ([^\n]*)\n/.exec(data)?.[1] ?? assert.fail('no Problem line');
    assert.equal(problemLine.length, 2_000 + '…'.length, 'the data file cuts the problem at 2000 characters and marks the cut');
    assert.ok(problemLine.endsWith('…'));
    assert.doesNotMatch(problemLine, / end$/, 'the tail of the problem is not in the data file');
    assert.ok(kept?.problem.endsWith(' end'), 'the state still holds the whole problem');
  });

  describe('a run saved before the ledger', () => {
    it('reads back the location, title and problem that renderFinding wrote', () => {
      const observation = { ...finding('thermo', 'observation', 'naming'), line: 12, path: 'src/a.ts', problem: 'The name\nmisleads the reader.', title: 'Misleading name' };
      for (const heading of ['##', '###', '####']) {
        assert.deepEqual(renderedObservation(renderFinding(observation, [], heading), 'thermo-naming'), { location: findingLocation(observation), problem: observation.problem, title: observation.title });
      }
      assert.equal(renderedObservation(renderFinding(observation, []), 'thermo-other'), undefined);
    });

    /** Saves the state of `ws` as a file from before the ledger wrote it: no `observations`, the carried keys in `carriedObservations`, and `edit` applied. */
    function saveAsLegacy(ws: Workspace, carried: string[], edit: (state: Record<string, unknown>) => void = () => {}) {
      forgetRun(ws, 'demo');
      const state = JSON.parse(readFileSync(statePath(ws, 'demo'), 'utf8')) as Record<string, unknown>;
      delete state.observations;
      state.carriedObservations = carried;
      edit(state);
      writeFileSync(statePath(ws, 'demo'), JSON.stringify(state));
    }

    it('reads each carried and deferred observation as a ledger entry with the text of the finding its carried-in section or deferred item rendered', async () => {
      using dir = repo();
      const { call, ws } = await ledgerRun(dir.root, ['naming', 'style', 'length', 'order']);
      await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
      await call('factory_carry', { observations: ['thermo-length'], to: 'end' });
      await call('factory_defer', { observations: ['thermo-style'] });
      const expected = readRun(ws, 'demo').observations;
      assert.deepEqual(expected.map(item => item.placement), ['carried', 'carried', 'deferred']);

      saveAsLegacy(ws, ['01-r1:thermo-naming', '01-r1:thermo-length', '01-r1:thermo-naming']);
      assert.deepEqual(readRun(ws, 'demo').observations, expected);

      await call('factory_leave', { observations: ['thermo-order'] });
      const saved = JSON.parse(readFileSync(statePath(ws, 'demo'), 'utf8')) as Record<string, unknown>;
      assert.equal('carriedObservations' in saved, false);
      assert.deepEqual(readRun(ws, 'demo').observations, [...expected, entry('order', 'left')]);
    });

    it('loads a state whose carried key has no single carried-in section, giving the entry placeholder text, and keeps a key both carried and deferred as one carried entry', async () => {
      using dir = repo();
      const { call, ws } = await ledgerRun(dir.root, ['naming']);
      await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
      const placeholder = { location: 'unknown', problem: 'Recorded before the run kept the text of handled observations.' };

      saveAsLegacy(ws, ['09-r1:thermo-gone', 'no-colon']);
      const observed = readRun(ws, 'demo').observations;
      assert.deepEqual(observed.map(({ key, location, placement, problem }) => ({ key, location, placement, problem })), [
        { ...placeholder, key: '09-r1:thermo-gone', placement: 'carried' },
        { ...placeholder, key: 'no-colon', placement: 'carried' },
      ], 'a key no section holds, and a malformed key');

      saveAsLegacy(ws, ['01-r1:thermo-naming'], state => {
        const second = (state.slices as { carried: string[] }[])[1] ?? assert.fail('no slice 02');
        second.carried.push(second.carried[0] ?? assert.fail('nothing carried'));
      });
      assert.deepEqual(readRun(ws, 'demo').observations, [{ ...placeholder, id: 'thermo-naming', key: '01-r1:thermo-naming', placement: 'carried', review: '01-r1', slice: '01', title: 'thermo-naming' }], 'a key two sections hold');
      await assert.rejects(call('factory_leave', { observations: ['thermo-naming'] }), /Observations already carried: thermo-naming\./);

      saveAsLegacy(ws, ['01-r1:thermo-naming'], state => {
        const second = (state.slices as { carried: string[] }[])[1] ?? assert.fail('no slice 02');
        const carried = second.carried[0] ?? assert.fail('nothing carried');
        second.carried = [carried];
        state.deferred = [{ body: carried, id: 'thermo-naming', key: '01-r1:thermo-naming', kind: 'observation', location: 'docs/factory-deferred.md', review: '01-r1', slice: '01', title: 'naming' }];
      });
      assert.deepEqual(readRun(ws, 'demo').observations, [entry('naming', 'carried', '02')], 'one carried entry with the text read');

      saveAsLegacy(ws, [], state => {
        state.deferred = [{ body: 'no rendered finding', id: 'thermo-naming', key: '01-r1:thermo-naming', kind: 'observation', location: 'docs/factory-deferred.md', review: '01-r1', slice: '01', title: 'naming' }];
      });
      assert.deepEqual(readRun(ws, 'demo').observations, [{ ...placeholder, id: 'thermo-naming', key: '01-r1:thermo-naming', placement: 'deferred', review: '01-r1', slice: '01', title: 'thermo-naming' }], 'a deferred body with no finding');
    });
  });
});
