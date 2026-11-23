import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun } from '../src/run.ts';
import { submitStack } from '../src/submit.ts';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, step, workspace, withPrs, tempDir, prependPath, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit: failed stack calls', () => {
  it('fails naming each slice branch that has no PR after gh stack submit, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: [{ name: branches[0] ?? '', pr: 101 }, { name: branches[1] ?? '' }, { name: branches[2] ?? '', pr: 103 }] });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, new RegExp(`submitted.*not all PR titles were set.*${branches[1]}`, 's'));
    assert.match(failure.message, /\/factory submit again sets them/);
    assert.ok(!failure.message.includes(branches[0] ?? ''), 'a branch with a PR is not named');
    assert.ok(!failure.message.includes(branches[2] ?? ''), 'a branch with a PR is not named');
    assert.doesNotMatch(failure.message, /Already added/);
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice has no PR');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('reports the exact missing-PR error for the slice branch without a PR and sends no PATCH', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: [{ name: branches[0] ?? '', pr: 101 }, { name: branches[1] ?? '' }] });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.ok(failure.message.includes(`gh stack submit left these slice branches with no PR: ${branches[1]}.`), failure.message);
    assert.equal(gh.calls().filter(call => call.includes('PATCH')).length, 0, 'no PATCH is sent');
  });

  it('fails saying not all titles were set when a title PATCH fails, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using _gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches), fail: 'api -X' });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, /submitted.*not all PR titles were set.*\/factory submit again sets them/s);
    assert.doesNotMatch(failure.message, /Already added/);
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'submit'), 'the submit event is saved with the run');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('keeps exactly one submit event when the first title PATCH succeeds and the second fails', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches) });
    using wrapper = tempDir('factory-gh-second-');
    const count = join(wrapper.root, 'api-calls');
    writeFileSync(join(wrapper.root, 'gh'), [
      '#!/bin/sh',
      `if [ "$1" = "api" ]; then echo x >> '${count}'; if [ "$(wc -l < '${count}')" -ge 2 ]; then echo "second PATCH failed" >&2; exit 1; fi; fi`,
      `PATH="\${PATH#${wrapper.root}:}"`,
      'exec gh "$@"',
      '',
    ].join('\n'));
    chmodSync(join(wrapper.root, 'gh'), 0o755);
    using _path = prependPath(wrapper.root);
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, /submitted.*not all PR titles were set.*second PATCH failed.*\/factory submit again sets them/s);
    assert.doesNotMatch(failure.message, /the PR titles were not set/);
    assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 2, 'the second PATCH was attempted');
    assert.equal(gh.calls().filter(call => call.startsWith('api')).length, 1, 'only the first PATCH reached gh');
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'submit').length, 1, 'exactly one submit event is saved');
  });

  it('keeps the submit event, and reports the failure, when interactive /factory submit cannot set a PR title or body', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    const commands = new Map<string, Command>();
    load({ commands });
    const caller = { ...ctx('main', 'main'), cwd: ws.root, hasUI: true, ui: { confirm: async () => true, notify() {}, setStatus() {} } };
    await assert.rejects(commands.get('factory')?.handler('submit demo', caller) ?? Promise.resolve(), /not all PR titles were set/);
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'submit').length, 1, 'the PRs are on GitHub, so the run records the submit');
  });
});
