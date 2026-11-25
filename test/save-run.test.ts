import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readRun, saveRun, statePath, withRun } from '../src/run.ts';
import { nextSlice } from '../src/workflow.ts';
import { newRun, seedUnplacedObservation, slice, step, workspace } from './helpers.ts';

describe('saveRun validation', () => {
  it('rejects a withRun mutation that leaves an invalid value and keeps the previous state', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    const before = readFileSync(statePath(ws, 'demo'), 'utf8');
    await assert.rejects(
      seedUnplacedObservation(ws, 'Bad Id'),
      (error: Error) => error.message.includes(statePath(ws, 'demo')) && error.message.includes('finding.id') && error.message.includes('must match pattern'),
    );
    assert.equal(readFileSync(statePath(ws, 'demo'), 'utf8'), before);
    assert.ok(readRun(ws, 'demo'));
  });

  it('rejects an unknown slice phase', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await assert.rejects(
      withRun(ws, 'demo', run => void ((run.slices[0] as { phase: string }).phase = 'bogus')),
      (error: Error) => error.message.includes(statePath(ws, 'demo')) && error.message.includes('phase'),
    );
    assert.ok(readRun(ws, 'demo'));
  });

  it('throws from saveRun and leaves state.json byte-identical', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const before = readFileSync(statePath(ws, 'demo'), 'utf8');
    const savedFile = `${statePath(ws, 'demo')}.saved`;
    const savedBefore = readFileSync(savedFile, 'utf8');
    const run = readRun(ws, 'demo');
    (run.slices[0] as { phase: string }).phase = 'bogus';
    assert.throws(() => saveRun(ws, run), /state\.json/);
    assert.equal(readFileSync(savedFile, 'utf8'), savedBefore);
    assert.ok(readRun(ws, 'demo'));
    assert.equal(readFileSync(statePath(ws, 'demo'), 'utf8'), before);
  });
});
