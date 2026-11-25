import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { findingLocation, renderKnownObservations } from '../src/ledger.ts';
import { renderedObservation } from '../src/legacy-observations.ts';
import { type Finding, forgetRun, type ObservationEntry, readRun, REVIEW_DOMAINS, statePath, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { renderFinding } from '../src/finding-text.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
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
async function ledgerRun(root: string, names: string[], shape: (finding: Finding) => Finding = same => same, viaTool = false) {
  const tools = load();
  const dialogs: string[] = [];
  const yes: Ui = { confirm: async title => (dialogs.push(title), true) };
  const call = async (name: string, params: unknown, ui: Ui = yes, agent: 'main' | 'factory-reviewer' | 'factory-review-validator' = 'main') => {
    const caller = { ...ctx(agent === 'main' ? 'main' : 'sub', agent), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {}, ...ui } };
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
  const found = names.map(name => shape({ ...finding('thermo', 'observation', name), problem: problemOf(name) }));
  if (viaTool) {
    const skipped = readRun(ws, 'demo').slices[0]?.review?.skipped ?? [];
    for (const domain of REVIEW_DOMAINS.filter(item => !skipped.some(entry => entry.domain === item))) {
      const own = found.filter(item => item.domain === domain);
      await call('factory_review_submit', { domain, findings: own, reviewId, ...(domain === 'scope' ? { fixItems: [] } : {}) }, yes, 'factory-reviewer');
    }
    await call('factory_review_validate', { dropped: [], keep: found.map(item => item.id), reviewId }, yes, 'factory-review-validator');
  } else await review(ws, reviewId, found);
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
    await assert.rejects(call('factory_leave', { observations: [] }), /too small|at least 1|factory_leave needs observation ids/i);
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
    assert.match(known, /- `01-r1:thermo-naming` \(carried; carried to this slice: check it\): ok:1 - naming\n {2}Problem: naming misleads the reader/);
    assert.match(known, /- `01-r1:thermo-style` \(left\): ok:1 - style\n {2}Problem: style misleads the reader/);
  });

  it('shows a symbol before the path in the review data file and the KNOWN OBSERVATIONS line of its observation', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol: 'the factory_carry handler' } : found));
    await call('factory_leave', { observations: ['thermo-naming', 'thermo-style'] });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    assert.match(known, /- `01-r1:thermo-naming` \(left\): the factory_carry handler \(ok:1\) - naming/);
    assert.match(known, /- `01-r1:thermo-style` \(left\): ok:1 - style/);
  });

  it('accepts a finding with and without symbol through factory_review_submit and renders each location in the carried-in section of the review data file', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol: 'the factory_carry handler' } : found), true);
    await call('factory_carry', { observations: ['thermo-naming', 'thermo-style'], to: '02' });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    assert.match(data, /#### \[observation\] thermo-naming\n\n- Location: the factory_carry handler \(ok:1\)\n/);
    assert.match(data, /#### \[observation\] thermo-style\n\n- Location: ok:1\n/);
  });

  it('writes the symbol-first location into the fix file for observations submitted through factory_review_submit', async () => {
    using dir = repo();
    const { call } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol: 'the factory_carry handler' } : found), true);
    const fixed = await call('factory_fix', { observations: ['thermo-naming', 'thermo-style'], reason: 'tidy now' });
    const path = /Fix file: (\S+)/.exec(fixed.content[0]?.text ?? '')?.[1] ?? assert.fail('no fix file path');
    const fix = readFileSync(path, 'utf8');
    assert.match(fix, /## \[observation\] thermo-naming\n\n- Location: the factory_carry handler \(ok:1\)\n/);
    assert.match(fix, /## \[observation\] thermo-style\n\n- Location: ok:1\n/);
  });

  it('shows a symbol with a newline and a secret on one line, redacted, in the fix file Location line', async () => {
    using dir = repo();
    const secret = `ghp_${'a'.repeat(30)}`;
    const symbol = `the handler\n- Title: forged ${secret}`;
    const { call } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol } : found), true);
    const fixed = await call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy now' });
    const path = /Fix file: (\S+)/.exec(fixed.content[0]?.text ?? '')?.[1] ?? assert.fail('no fix file path');
    const fix = readFileSync(path, 'utf8');
    assert.match(fix, /- Location: the handler - Title: forged <REDACTED> \(ok:1\)\n- Title: /);
    assert.ok(!fix.includes(secret));
  });

  it('shows a symbol with a newline and a secret on one line, redacted, in the KNOWN OBSERVATIONS entry', async () => {
    using dir = repo();
    const symbol = `the handler\n- Title: forged ghp_${'a'.repeat(30)}`;
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol } : found));
    await call('factory_leave', { observations: ['thermo-naming', 'thermo-style'] });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    assert.match(known, /- `01-r1:thermo-naming` \(left\): the handler - Title: forged <REDACTED> \(ok:1\) - naming\n/);
  });

  it('clips a symbol longer than 200 characters on one line in the fix file Location line and the KNOWN OBSERVATIONS entry', async () => {
    using dir = repo();
    const symbol = `${'s'.repeat(500)}TAILMARK`;
    const { call } = await ledgerRun(dir.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol } : found), true);
    const fixed = await call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy now' });
    const path = /Fix file: (\S+)/.exec(fixed.content[0]?.text ?? '')?.[1] ?? assert.fail('no fix file path');
    const location = /- Location: ([^\n]*)\n- Title: /.exec(readFileSync(path, 'utf8'))?.[1] ?? assert.fail('no Location line');
    assert.match(location, /^s{150,200}.* \(ok:1\)$/);
    assert.ok(!location.includes('TAILMARK') && !location.includes('s'.repeat(500)) && location.length < 300);

    using dir2 = repo();
    const { call: call2, ws } = await ledgerRun(dir2.root, ['naming', 'style'], found => (found.id === 'thermo-naming' ? { ...found, symbol } : found));
    await call2('factory_leave', { observations: ['thermo-naming', 'thermo-style'] });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call2('factory_checks', {});
    const opened = await call2('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    const entry = /- `01-r1:thermo-naming` [^\n]*\n/.exec(known)?.[0] ?? assert.fail('no entry');
    assert.match(entry, /\(left\): s{150,200}.* \(ok:1\) - naming\n/);
    assert.ok(!entry.includes('TAILMARK') && !entry.includes('s'.repeat(500)));
  });

  it('marks an entry carried to the reviewed slice as work to check, and an entry carried to the end queue as an ordinary carried one', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming', 'order']);
    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_carry', { observations: ['thermo-order'], to: 'end' });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    assert.match(known, /- `01-r1:thermo-naming` \(carried; carried to this slice: check it\): /);
    assert.match(known, /- `01-r1:thermo-order` \(carried\): /);
  });

  /** Builds the active slice to a green review and completes it, then starts the next one. */
  const finishActive = async (ws: Workspace, file: string) => {
    commit(ws, file);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, []);
    await withRun(ws, 'demo', run => recordReview(ws, run));
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
  };
  /** The KNOWN OBSERVATIONS section of the data file of the review of the active slice. */
  const knownOf = async (ws: Workspace, call: (name: string, params: unknown) => Promise<Reply>, file: string) => {
    commit(ws, file);
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    return /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
  };

  it('marks an entry carried to the end queue as work to check in the review of the follow-up slice that takes it', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['order']);
    await call('factory_carry', { observations: ['thermo-order'], to: 'end' });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await call('factory_follow_up', { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await finishActive(ws, 'second.txt');
    assert.equal(readRun(ws, 'demo').slices.find(item => item.status === 'active')?.title, 'Polish');
    assert.match(await knownOf(ws, call, 'polish.txt'), /- `01-r1:thermo-order` \(carried; carried to this slice: check it\): /);
  });

  it('keeps an entry carried to a pending slice marked in that slice\'s review after factory_reslice renumbers it', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming']);
    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_reslice', { slices: [slice('Part one'), slice('Part two', ['Part one'])] });
    await finishActive(ws, 'one.txt');
    await finishActive(ws, 'two.txt');
    assert.equal(readRun(ws, 'demo').slices.find(item => item.status === 'active')?.title, 'Second');
    assert.match(await knownOf(ws, call, 'second.txt'), /- `01-r1:thermo-naming` \(carried; carried to this slice: check it\): /);
  });

  it('moves a carried item on a later reslice after the slice it was carried from was split into differently titled children', async () => {
    using dir = repo();
    const { call, ws } = await ledgerRun(dir.root, ['naming']);
    await call('factory_carry', { observations: ['thermo-naming'], to: '02' });
    await call('factory_reslice', { slices: [slice('Part one'), slice('Part two', ['Part one'])] });
    await finishActive(ws, 'one.txt');
    await finishActive(ws, 'two.txt');
    await call('factory_reslice', { slices: [slice('Late one'), { ...slice('Late two', ['Late one']), carried: ['01-r1:thermo-naming'] }] });
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.find(item => item.title === 'Late one')?.carried, []);
    assert.match(run.slices.find(item => item.title === 'Late two')?.carried.join('\n') ?? '', /\[observation\] thermo-naming/);
  });

  describe('factory_reslice with carried keys', () => {
    /** Slice 01 done with the thermo observations `names` carried to slice 02, which is active and about to be split. */
    const carriedToActive = async (root: string, names: string[], note?: string) => {
      const { call, ws } = await ledgerRun(root, names);
      await call('factory_carry', { observations: names.map(name => `thermo-${name}`), ...(note === undefined ? {} : { note }), to: '02' });
      await withRun(ws, 'demo', run => completeSlice(ws, run));
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      return { call, ws };
    };
    const ticketOf = (ws: Workspace, title: string) => {
      const run = readRun(ws, 'demo');
      const found = run.slices.find(item => item.title === title) ?? assert.fail(`no slice ${title}`);
      return { found, run, text: readFileSync(ticketPath(ws, 'demo', found), 'utf8') };
    };

    it('moves a named item to the child that builds it, with its text and only its key, and the first child keeps the rest', async () => {
      using dir = repo();
      const { call, ws } = await ledgerRun(dir.root, ['naming', 'style']);
      await call('factory_carry', { observations: ['thermo-naming', 'thermo-style'], to: '02' });
      await withRun(ws, 'demo', run => completeSlice(ws, run));
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-style'] }] });

      const one = ticketOf(ws, 'Part one');
      const two = ticketOf(ws, 'Part two');
      assert.match(one.text, /\[observation\] thermo-naming[^]*naming misleads the reader/);
      assert.doesNotMatch(one.text, /thermo-style/);
      assert.match(one.text, /Carried keys: `01-r1:thermo-naming`\n/);
      assert.match(two.text, /### From green review 01-r1 of slice 01 "Feature"/);
      assert.match(two.text, /- Location: ok:1\n- Title: [^\n]*\n- Problem: style misleads the reader\n- Fix: [^\n]*\n- Fix prompt: /);
      assert.doesNotMatch(two.text, /thermo-naming/);
      assert.match(two.text, /Carried keys: `01-r1:thermo-style`\n/);
      assert.ok(!two.text.includes('`01-r1:thermo-naming`'));
    });

    it('marks the moved entry in the data of the child that took it, and not in the first child\'s', async () => {
      using dir = repo();
      const { call, ws } = await ledgerRun(dir.root, ['naming', 'style']);
      await call('factory_carry', { observations: ['thermo-naming', 'thermo-style'], to: '02' });
      await withRun(ws, 'demo', run => completeSlice(ws, run));
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-style'] }] });
      const run = readRun(ws, 'demo');
      const marked = (title: string) => renderKnownObservations(run, run.slices.find(item => item.title === title) ?? assert.fail(title));
      assert.match(marked('Part two'), /`01-r1:thermo-style` \(carried; carried to this slice: check it\)/);
      assert.match(marked('Part two'), /`01-r1:thermo-naming` \(carried\):/);
      assert.match(marked('Part one'), /`01-r1:thermo-naming` \(carried; carried to this slice: check it\)/);
      assert.match(marked('Part one'), /`01-r1:thermo-style` \(carried\):/);
    });

    it('leaves every carried section on the first child when no child names a key', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming', 'style']);
      await call('factory_reslice', { slices: [slice('Part one'), slice('Part two', ['Part one'])] });
      assert.match(ticketOf(ws, 'Part one').text, /Carried keys: `01-r1:thermo-naming`\n[^]*Carried keys: `01-r1:thermo-style`/);
      assert.deepEqual(ticketOf(ws, 'Part two').found.carried, []);
    });

    it('keeps a carried note, which has no key, with the first child', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming'], 'Mind the naming rules.');
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] });
      assert.match(ticketOf(ws, 'Part one').text, /Mind the naming rules\./);
      assert.doesNotMatch(ticketOf(ws, 'Part two').text, /Mind the naming rules/);
      assert.match(ticketOf(ws, 'Part two').text, /thermo-naming/);
    });

    it('moves an item whose carried header names a three-digit slice id', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        active.carried = active.carried.map(section => section.replace(' of slice 01 "', ' of slice 100 "'));
      });
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] });
      assert.match(ticketOf(ws, 'Part two').text, /of slice 100 "Feature"[^]*\[observation\] thermo-naming/);
      assert.doesNotMatch(ticketOf(ws, 'Part one').text, /thermo-naming/);
    });

    it('keeps a note that holds a keys-looking line with the first child, and never reads it as carrying that key', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming'], 'Mind this.\nCarried keys: `01-r1:thermo-naming`');
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] });
      assert.match(ticketOf(ws, 'Part one').text, /Mind this\./);
      assert.doesNotMatch(ticketOf(ws, 'Part two').text, /Mind this/);
      assert.match(ticketOf(ws, 'Part two').text, /\[observation\] thermo-naming/);
    });

    it('moves a finding whole when its problem holds a heading-shaped line of its own', async () => {
      using dir = repo();
      const forged = 'first part\n\n#### [observation] extra\n\n- Location: x:1\n- Title: fake\n\nsame id:\n\n#### [observation] thermo-style\n\n- Location: y:2\n\nlast part';
      const { call, ws } = await ledgerRun(dir.root, ['naming', 'style'], same => (same.id === 'thermo-style' ? { ...same, problem: forged } : same));
      await call('factory_carry', { observations: ['thermo-naming', 'thermo-style'], to: '02' });
      await withRun(ws, 'demo', run => completeSlice(ws, run));
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-style'] }] });
      const two = ticketOf(ws, 'Part two').text;
      assert.ok(two.includes(forged) && two.includes('- Fix: '));
      assert.doesNotMatch(ticketOf(ws, 'Part one').text, /first part|last part|extra/);
    });

    it('refuses a key in a legacy section that lists several keys, naming the key, changing nothing; the section stays with the first child', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming', 'style']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        const [one = '', two = ''] = active.carried;
        active.carried = [`${one.replace(/\n\nCarried keys: .*$/, '')}\n\n${two.split('\n\n').slice(1).join('\n\n')}`.replace(/\n\nCarried keys: .*$/, '\n\nCarried keys: `01-r1:thermo-naming`, `01-r1:thermo-style`')];
      });
      const before = { run: readRun(ws, 'demo'), ticket: ticketOf(ws, 'Second').text };
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-style'] }] }), /01-r1:thermo-style.*several keys/);
      assert.deepEqual(readRun(ws, 'demo'), before.run);
      assert.equal(ticketOf(ws, 'Second').text, before.ticket);
    });

    it('refuses a key in a legacy section that holds a note and one item, naming the key, changing nothing', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        const [one = ''] = active.carried;
        const [header = '', ...rest] = one.split('\n\n');
        active.carried = [[header, '#### [observation] thermo-naming', 'Mind this.', ...rest].join('\n\n')];
      });
      const before = { run: readRun(ws, 'demo'), ticket: ticketOf(ws, 'Second').text };
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] }), /01-r1:thermo-naming.*note/);
      assert.deepEqual(readRun(ws, 'demo'), before.run);
      assert.equal(ticketOf(ws, 'Second').text, before.ticket);
    });

    it('refuses a key in a legacy section whose note sits between the header and the item', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        const [one = ''] = active.carried;
        const [header = '', ...rest] = one.split('\n\n');
        active.carried = [[header, 'Mind this.', ...rest].join('\n\n')];
      });
      const before = readRun(ws, 'demo');
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] }), /01-r1:thermo-naming.*note/);
      assert.deepEqual(readRun(ws, 'demo'), before);
    });

    it('refuses an unknown key, a key named by two children and a key in a keyless section, naming the key and changing nothing', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      const before = { run: readRun(ws, 'demo'), ticket: ticketOf(ws, 'Second').text };
      const split = (one: string[], two: string[]) => ({ slices: [{ ...slice('Part one'), carried: one }, { ...slice('Part two', ['Part one']), carried: two }] });
      await assert.rejects(call('factory_reslice', split([], ['01-r1:thermo-nope'])), /01-r1:thermo-nope/);
      await assert.rejects(call('factory_reslice', split(['01-r1:thermo-naming'], ['01-r1:thermo-naming'])), /01-r1:thermo-naming.*two children/);
      assert.deepEqual(readRun(ws, 'demo'), before.run);
      assert.equal(ticketOf(ws, 'Second').text, before.ticket);
      await call('factory_reslice', split([], ['01-r1:thermo-naming']));
      assert.match(ticketOf(ws, 'Part two').text, /\[observation\] thermo-naming/);
      assert.doesNotMatch(ticketOf(ws, 'Part one').text, /thermo-naming/);
    });

    it('refuses a key in a keyless section, naming the key and changing nothing', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      const split = (one: string[], two: string[]) => ({ slices: [{ ...slice('Part one'), carried: one }, { ...slice('Part two', ['Part one']), carried: two }] });
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        active.carried = active.carried.map(section => section.split('\n').filter(line => !line.startsWith('Carried keys: ')).join('\n'));
      });
      const keyless = { run: readRun(ws, 'demo'), ticket: ticketOf(ws, 'Second').text };
      await assert.rejects(call('factory_reslice', split([], ['01-r1:thermo-naming'])), /01-r1:thermo-naming.*without a Carried keys line/);
      assert.deepEqual(readRun(ws, 'demo'), keyless.run);
      assert.equal(ticketOf(ws, 'Second').text, keyless.ticket);
    });

    it('after a refusal for a section that cannot move, the call without that key goes through and the section stays with the first child', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        active.carried = active.carried.map(section => section.split('\n').filter(line => !line.startsWith('Carried keys: ')).join('\n'));
      });
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] }), /drop it from `carried`/);
      await call('factory_reslice', { slices: [slice('Part one'), slice('Part two', ['Part one'])] });
      assert.match(ticketOf(ws, 'Part one').text, /\[observation\] thermo-naming/);
      assert.deepEqual(ticketOf(ws, 'Part two').found.carried, []);
    });

    it('moves every item out of the first child to later children, one to the third child', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming', 'style']);
      await call('factory_reslice', {
        slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }, { ...slice('Part three', ['Part two']), carried: ['01-r1:thermo-style'] }],
      });
      const one = ticketOf(ws, 'Part one');
      const two = ticketOf(ws, 'Part two');
      const three = ticketOf(ws, 'Part three');
      assert.deepEqual(one.found.carried, []);
      assert.doesNotMatch(one.text, /thermo-|Carried keys/);
      assert.equal(two.found.carried.length, 1);
      assert.match(two.text, /\[observation\] thermo-naming[^]*Carried keys: `01-r1:thermo-naming`\n/);
      assert.doesNotMatch(two.text, /thermo-style/);
      assert.equal(three.found.carried.length, 1);
      assert.match(three.text, /\[observation\] thermo-style[^]*Carried keys: `01-r1:thermo-style`\n/);
      assert.doesNotMatch(three.text, /thermo-naming/);
    });

    it('lists the carried keys each child holds in the approval dialog', async () => {
      using dir = repo();
      const { call } = await carriedToActive(dir.root, ['naming', 'style']);
      const bodies: string[] = [];
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-style'] }] }, { confirm: async (_title, body) => (bodies.push(body), true) });
      assert.equal(bodies.length, 1);
      assert.match(bodies[0] ?? '', /Part one\n[^]*carried: 01-r1:thermo-naming\n[^]*Part two\n[^]*carried: 01-r1:thermo-style\n/);
    });

    it('moves a section whose carried-from slice title holds a blank line to the child that names it', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        active.carried = active.carried.map(section => section.replace('"Feature"', '"Fea\n\nture"'));
        for (const item of run.slices) if (item.title === 'Feature') item.title = 'Fea\n\nture';
      });
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] });
      assert.match(ticketOf(ws, 'Part two').text, /\[observation\] thermo-naming/);
      assert.deepEqual(ticketOf(ws, 'Part one').found.carried, []);
    });

    it('refuses a key in a legacy section whose note between the header and the item ends in a double quote', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        const [one = ''] = active.carried;
        const [header = '', ...rest] = one.split('\n\n');
        active.carried = [[header, 'Mind "this"', ...rest].join('\n\n')];
      });
      const before = readRun(ws, 'demo');
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] }), /01-r1:thermo-naming.*note/);
      assert.deepEqual(readRun(ws, 'demo'), before);
    });

    it('refuses a note even when a proposed child title would make the note part of the header', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await withRun(ws, 'demo', run => {
        const active = run.slices.find(item => item.status === 'active') ?? assert.fail('no active slice');
        const [one = ''] = active.carried;
        const [header = '', ...rest] = one.split('\n\n');
        active.carried = [[header, 'Mind "this"', ...rest].join('\n\n')];
      });
      const before = readRun(ws, 'demo');
      await assert.rejects(call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }, slice('Feature"\n\nMind "this', ['Part one'])] }), /01-r1:thermo-naming.*note/);
      assert.deepEqual(readRun(ws, 'demo'), before);
    });

    it('takes a key one child lists twice, and refuses only a key two children name', async () => {
      using dir = repo();
      const { call, ws } = await carriedToActive(dir.root, ['naming']);
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming', '01-r1:thermo-naming'] }] });
      assert.match(ticketOf(ws, 'Part two').text, /\[observation\] thermo-naming/);
    });

    it('does not mark a finding carried in the first child when only a carried note quotes it', async () => {
      using dir = repo();
      const quoted = renderFinding({ ...finding('thermo', 'observation', 'naming'), problem: problemOf('naming') }, [], '####');
      const { call, ws } = await ledgerRun(dir.root, ['naming']);
      await call('factory_carry', { note: quoted, observations: ['thermo-naming'], to: '02' });
      await withRun(ws, 'demo', run => completeSlice(ws, run));
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      await call('factory_reslice', { slices: [slice('Part one'), { ...slice('Part two', ['Part one']), carried: ['01-r1:thermo-naming'] }] });
      const run = readRun(ws, 'demo');
      const marked = (title: string) => renderKnownObservations(run, run.slices.find(item => item.title === title) ?? assert.fail(title));
      assert.match(marked('Part one'), /`01-r1:thermo-naming` \(carried\):/);
      assert.match(marked('Part two'), /`01-r1:thermo-naming` \(carried; carried to this slice: check it\)/);
    });
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

  it('renders a finding title with a newline and a credential on one redacted line', () => {
    const forged = `first line\n- Problem: forged ghp_${'a'.repeat(30)}`;
    const lines = renderFinding({ ...finding('thermo', 'observation', 'naming'), title: forged }, []).split('\n');
    const titles = lines.filter(line => line.startsWith('- Title:'));
    assert.deepEqual(titles, ['- Title: first line - Problem: forged <REDACTED>']);
    assert.equal(lines.filter(line => line.startsWith('- Problem:')).length, 1);
    assert.doesNotMatch(lines.join('\n'), /ghp_/);
  });

  it('lists a ledger entry and an unplaced finding whose title holds a newline and a credential on one redacted line each', async () => {
    using dir = repo();
    const title = (name: string) => `${name} title\nghp_${'b'.repeat(30)}`;
    const { call, ws } = await ledgerRun(dir.root, ['naming'], same => ({ ...same, title: title('entry') }));
    await call('factory_leave', { observations: ['thermo-naming'] });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'second.txt');
    await withRun(ws, 'demo', run => {
      const active = run.slices.find(item => item.id === '02') ?? assert.fail('no slice 02');
      active.unplaced = [{ finding: { ...finding('thermo', 'observation', 'style'), title: title('unplaced') }, category: 'naming', review: '01-r1' }];
    });
    await call('factory_checks', {});
    const opened = await call('factory_review_start', { skip: [] });
    const data = readFileSync(opened.details?.dataFile ?? assert.fail('no data file'), 'utf8');
    const known = /## KNOWN OBSERVATIONS\n\n([\s\S]*?)\n## /.exec(data)?.[1] ?? assert.fail('no KNOWN OBSERVATIONS section');
    assert.match(known, /\(left\): ok:1 - entry title <REDACTED>\n/);
    assert.match(known, /\(unplaced\): ok:1 - unplaced title <REDACTED>\n/);
    assert.doesNotMatch(data, /ghp_/);
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

describe('observation titles in confirm dialogs', () => {
  const title = `first\nsecond ghp_${'a'.repeat(30)}`;
  const longTitle = `${'w'.repeat(300)} end`;
  const shape = (found: Finding) => ({ ...found, title });
  const asking = (bodies: string[]): Ui => ({ confirm: async (_title, body) => (bodies.push(body), true) });

  it('factory_place shows a multi-line titled observation on one redacted line', async () => {
    using dir = repo();
    const { call } = await ledgerRun(dir.root, ['place'], shape);
    const bodies: string[] = [];
    await call('factory_place', { placements: [] }, asking(bodies));
    assert.match(bodies[0] ?? '', /^- thermo-place \([^)]*\): .*\. first second <REDACTED>$/m);
    assert.doesNotMatch(bodies[0] ?? '', /ghp_/);
  });

  it('factory_leave, factory_defer and factory_fix show such an observation on one redacted line', async () => {
    using dir = repo();
    const { call } = await ledgerRun(dir.root, ['leave', 'defer', 'fix'], shape);
    const bodies: string[] = [];
    await call('factory_leave', { observations: ['thermo-leave'] }, asking(bodies));
    await call('factory_defer', { observations: ['thermo-defer'] }, asking(bodies));
    await call('factory_fix', { observations: ['thermo-fix'], reason: 'tidy' }, asking(bodies));
    for (const [index, id] of ['leave', 'defer', 'fix'].entries()) {
      assert.match(bodies[index] ?? '', new RegExp(`^- thermo-${id}: (demo\\/01: )?first second <REDACTED>$`, 'm'), id);
      assert.doesNotMatch(bodies[index] ?? '', /ghp_/, id);
    }
  });

  it('factory_defer clips the dialog title at 500 characters, not the 200 of the issue title', async () => {
    using dir = repo();
    const { call } = await ledgerRun(dir.root, ['long'], found => ({ ...found, title: longTitle }));
    const bodies: string[] = [];
    await call('factory_defer', { observations: ['thermo-long'] }, asking(bodies));
    assert.ok((bodies[0] ?? '').includes(`: ${longTitle}\n`), 'the whole 304-character title shows');
  });
});
