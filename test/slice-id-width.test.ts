import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { forgetRun, readRun, statePath } from '../src/run.ts';
import { load } from './extension.ts';
import { newRun, slice, workspace } from './helpers.ts';

/** Every `pattern` a tool's JSON schema holds under `key` (the property that names a slice id). */
function patterns(node: unknown, key: string, found: string[] = [], inKey = false): string[] {
  if (Array.isArray(node)) {
    for (const item of node) patterns(item, key, found, inKey);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (inKey && typeof record.pattern === 'string') found.push(record.pattern);
    for (const [name, value] of Object.entries(record)) patterns(value, key, found, inKey || (name === key && typeof value === 'object'));
  }
  return found;
}

const accepts = (tool: string, key: string, id: string) => {
  const registered = load().get(tool) ?? assert.fail(`no tool ${tool}`);
  const found = patterns(registered.parameters, key);
  assert.ok(found.length > 0, `${tool} has no ${key} pattern`);
  return found.some(pattern => new RegExp(pattern).test(id));
};

describe('slice ids of three or more digits', () => {
  it('readRun parses a state whose slice has id "100" and refuses id "1"', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const path = statePath(ws, 'demo');
    const state = JSON.parse(readFileSync(path, 'utf8')) as { slices: { id: string }[] };
    state.slices[0]!.id = '100';
    writeFileSync(path, JSON.stringify(state));
    forgetRun(ws, 'demo');
    assert.equal(readRun(ws, 'demo').slices[0]?.id, '100');
    state.slices[0]!.id = '1';
    writeFileSync(path, JSON.stringify(state));
    forgetRun(ws, 'demo');
    assert.throws(() => readRun(ws, 'demo'), /Corrupt factory state/);
  });

  for (const [tool, key] of [['factory_decide', 'slice'], ['factory_carry', 'to'], ['factory_place', 'to'], ['factory_reopen', 'slice']] as const) {
    it(`${tool} ${key} accepts "100" and refuses "1"`, () => {
      assert.equal(accepts(tool, key, '100'), true);
      assert.equal(accepts(tool, key, '1'), false);
    });
  }

  it('factory_carry still accepts "end"', () => {
    assert.equal(accepts('factory_carry', 'to', 'end') || JSON.stringify(load().get('factory_carry')?.parameters).includes('"end"'), true);
  });
});
