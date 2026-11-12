import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { forgetRun, readRun, statePath } from '../src/run.ts';
import { resetModuleState } from '../src/index.ts';
import { tempDir, tempRepo } from './helpers.ts';

const CHECKS_OK = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }), 'ticket.md': '# Add the widget\n\nBuild it.\n' };

beforeEach(() => resetModuleState());

const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

function session(root: string) {
  const sent: string[] = [];
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent });
  const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
  const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
  return { call, command: (args: string) => commands.get('factory')?.handler(args, main), sent };
}

describe('run mode', () => {
  it('factory_start cannot create a headless run, and resume keeps the mode the /factory headless command stored', async () => {
    using repo = tempRepo('factory-headless-', CHECKS_OK);
    const { call } = session(repo.root);
    await call('factory_start', { feature: 'demo', mode: 'headless', source: SOURCE });
    const ws = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'demo').mode, 'interactive');

    resetModuleState();
    const cmd = session(repo.root);
    await cmd.command('headless ticket.md');
    assert.equal(readRun(ws, 'ticket').mode, 'headless');

    resetModuleState();
    const again = session(repo.root);
    const resumed = await again.call('factory_start', { resume: 'ticket' });
    assert.match(resumed, /Run \\"ticket\\" is/);
    assert.match(await again.call('factory_status', {}), /\\"mode\\": \\"headless\\"/);
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
    resetModuleState();
    const legacy = session(repo.root);
    await legacy.call('factory_start', { resume: 'demo' });
    assert.match(await legacy.call('factory_status', {}), /\\"mode\\": \\"interactive\\"/);
  });
});

describe('/factory headless', () => {
  it('starts a run with mode headless through the same start path, then sends a turn that continues it', async () => {
    using repo = tempRepo('factory-headless-cmd-', CHECKS_OK);
    const { call, command, sent } = session(repo.root);
    await command('headless ticket.md');
    const ws = { config: loadConfig(repo.root), root: repo.root };
    assert.equal(readRun(ws, 'ticket').mode, 'headless');
    assert.match(await call('factory_status', {}), /\\"mode\\": \\"headless\\"/);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? '', /"ticket"/);
    assert.match(sent[0] ?? '', /skill:\/\/software-factory/);
    assert.doesNotMatch(sent[0] ?? '', /factory_start/);
  });

  it('names a GitHub issue run issue-<n> from the number, with or without #', async () => {
    using bin = tempDir('factory-fake-gh-');
    const issue = JSON.stringify({ author: { login: 'owner' }, body: 'Do it', comments: [], title: 'Demo', url: 'https://github.com/o/r/issues/102' });
    writeFileSync(join(bin.root, 'gh'), `#!/bin/sh\nif [ "$1" = issue ]; then echo '${issue}'; else echo OWNER; fi\n`);
    chmodSync(join(bin.root, 'gh'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin.root}:${path}`;
    try {
      for (const ref of ['#102', '102']) {
        using repo = tempRepo('factory-headless-gh-', CHECKS_OK);
        resetModuleState();
        await session(repo.root).command(`headless ${ref}`);
        const ws = { config: loadConfig(repo.root), root: repo.root };
        assert.equal(readRun(ws, 'issue-102').mode, 'headless', ref);
      }
    } finally {
      process.env.PATH = path;
    }
  });

  it('fails with the start error and sends nothing when the issue cannot be loaded', async () => {
    using repo = tempRepo('factory-headless-missing-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    await assert.rejects(Promise.resolve(command('headless nope.md')), /does not exist/);
    assert.deepEqual(sent, []);
    assert.equal(existsSync(statePath({ config: loadConfig(repo.root), root: repo.root }, 'nope')), false);
  });

  it('refuses without an issue ref and sends nothing', async () => {
    using repo = tempRepo('factory-headless-usage-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    await assert.rejects(Promise.resolve(command('headless')), /Usage: \/factory headless <issue ref>/);
    assert.deepEqual(sent, []);
  });

  it('refuses a file ref that has no letters or digits in its name, naming the cause', async () => {
    using repo = tempRepo('factory-headless-noname-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    await assert.rejects(Promise.resolve(command('headless .md')), /Cannot name a run after "\.md"/);
    assert.deepEqual(sent, []);
  });
});
