import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { forgetRun, readRun, statePath } from '../src/run.ts';
import { resetModuleState } from '../src/index.ts';
import { tempRepo } from './helpers.ts';

const CHECKS_OK = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };

beforeEach(() => resetModuleState());

const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

function session(root: string) {
  const sent: string[] = [];
  const commands = new Map<string, Command>();
  const tools = load([], new Map(), commands, () => 'off', sent);
  const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
  const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
  return { call, command: (args: string) => commands.get('factory')?.handler(args, main), sent };
}

describe('run mode', () => {
  it('stores mode headless when factory_start gets it, shows it in factory_status, and keeps it on resume', async () => {
    using repo = tempRepo('factory-headless-', CHECKS_OK);
    const { call } = session(repo.root);
    await call('factory_start', { feature: 'demo', mode: 'headless', source: SOURCE });
    const ws = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'demo').mode, 'headless');
    assert.match(await call('factory_status', {}), /\\"mode\\": \\"headless\\"/);

    resetModuleState();
    const again = session(repo.root);
    await again.call('factory_start', { resume: 'demo' });
    assert.equal(readRun(ws, 'demo').mode, 'headless');
  });

  it('starts interactive without the parameter, and loads a state file without the field as interactive', async () => {
    using repo = tempRepo('factory-interactive-', CHECKS_OK);
    const { call } = session(repo.root);
    await call('factory_start', { feature: 'demo', source: SOURCE });
    const ws = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'demo').mode, 'interactive');
    assert.match(await call('factory_status', {}), /\\"mode\\": \\"interactive\\"/);

    const path = statePath(ws, 'demo');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    delete state.mode;
    writeFileSync(path, JSON.stringify(state));
    forgetRun(ws, 'demo');
    assert.equal(readRun(ws, 'demo').mode, 'interactive');
  });
});

describe('/factory headless', () => {
  it('sends a turn that leads to factory_start with mode headless for the issue ref', async () => {
    using repo = tempRepo('factory-headless-cmd-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    await command('headless #102');
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? '', /factory_start/);
    assert.match(sent[0] ?? '', /mode "headless"/);
    assert.match(sent[0] ?? '', /#102/);
    assert.doesNotMatch(sent[0] ?? '', /Start a software-factory run for: headless/);
  });

  it('refuses without an issue ref and sends nothing', async () => {
    using repo = tempRepo('factory-headless-usage-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    await assert.rejects(Promise.resolve(command('headless')), /Usage: \/factory headless <issue ref>/);
    assert.deepEqual(sent, []);
  });
});
