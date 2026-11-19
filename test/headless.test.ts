import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { forgetRun, readRun, runDir, statePath } from '../src/run.ts';
import { loadSource } from '../src/gates.ts';
import { resetModuleState } from '../src/index.ts';
import { headlessTarget } from '../src/workflow.ts';
import { issueGh, prependPath, tempDir, tempRepo } from './helpers.ts';

const CHECKS_OK = { '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }), 'ticket.md': '# Add the widget\n\nBuild it.\n' };

beforeEach(() => resetModuleState());

const SOURCE = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' };

function session(root: string) {
  const sent: string[] = [];
  const sentOptions: unknown[] = [];
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent, sentOptions });
  const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, notify() {} } };
  const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
  return { call, command: (args: string) => commands.get('factory')?.handler(args, main), sent, sentOptions };
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

  it('sends the headless, resume and plain /factory continuations as an agent steer, the only form omp -p dispatches', async () => {
    using repo = tempRepo('factory-headless-cmd-', CHECKS_OK);
    const { command, sent, sentOptions } = session(repo.root);
    await command('headless ticket.md');
    await command('resume ticket');
    await command('some pasted issue');
    assert.equal(sent.length, 3);
    assert.deepEqual(sentOptions, Array(3).fill({ attribution: 'agent', deliverAs: 'steer' }));
  });

  it('names a GitHub issue run issue-<n> from the number, with or without #', async () => {
    const issue = { author: { login: 'owner' }, body: 'Do it', comments: [], title: 'Demo', url: 'https://github.com/o/r/issues/102' };
    using _gh = issueGh({ issues: { 102: issue } });
    for (const ref of ['#102', '102']) {
      using repo = tempRepo('factory-headless-gh-', CHECKS_OK);
      resetModuleState();
      await session(repo.root).command(`headless ${ref}`);
      const ws = { config: loadConfig(repo.root), root: repo.root };
      assert.equal(readRun(ws, 'issue-102').mode, 'headless', ref);
    }
  });

  it('starts a headless run covering the related issues, leaving out cross-repo text', async () => {
    const mk = (n: string, url: string) => ({ author: { login: 'owner' }, body: `Text ${n}.`, comments: [{ author: { login: 'maint' }, authorAssociation: 'MEMBER', body: `Comment ${n}.` }], title: `Title ${n}`, url });
    const issues = { 1: mk('1', 'https://github.com/o/r/issues/1'), 2: mk('2', 'https://github.com/o/r/issues/2'), 900: mk('900', 'https://github.com/evil/other/issues/900') };
    using _gh = issueGh({ issues, owners: ['*/1', '*/900', '*/2'] });
    using repo = tempRepo('factory-headless-related-', CHECKS_OK);
    const { command } = session(repo.root);
    await command('headless 1 --related #2,900');
    const run = readRun({ config: loadConfig(repo.root), root: repo.root }, 'issue-1');
    assert.equal(run.mode, 'headless');
    assert.deepEqual(run.source.related?.map(item => item.ref), ['2', '900']);
    assert.match(run.source.body, /Text 2\./);
    assert.doesNotMatch(run.source.body, /Text 900\.|Comment 900\./);
  });

  it('refuses more than 20 --related refs before a run starts', async () => {
    const mk = (n: number) => ({ author: { login: 'owner' }, body: `Text ${n}.`, comments: [], title: `Title ${n}`, url: `https://github.com/o/r/issues/${n}` });
    const issues = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, mk(i + 1)]).concat([[294, mk(294)]]));
    using _gh = issueGh({ issues, owners: ['*'] });
    using repo = tempRepo('factory-headless-many-', CHECKS_OK);
    const { command, sent } = session(repo.root);
    const refs = Array.from({ length: 21 }, (_, i) => String(i + 1)).join(',');
    await assert.rejects(Promise.resolve(command(`headless 294 --related ${refs}`)), /--related takes at most 20 issue refs \(the limit is 20\)/);
    assert.deepEqual(sent, []);
    assert.equal(existsSync(statePath({ config: loadConfig(repo.root), root: repo.root }, 'issue-294')), false);
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

describe('factory_start with related issues', () => {
  const issues: Record<string, unknown> = {
    '126': {
      author: { login: 'stranger' },
      body: `Related text. ${'long '.repeat(400)}END-OF-RELATED`,
      comments: [
        { author: { login: 'maintainer' }, authorAssociation: 'MEMBER', body: 'Related trusted comment.' },
        { author: { login: 'passerby' }, authorAssociation: 'NONE', body: 'Related outside comment.' },
      ],
      title: 'Related',
      url: 'https://github.com/o/r/issues/126',
    },
    '242': {
      author: { login: 'owner' },
      body: 'Primary text.',
      comments: [{ author: { login: 'drive-by' }, authorAssociation: 'NONE', body: 'Primary outside comment.' }],
      title: 'Primary',
      url: 'https://github.com/o/r/issues/242',
    },
  };

  /** A fake gh on PATH: issue 242 is by an owner, 126 by a stranger. */
  const fakeGh = () => issueGh({ issues, owners: ['*/242', '*/900'] });

  function asking(root: string, answer: boolean) {
    const asked: string[] = [];
    const tools = load({ commands: new Map(), sent: [], sentOptions: [] });
    const main = {
      ...ctx('main', 'main'),
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => 'session' },
      ui: { confirm: async (_title: string, body: string) => (asked.push(body), answer), notify() {} },
    };
    const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
    return { asked, call };
  }

  for (const answer of [true, false]) {
    it(`asks once for outside text across both issues, grouped by issue, and ${answer ? 'keeps' : 'leaves out'} all of it`, async () => {
      using _gh = fakeGh();
      using repo = tempRepo('factory-gh-related-', CHECKS_OK);
      const { asked, call } = asking(repo.root, answer);
      const status = await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '242', related: ['126'] } });
      assert.equal(asked.length, 1);
      assert.match(asked[0] ?? '', /Issue 242 \(Primary\)[\s\S]*Primary outside comment[\s\S]*Issue 126 \(Related\)[\s\S]*@stranger[\s\S]*truncated[\s\S]*Related outside comment/);
      assert.match(asked[0] ?? '', /END-OF-RELATED/);
      assert.doesNotMatch(asked[0] ?? '', /Related trusted comment/);
      const ws = { config: loadConfig(repo.root), root: repo.root };
      const run = readRun(ws, 'demo');
      assert.match(run.source.body, /Primary text\./);
      assert.equal(/Primary outside comment/.test(run.source.body), answer);
      assert.equal(/Related text\./.test(run.source.body), answer);
      assert.equal(/Related outside comment\./.test(run.source.body), answer);
      assert.match(run.source.body, /Related trusted comment\./);
      assert.deepEqual(run.source.related, [{ ref: '126', title: answer ? 'Related' : 'GitHub issue 126', url: 'https://github.com/o/r/issues/126' }]);
      assert.equal(run.source.ref, '242');
      const issueMd = readFileSync(join(runDir(ws, 'demo'), 'issue.md'), 'utf8');
      assert.match(issueMd, /Source: github 242 \(https:\/\/github.com\/o\/r\/issues\/242\)\nSource: github 126 \(https:\/\/github.com\/o\/r\/issues\/126\)\n/);
      assert.match(status, /126/);
      const reply = JSON.parse(await call('factory_status', {})) as { content: { text: string }[] };
      const summary = JSON.parse(reply.content[0]?.text ?? '{}') as { source: { related: unknown } };
      assert.deepEqual(summary.source.related, [{ ref: '126', title: answer ? 'Related' : 'GitHub issue 126', url: 'https://github.com/o/r/issues/126' }]);
    });
  }

  it('a headless load leaves out all outside text and records the autonomous note', async () => {
    using _gh = fakeGh();
    using repo = tempRepo('factory-gh-related-headless-', CHECKS_OK);
    const ws = { config: loadConfig(repo.root), root: repo.root };
    const { notes, source } = await loadSource(ctx('main', 'main') as never, ws, { kind: 'github', ref: '242', related: ['126'] }, 'headless');
    assert.doesNotMatch(source.body, /outside comment|Related text/);
    assert.match(source.body, /Related trusted comment\./);
    assert.match(source.body, /Primary text\./);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /@drive-by, @stranger/);
  });

  it('a github source without related keeps the same state shape', async () => {
    using _gh = fakeGh();
    using repo = tempRepo('factory-gh-norelated-', CHECKS_OK);
    const { call } = asking(repo.root, true);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '242' } });
    const ws = { config: loadConfig(repo.root), root: repo.root };
    assert.equal('related' in readRun(ws, 'demo').source, false);
    assert.match(readFileSync(join(runDir(ws, 'demo'), 'issue.md'), 'utf8'), /^# Primary\n\nSource: github 242 \(https:\/\/github.com\/o\/r\/issues\/242\)\n\n/);
  });
});

describe('factory_start related issue hardening', () => {
  const make = (n: string, url: string, over: Record<string, unknown> = {}) => ({ author: { login: `user${n}` }, body: `Text ${n}.`, comments: [], title: `Title ${n}`, url, ...over });
  function asking(root: string, answer: boolean) {
    const asked: string[] = [];
    const tools = load({ commands: new Map(), sent: [], sentOptions: [] });
    const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async (_t: string, body: string) => (asked.push(body), answer), notify() {} } };
    const call = async (name: string, params: unknown) => JSON.stringify(await tools.get(name)?.execute('id', params, undefined, undefined, main));
    return { asked, call };
  }
  const base = make('1', 'https://github.com/o/r/issues/1');
  const owners = ['*/1', '*/900', '*/2'];

  for (const answer of [true, false]) {
    it(`treats a related issue from another repo as outside text even when its author is OWNER there (${answer ? 'approved' : 'declined'})`, async () => {
      const issues = { 1: base, 900: make('900', 'https://github.com/evil/other/issues/900', { comments: [{ author: { login: 'maint' }, authorAssociation: 'MEMBER', body: 'Comment 900.' }] }) };
      using _gh = issueGh({ issues, owners });
      using repo = tempRepo('factory-gh-cross-', CHECKS_OK);
      const { asked, call } = asking(repo.root, answer);
      await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['900'] } });
      assert.equal(asked.length, 1);
      assert.match(asked[0] ?? '', /Issue 900[\s\S]*Text 900\.[\s\S]*Comment 900\./);
      const run = readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo');
      assert.equal(/Text 900\./.test(run.source.body), answer);
      assert.equal(/Comment 900\./.test(run.source.body), answer);
    });
  }

  it('leaves out a cross-repo related issue and its OWNER/MEMBER comment in headless mode', async () => {
    const issues = { 1: base, 900: make('900', 'https://github.com/evil/other/issues/900', { comments: [{ author: { login: 'maint' }, authorAssociation: 'MEMBER', body: 'Comment 900.' }] }) };
    using _gh = issueGh({ issues, owners });
    using repo = tempRepo('factory-gh-cross-headless-', CHECKS_OK);
    const ws = { config: loadConfig(repo.root), root: repo.root };
    const { source } = await loadSource(ctx('main', 'main') as never, ws, { kind: 'github', ref: '1', related: ['900'] }, 'headless');
    assert.doesNotMatch(source.body, /Text 900\.|Comment 900\./);
  });

  it('keeps an OWNER-authored primary issue from another repo with no dialog, interactive and headless', async () => {
    const issues = { 900: make('900', 'https://github.com/evil/other/issues/900') };
    using _gh = issueGh({ issues, owners: ['*/900'] });
    using repo = tempRepo('factory-gh-primary-', CHECKS_OK);
    const { asked, call } = asking(repo.root, false);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '900' } });
    assert.equal(asked.length, 0);
    assert.match(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').source.body, /Text 900\./);
    const ws = { config: loadConfig(repo.root), root: repo.root };
    const { notes, source } = await loadSource(ctx('main', 'main') as never, ws, { kind: 'github', ref: '900' }, 'headless');
    assert.match(source.body, /Text 900\./);
    assert.deepEqual(notes, []);
  });

  it('keeps the primary but asks about a related issue when the working repo cannot be identified', async () => {
    const issues = { 1: base, 2: make('2', 'https://github.com/o/r/issues/2') };
    using _gh = issueGh({ issues, owners: ['*/1', '*/2'], repoView: 'exit 1' });
    using repo = tempRepo('factory-gh-norepo-', CHECKS_OK);
    const { asked, call } = asking(repo.root, false);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['2'] } });
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', /Issue 2[\s\S]*Text 2\./);
    const body = readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').source.body;
    assert.match(body, /Text 1\./);
    assert.doesNotMatch(body, /Text 2\./);
  });

  it('caps each outside part in the dialog at 1,000 characters, says how many are not shown, keeps the full approved text, and redacts the issue title in the header', async () => {
    const full = `${'a'.repeat(1_400)}MIDDLE-MARK${'z'.repeat(1_400)}`;
    const issues = { 1: base, 777: make('777', 'https://github.com/o/r/issues/777', { body: full, title: 'Leaks ghp_abcdefghijklmnopqrstuvwxyz0123456789' }) };
    using _gh = issueGh({ issues, owners });
    using repo = tempRepo('factory-gh-cap-', CHECKS_OK);
    const { asked, call } = asking(repo.root, true);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['777'] } });
    assert.doesNotMatch(asked[0] ?? '', /MIDDLE-MARK/);
    assert.doesNotMatch(asked[0] ?? '', /ghp_abcdefghij/);
    assert.match(asked[0] ?? '', /Issue 777 \(Leaks <REDACTED>/);
    // The part is `${redacted title}\n\n${body}`: 'Leaks <REDACTED>' (16) + 2 + 2,811 = 2,829 characters, so 1,829 are hidden and the last 1,000 (all 'z') are shown.
    assert.deepEqual((asked[0] ?? '').match(/z+/g), ['z'.repeat(1_000)]);
    assert.match(asked[0] ?? '', /\[1829 characters not shown\]/);
    const run = readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo');
    assert.ok(run.source.body.includes(full));
  });

  it('uses the repo gh resolves, not origin, as the working repo: an OWNER related issue in the upstream repo needs no dialog', async () => {
    const issues = { 1: base, 2: make('2', 'https://github.com/o/r/issues/2') };
    using _gh = issueGh({ issues, owners });
    using repo = tempRepo('factory-gh-fork-', CHECKS_OK);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fork/r.git'], { cwd: repo.root });
    const { asked, call } = asking(repo.root, false);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['2'] } });
    assert.equal(asked.length, 0);
    assert.match(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').source.body, /Text 2\./);
  });

  it('falls back to the origin remote as the working repo when gh repo view fails: an OWNER related issue there needs no dialog', async () => {
    const issues = { 1: base, 2: make('2', 'https://github.com/o/r/issues/2') };
    using _gh = issueGh({ issues, owners, repoView: 'exit 1' });
    using repo = tempRepo('factory-gh-origin-', CHECKS_OK);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo.root });
    const { asked, call } = asking(repo.root, false);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['2'] } });
    assert.equal(asked.length, 0);
    assert.match(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').source.body, /Text 2\./);
  });

  it('looks up the working repo (gh repo view or git remote) only when there are related issues', async () => {
    using log = tempDir('factory-gh-log-');
    using gitBin = tempDir('factory-fake-git-');
    const file = join(log.root, 'repo-calls');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(gitBin.root, 'git'), `#!/bin/sh\nif [ "$1" = remote ] && [ "$2" = get-url ]; then echo git >> ${file}; fi\nexec ${realGit} "$@"\n`);
    chmodSync(join(gitBin.root, 'git'), 0o755);
    const issues = { 1: base, 2: make('2', 'https://github.com/o/r/issues/2') };
    using _gh = issueGh({ issues, owners, repoView: `echo gh >> ${file}; exit 1` });
    using _git = prependPath(gitBin.root);
    using repo = tempRepo('factory-gh-nolookup-', CHECKS_OK);
    const { call } = asking(repo.root, true);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1' } });
    assert.equal(readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo').source.ref, '1');
    assert.equal(existsSync(file), false);
    await call('factory_start', { feature: 'demo-related', source: { kind: 'github', ref: '1', related: ['2'] } });
    const lookups = readFileSync(file, 'utf8');
    assert.match(lookups, /gh/);
    assert.match(lookups, /git/);
  });

  it('loads an issue once when related repeats the primary or an earlier related entry, even by URL', async () => {
    const issues = { 1: make('1', 'https://github.com/o/r/issues/1', { author: { login: 'owner1' } }), 2: make('2', 'https://github.com/o/r/issues/2', { author: { login: 'stranger' } }) };
    using _gh = issueGh({ issues, owners: ['*/1'] });
    using repo = tempRepo('factory-gh-dup-', CHECKS_OK);
    const { asked, call } = asking(repo.root, true);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['1', '2', '2', 'https://github.com/o/r/issues/2'] } });
    assert.equal(asked.length, 1);
    assert.equal((asked[0] ?? '').match(/Issue 2 /g)?.length, 1);
    assert.doesNotMatch(asked[0] ?? '', /Issue 1 /);
    const run = readRun({ config: loadConfig(repo.root), root: repo.root }, 'demo');
    assert.equal(run.source.body.match(/Text 2\./g)?.length, 1);
    assert.equal(run.source.body.match(/## Related issue/g)?.length, 1);
    assert.equal(run.source.related?.length, 1);
  });

  it('runs gh issue view once per distinct ref when related repeats the primary ref', async () => {
    using gh = issueGh({ issues: { 1: base, 2: make('2', 'https://github.com/o/r/issues/2') }, owners });
    using repo = tempRepo('factory-gh-once-', CHECKS_OK);
    const { call } = asking(repo.root, true);
    await call('factory_start', { feature: 'demo', source: { kind: 'github', ref: '1', related: ['1', '1', '2', '2'] } });
    assert.deepEqual(gh.viewed().sort(), ['1', '2']);
  });

  it('rejects more than 20 related refs, and related on file, jira and text sources, but starts a run with exactly 20', async () => {
    const issues = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, make(String(i + 1), `https://github.com/o/r/issues/${i + 1}`)]));
    using _gh = issueGh({ issues });
    using repo = tempRepo('factory-related-schema-', CHECKS_OK);
    const { call } = session(repo.root);
    const outcome = (source: unknown) => call('factory_start', { feature: 'demo', source }).catch(error => String(error));
    const refs = (count: number) => Array.from({ length: count }, (_, i) => String(i + 2));
    assert.match(await outcome({ kind: 'github', ref: '1', related: refs(21) }), /too[ _]big|at most 20|<=\s*20|maximum/i);
    assert.match(await outcome({ kind: 'file', ref: 'ticket.md', related: ['2'] }), /`related` is only for github sources/);
    assert.match(await outcome({ ...SOURCE, kind: 'text', related: [{ ref: '9', title: 'x' }] }), /`related` is only for github sources/);
    assert.match(await outcome({ ...SOURCE, kind: 'jira', related: [{ ref: '9', title: 'x' }] }), /`related` is only for github sources/);
    assert.match(await outcome({ kind: 'github', ref: '1', related: refs(20) }), /Run \\"demo\\"/);
  });
});

describe('headlessTarget', () => {
  it('keeps a GitHub issue URL as the ref and names the run after its number', () => {
    assert.deepEqual(headlessTarget('https://github.com/o/r/issues/102'), { feature: 'issue-102', source: { kind: 'github', ref: 'https://github.com/o/r/issues/102' } });
  });

  it('gives a bare or #-prefixed number as the ref', () => {
    assert.deepEqual(headlessTarget('#102'), { feature: 'issue-102', source: { kind: 'github', ref: '102' } });
    assert.deepEqual(headlessTarget('102'), { feature: 'issue-102', source: { kind: 'github', ref: '102' } });
  });

  it('names a file run after its file name in kebab-case, and keeps the path as the ref', () => {
    assert.deepEqual(headlessTarget('docs/My Ticket.md'), { feature: 'my-ticket', source: { kind: 'file', ref: 'docs/My Ticket.md' } });
  });

  it('cuts a long file name to 48 characters without a trailing dash', () => {
    const { feature } = headlessTarget(`${'a'.repeat(47)} ${'b'.repeat(20)}.md`);
    assert.equal(feature, 'a'.repeat(47));
  });

  it('takes --related refs as source.related: numbers, #numbers and URLs', () => {
    assert.deepEqual(headlessTarget('294 --related 260,#285,https://github.com/o/r/issues/209'), {
      feature: 'issue-294',
      source: { kind: 'github', ref: '294', related: ['260', '285', 'https://github.com/o/r/issues/209'] },
    });
  });

  it('keeps related issue URLs with a trailing slash, query or fragment as given', () => {
    const urls = ['https://github.com/o/r/issues/209/', 'https://github.com/o/r/issues/209#issuecomment-1', 'https://github.com/o/r/issues/209?x=1'];
    assert.deepEqual(headlessTarget(`294 --related ${urls.join(',')}`).source, { kind: 'github', ref: '294', related: urls });
    assert.throws(() => headlessTarget('294 --related https://github.com/o?x/issues/209'), /--related/);
  });

  it('refuses invalid --related input', () => {
    assert.throws(() => headlessTarget('ticket.md --related 260'), /GitHub issue as the primary/);
    assert.throws(() => headlessTarget('294 --related'), /--related needs a value/);
    assert.throws(() => headlessTarget('294 --related 260,,285'), /empty item/);
    assert.throws(() => headlessTarget('294 --related abc'), /"abc" is not one/);
  });
});
