import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { carriedKeysLine } from '../src/legacy-observations.ts';
import { submitImplementerReport } from '../src/report.ts';
import { readRun, reportPath, type Workspace } from '../src/run.ts';
import { runChecks } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { commit, finding, newRun, sh, slice, step, workspace } from './helpers.ts';

const KEYS = ['01-r1:thermo-naming', '01-r1:other-gap'];

/** A started slice that carries `sections` (carried-in sections) and has one commit; returns that commit's short sha. */
async function carrying(ws: Workspace, sections: string[]) {
  await newRun(ws, [slice('Feature')]);
  await step(ws, run => nextSlice(ws, run));
  await step(ws, run => void (run.slices[0]!.carried = sections));
  commit(ws, 'ok');
  return sh(ws.root, 'rev-parse', '--short=12', 'HEAD');
}

const section = (keys: string[]) => `### From green review 01-r1 of slice 01 "Feature"\n\nbody\n\n${carriedKeysLine(keys)}`;
const submit = (ws: Workspace, sha: string, fixItems?: string[]) =>
  step(ws, run => submitImplementerReport(ws, run, { behaviors: [], checks: [], commits: [`${sha} ok`], ...(fixItems === undefined ? {} : { fixItems }), open: ['SLICE TOO BIG: rest'] }));

describe('build-mode report with carried keys', () => {
  it('stores each accepted line form under Carried items, leaves the ledger alone, and shows them in the checks reply', async () => {
    using ws = workspace();
    const sha = await carrying(ws, [section(KEYS)]);
    await step(ws, run => void run.slices[0]!.unplaced.push({ category: 'naming', finding: { ...finding('thermo', 'observation', 'naming'), id: 'thermo-naming' }, review: '01-r1' }));
    assert.equal(readRun(ws, 'demo').slices[0]!.unplaced.length, 1);
    const before = JSON.stringify(readRun(ws, 'demo'));
    const lines = [`${KEYS[0]} fixed in ${sha}`, `\`${KEYS[0]}\` fixed in ${sha} renamed the helper`, `${KEYS[1]}: fixed in ${sha}`];
    await submit(ws, sha, lines);
    assert.equal(JSON.stringify(readRun(ws, 'demo')), before);
    const { report } = await step(ws, run => runChecks(ws, run));
    assert.match(report, new RegExp(`Commits:\\n- ${sha} ok\\nCarried items:\\n${lines.map(line => `- ${line.replace(/[`.]/g, '\\$&')}`).join('\\n')}\\nChecks:\\n- none\\nBehaviors:`));
    assert.doesNotMatch(report, /Fix file items/);
  });

  it('refuses each bad line, stores nothing, and names the line and the carried keys', async () => {
    using ws = workspace();
    const sha = await carrying(ws, [section(KEYS)]);
    const path = reportPath(ws, 'demo', readRun(ws, 'demo').slices[0]!);
    for (const bad of ['thermo-naming fixed in ' + sha, `${KEYS[0]} already fixed`, `${KEYS[0]} not a defect: why`, `01-r1:other fixed in ${sha}`, `${KEYS[0]} fixed in 0000000`]) {
      await assert.rejects(submit(ws, sha, [`${KEYS[1]} fixed in ${sha}`, bad]), (error: Error) => error.message.includes(bad) && KEYS.every(key => error.message.includes(key)) && !error.message.includes(`\n${KEYS[1]} fixed in`));
      assert.ok(!existsSync(path));
    }
  });

  it('still stores a report without fixItems on a carried slice', async () => {
    using ws = workspace();
    const sha = await carrying(ws, [section(KEYS)]);
    await submit(ws, sha);
    assert.doesNotMatch(readFileSync(reportPath(ws, 'demo', readRun(ws, 'demo').slices[0]!), 'utf8'), /Carried items/);
  });

  it('keeps refusing fixItems on a slice whose only carried section is a note', async () => {
    using ws = workspace();
    const sha = await carrying(ws, [section([])]);
    await assert.rejects(submit(ws, sha, [`${KEYS[0]} fixed in ${sha}`]), /not in fix mode: leave fixItems out/);
  });
});
