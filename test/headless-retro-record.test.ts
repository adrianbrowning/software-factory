import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, ticketPath, withRun } from '../src/run.ts';
import { completeSlice } from '../src/review.ts';
import { nextAction, nextSlice } from '../src/workflow.ts';
import { finding, slice, tempRepo, CHECKS_OK, retroDoneRun as doneRun, reviewActive } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless retro: Record deferred items slices', () => {
  it('items deferred by a follow-up slice after the retro get a second Record slice before the run is done', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await reviewActive(ws, 'record', []);
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    assert.equal(readRun(ws, 'demo').status, 'done');
    await call('factory_follow_up', { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' });
    await reviewActive(ws, 'polish', [finding('thermo', 'observation', 'wording')]);
    await call('factory_defer', { observations: ['thermo-wording'] });
    // factory_follow_up reopens the retro; restore the recorded retro so completing the slice is what would settle the run.
    await withRun(ws, 'demo', run => {
      run.retroRecorded = true;
    });
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    const reply = nextAction(run);
    assert.equal(run.status, 'running');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Polish', 'Record deferred items 2']);
    const ticket = readFileSync(ticketPath(ws, 'demo', run.slices[3] ?? assert.fail('no slice')), 'utf8');
    assert.match(ticket, /wording/);
    assert.doesNotMatch(ticket, /naming/);
    assert.match(reply, /factory_next/);
  });

  it("a Record slice's own review items are not deferred to the file and add no further slice, and the run becomes done", async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await reviewActive(ws, 'record', [finding('comments', 'observation', 'wording')]);
    const refused = await call('factory_defer', { observations: ['comments-wording'] }).then(
      () => '',
      (error: Error) => error.message,
    );
    assert.match(refused, /Record deferred items/);
    await withRun(ws, 'demo', run => completeSlice(ws, run));
    const run = readRun(ws, 'demo');
    assert.equal(run.deferred.length, 1);
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items']);
    assert.equal(run.status, 'done');
  });

  it('every child of a resliced Record slice stays a Record slice, and its items point at the first child', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await call('factory_reslice', { slices: [slice('Record part one'), slice('Record part two', ['Record part one'])] });
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.record), [undefined, true, true]);
    assert.deepEqual(run.deferred.map(item => item.recorded), [run.slices[1]?.id]);
  });

  it('a pending Record slice after a resliced one is renumbered with its items and keeps the Record flag', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await call('factory_follow_up', { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Record deferred items 2', whatToBuild: 'Later items' });
    await withRun(ws, 'demo', run => {
      const later = run.slices[2] ?? assert.fail('no later slice');
      later.record = true;
      run.deferred.push({ body: 'Later body', id: 'later', key: 'x:later', kind: 'observation', location: 'notes/later.md', recorded: later.id, review: 'x', slice: '01', title: 'Later item' });
    });
    assert.equal(readRun(ws, 'demo').slices[2]?.id, '03');
    await call('factory_reslice', { slices: [slice('Record part one'), slice('Record part two', ['Record part one'])] });
    const run = readRun(ws, 'demo');
    const later = run.slices.find(item => item.title === 'Record deferred items 2') ?? assert.fail('later slice lost');
    assert.equal(later.id, '04');
    assert.equal(later.record, true);
    assert.equal(run.deferred.find(item => item.id === 'later')?.recorded, '04');
  });
});

describe('nextAction for implementer phases', () => {
  const nextLine = (phase: 'implement' | 'fix') => {
    const run = {
      feature: 'demo',
      status: 'running',
      slices: [{ id: '01', title: 'Feature', phase, status: 'active', fixPath: '/x/fixes/01-f1.md' }],
    };
    return nextAction(run as never);
  };

  it('implement: names the report file and says to handle a stop report before factory_checks', () => {
    const text = nextLine('implement');
    assert.match(text, /^Spawn factory-implementer for slice 01/);
    assert.match(text, /read its report file \(reports\/01\.md/);
    assert.match(text, /stop report in its Open list.*then call factory_checks/);
  });

  it('fix: says the same together with the fix file', () => {
    const text = nextLine('fix');
    assert.match(text, /\/x\/fixes\/01-f1\.md/);
    assert.match(text, /read its report file \(reports\/01\.md/);
    assert.match(text, /stop report in its Open list.*then call factory_checks/);
  });
});
