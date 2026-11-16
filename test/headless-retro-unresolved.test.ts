import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { readRun, ticketPath, withRun } from '../src/run.ts';
import { completeSlice } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { tempRepo, CHECKS_OK, retroDoneRun as doneRun, acceptUnresolved } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('headless retro: Record slices accepted unresolved', () => {
  it('a Record slice accepted unresolved defers none of its findings, and its items get one new Record slice listing them', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'first');
    const accepted = readRun(ws, 'demo');
    assert.equal(accepted.slices[1]?.record, true);
    assert.equal(accepted.deferred.length, 1);
    assert.ok((accepted.slices[1]?.unresolved ?? []).length > 0);
    assert.ok(accepted.events.some(event => event.kind === 'accepted-unresolved' && /not deferred/.test(event.detail)));
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Record deferred items 2']);
    assert.equal(run.status, 'running');
    assert.equal(run.deferred[0]?.recorded, run.slices[2]?.id);
    assert.match(readFileSync(ticketPath(ws, 'demo', run.slices[2] ?? assert.fail('no retry slice')), 'utf8'), /naming/);
  });

  it('a retry Record slice also accepted unresolved adds no third one, the run becomes done, and factory_status shows the items as not written', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'first');
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    await acceptUnresolved(ws, call, 'second');
    await withRun(ws, 'demo', current => completeSlice(ws, current));
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Record deferred items 2']);
    assert.equal(run.status, 'done');
    const status = JSON.parse((await call('factory_status', {})).content[0]?.text ?? '{}') as { deferred: { id: string; status?: string }[] };
    assert.deepEqual(status.deferred.map(item => item.status), ['not written to the file after a retry']);
  });
});
