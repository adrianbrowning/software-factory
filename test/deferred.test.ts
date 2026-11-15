import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig, parseConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, withRun, type Workspace } from '../src/run.ts';
import { recordReview, renderFinding, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, newRun, review, sh, slice, step, tempDir, tempRepo, workspace } from './helpers.ts';

beforeEach(() => resetModuleState());

const CHECKS_OK = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
type Reply = { content: { text: string }[] };

/** A fake `gh` first on PATH that logs each call, prints an issue URL numbered by the call, and fails the call whose number is in `fail`. */
function fakeGh() {
  const dir = tempDir('factory-defer-gh-');
  const log = join(dir.root, 'calls.log');
  const fail = join(dir.root, 'fail');
  const garble = join(dir.root, 'garble');
  writeFileSync(
    join(dir.root, 'gh'),
    `#!/bin/sh\nif [ "$1 $2" != 'issue create' ]; then exit 0; fi\necho "$1 $2 $3 $4" >> '${log}'\necho "$@" >> '${join(dir.root, 'args.log')}'\nn=$(wc -l < '${log}' | tr -d ' ')\nif [ -f '${fail}' ] && [ "$n" = "$(cat '${fail}')" ]; then echo 'HTTP 502' >&2; exit 1; fi\nif [ -f '${garble}' ]; then echo 'created'; exit 0; fi\necho "https://github.com/o/r/issues/$n"\n`,
  );
  chmodSync(join(dir.root, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir.root}:${path}`;
  return {
    args: () => (existsSync(join(dir.root, 'args.log')) ? readFileSync(join(dir.root, 'args.log'), 'utf8') : ''),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    failOn: (n: number) => writeFileSync(fail, String(n)),
    healed: () => writeFileSync(fail, '0'),
    garbled: () => writeFileSync(garble, ''),
    ungarbled: () => rmSync(garble),
    [Symbol.dispose]: () => {
      process.env.PATH = path;
      dir[Symbol.dispose]();
    },
  };
}

/**
 * A headless run with the deferred sink `deferred` and slice 01 active with a committed change (`active`), or with a green
 * review listing two observations, thermo-naming and thermo-style (`green`). `interactive` turns the run interactive,
 * with a confirm dialog that answers `answer` and logs its title to `asked`.
 */
async function sinkRun(root: string, deferred: unknown, stage: 'active' | 'green' = 'green', interactive?: { answer: boolean; asked: string[] }) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], ...(deferred === undefined ? {} : { deferred }) }));
  sh(root, 'commit', '-qam', 'config', '--allow-empty');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async (title: string, body: string) => {
    if (interactive === undefined) throw new Error(`headless run asked a dialog: ${title}`);
    interactive.asked.push(`${title}\n${body}`);
    return interactive.answer;
  }, notify() {}, select: async () => undefined } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  if (interactive !== undefined) await withRun(ws, 'demo', run => void (run.mode = 'interactive'));
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature'), slice('Second')])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  if (stage === 'green') {
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [finding('thermo', 'observation', 'naming'), finding('thermo', 'observation', 'style')]);
    await withRun(ws, 'demo', run => recordReview(ws, run));
  }
  return { call, ws };
}

const text = (reply: Reply) => reply.content[0]?.text ?? '';

describe('deferred config', () => {
  it('parses a file sink with a default path, a file sink with a path, and a github sink', () => {
    assert.deepEqual(parseConfig({ deferred: { kind: 'file' } }).deferred, { kind: 'file', path: 'docs/factory-deferred.md' });
    assert.deepEqual(parseConfig({ deferred: { kind: 'file', path: 'notes/later.md' } }).deferred, { kind: 'file', path: 'notes/later.md' });
    assert.deepEqual(parseConfig({ deferred: { kind: 'github' } }).deferred, { kind: 'github' });
    assert.equal(parseConfig({}).deferred, undefined);
  });

  it('refuses other shapes', () => {
    for (const bad of [{ kind: 'jira' }, { kind: 'github', path: 'x.md' }, { kind: 'file', extra: 1 }, 'file', { kind: 'file', path: '/etc/x' }, { kind: 'file', path: '../x.md' }, {}]) {
      assert.throws(() => parseConfig({ deferred: bad }), /deferred/, JSON.stringify(bad));
    }
  });
});

describe('factory_defer', () => {
  it('github: files one issue per observation and note, naming run, slice and review, and stores each URL', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'github' });
    const reply = await call('factory_defer', { note: 'Log the parse time.', observations: ['thermo-naming', 'thermo-style'] });
    assert.equal(gh.calls().length, 3);
    assert.ok(gh.calls().every(line => line.startsWith('issue create ')));
    const items = readRun(ws, 'demo').deferred;
    assert.deepEqual(items.map(item => item.location), ['https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2', 'https://github.com/o/r/issues/3']);
    assert.deepEqual(items.map(item => item.id), [undefined, 'thermo-naming', 'thermo-style']);
    for (const item of items) {
      assert.match(item.body, /Run: demo/);
      assert.match(item.body, /Slice: 01/);
      assert.match(item.body, /Review: 01-r1/);
    }
    assert.match(text(reply), /issues\/1[\s\S]*issues\/3/);
  });

  it('file: queues items on the run without calling gh or writing the file', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'file' });
    await call('factory_defer', { observations: ['thermo-naming'] });
    assert.deepEqual(gh.calls(), []);
    assert.equal(existsSync(join(repo.root, 'docs/factory-deferred.md')), false);
    const [item] = readRun(ws, 'demo').deferred;
    assert.equal(item?.id, 'thermo-naming');
    assert.equal(item?.location, 'docs/factory-deferred.md');
    assert.match(item?.body ?? '', /Review: 01-r1/);
  });

  for (const [name, sink, location] of [['file', { kind: 'file' }, 'docs/factory-deferred.md'], ['github', { kind: 'github' }, 'https://github.com/o/r/issues/']] as const) {
    it(`${name}: a note alone adds one note item naming run, slice and review, and a repeat adds a second`, async () => {
      using gh = fakeGh();
      using repo = tempRepo('factory-defer-', CHECKS_OK);
      const { call, ws } = await sinkRun(repo.root, sink);
      await call('factory_defer', { note: 'Log the parse time.' });
      const items = readRun(ws, 'demo').deferred;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.kind, 'note');
      assert.equal(items[0]?.id, undefined);
      assert.ok(items[0]?.location.startsWith(location));
      assert.match(items[0]?.body ?? '', /Run: demo/);
      assert.match(items[0]?.body ?? '', /Slice: 01/);
      assert.match(items[0]?.body ?? '', /Review: 01-r1/);
      assert.equal(gh.calls().length, name === 'github' ? 1 : 0);
      await call('factory_defer', { note: 'Log the parse time.' });
      const after = readRun(ws, 'demo').deferred;
      assert.equal(after.length, 2);
      assert.equal(after[1]?.key, '01-r1:note:2');
    });
  }

  it('refuses unknown ids, ids already deferred, ids already carried, a call with nothing, and a project without a sink', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'file' });
    await assert.rejects(call('factory_defer', { observations: ['thermo-made-up'] }), /thermo-made-up/);
    await assert.rejects(call('factory_defer', {}), /observation ids, a note, or both/);
    await call('factory_defer', { observations: ['thermo-naming'] });
    await assert.rejects(call('factory_defer', { observations: ['thermo-naming'] }), /already deferred: thermo-naming/);
    await call('factory_carry', { observations: ['thermo-style'], to: 'end' });
    await assert.rejects(call('factory_defer', { observations: ['thermo-style'] }), /already carried: thermo-style/);
    assert.equal(readRun(ws, 'demo').deferred.length, 1);
    await assert.rejects(call('factory_carry', { observations: ['thermo-naming'], to: 'end' }), /already deferred: thermo-naming/);

    using other = tempRepo('factory-defer-none-', CHECKS_OK);
    const none = await sinkRun(other.root, undefined);
    await assert.rejects(none.call('factory_defer', { observations: ['thermo-naming'] }), /deferred/);
  });

  it('interactive: asks the user with the items and sink, then files; a declined dialog files and records nothing', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const asked: string[] = [];
    const yes = await sinkRun(repo.root, { kind: 'github' }, 'green', { answer: true, asked });
    await yes.call('factory_defer', { observations: ['thermo-naming'] });
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', /Defer 1 items[\s\S]*thermo-naming[\s\S]*gh issue create/);
    assert.equal(gh.calls().length, 1);
    assert.equal(readRun(yes.ws, 'demo').deferred.length, 1);

    using other = tempRepo('factory-defer-no-', CHECKS_OK);
    const declined: string[] = [];
    const no = await sinkRun(other.root, { kind: 'github' }, 'green', { answer: false, asked: declined });
    const reply = await no.call('factory_defer', { observations: ['thermo-naming'] });
    assert.equal(declined.length, 1);
    assert.match(text(reply), /did not defer/);
    assert.equal(gh.calls().length, 1);
    assert.deepEqual(readRun(no.ws, 'demo').deferred, []);
  });

  it('interactive file sink: asks with the items and the sink path; confirmed queues, declined records nothing', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const asked: string[] = [];
    const yes = await sinkRun(repo.root, { kind: 'file', path: 'notes/later.md' }, 'green', { answer: true, asked });
    await yes.call('factory_defer', { observations: ['thermo-naming'] });
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', /Defer 1 items[\s\S]*thermo-naming[\s\S]*notes\/later\.md/);
    assert.deepEqual(readRun(yes.ws, 'demo').deferred.map(item => item.id), ['thermo-naming']);

    using other = tempRepo('factory-defer-no-', CHECKS_OK);
    const declined: string[] = [];
    const no = await sinkRun(other.root, { kind: 'file' }, 'green', { answer: false, asked: declined });
    const reply = await no.call('factory_defer', { observations: ['thermo-naming'] });
    assert.equal(declined.length, 1);
    assert.match(text(reply), /did not defer/);
    assert.deepEqual(readRun(no.ws, 'demo').deferred, []);
  });

  for (const [name, sink, offered] of [['with a sink', { kind: 'file' }, true], ['without a sink', undefined, false]] as const) {
    it(`green review reply ${offered ? 'offers' : 'omits'} factory_defer ${name}`, async () => {
      using repo = tempRepo('factory-defer-', CHECKS_OK);
      const { call, ws } = await sinkRun(repo.root, sink, 'active');
      await withRun(ws, 'demo', run => runChecks(ws, run));
      const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
      await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
      const reply = text(await call('factory_review_record', {}));
      assert.match(reply, /Review is green/);
      assert.equal(/factory_defer/.test(reply), offered);
      if (!offered) assert.match(reply, /, or queued for one follow-up slice/);
    });
  }

  it('factory_fix refuses observations already deferred or carried', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'file' });
    await call('factory_defer', { observations: ['thermo-naming'] });
    await call('factory_carry', { observations: ['thermo-style'], to: 'end' });
    await assert.rejects(call('factory_fix', { observations: ['thermo-naming'], reason: 'tidy' }), /already deferred: thermo-naming/);
    await assert.rejects(call('factory_fix', { observations: ['thermo-style'], reason: 'tidy' }), /already carried: thermo-style/);
    assert.equal(readRun(ws, 'demo').slices[0]?.fixRounds, 0);
  });

  it('github: a failed issue keeps the URLs already filed and files only the rest on the retry', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'github' });
    gh.failOn(2);
    await assert.rejects(call('factory_defer', { observations: ['thermo-naming', 'thermo-style'] }), /HTTP 502[\s\S]*only the rest: thermo-style/);
    assert.deepEqual(readRun(ws, 'demo').deferred.map(item => item.id), ['thermo-naming']);
    gh.healed();
    await call('factory_defer', { observations: ['thermo-style'] });
    assert.deepEqual(readRun(ws, 'demo').deferred.map(item => item.id), ['thermo-naming', 'thermo-style']);
    assert.equal(gh.calls().length, 3);
  });

  it('github: a success without an issue URL is a failure, nothing is recorded, and the item can be sent again', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await sinkRun(repo.root, { kind: 'github' });
    gh.garbled();
    await assert.rejects(call('factory_defer', { observations: ['thermo-naming'] }), /did not print an issue URL: created/);
    assert.deepEqual(readRun(ws, 'demo').deferred, []);
    gh.ungarbled();
    await call('factory_defer', { observations: ['thermo-naming'] });
    const items = readRun(ws, 'demo').deferred;
    assert.equal(items.length, 1);
    assert.ok(items[0]?.location.startsWith('https://github.com/o/r/issues/'));
  });

  it('factory_status lists the deferred items with their sink locations', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call } = await sinkRun(repo.root, { kind: 'file', path: 'notes/later.md' });
    await call('factory_defer', { observations: ['thermo-naming'] });
    const status = JSON.parse(text(await call('factory_status', {}))) as { deferred: { id: string; location: string; review: string; slice: string }[] };
    assert.deepEqual(status.deferred.map(({ id, location, review, slice }) => ({ id, location, review, slice })), [
      { id: 'thermo-naming', location: 'notes/later.md', review: '01-r1', slice: '01' },
    ]);
  });
});

describe('accepted unresolved findings go to the sink', () => {
  /**
   * Spends the three fix rounds, then leaves a fourth review with two blocking findings written but not recorded, for the
   * test to record; `decision` first records one that finding "a" breaks. `leak` is the title of finding "b" in the first
   * three rounds; the fourth review then leaves its fix item open instead of blocking on it.
   */
  async function fourthReview(root: string, deferred: unknown, decision?: string, leak?: string) {
    const run = await sinkRun(root, deferred, 'active');
    if (decision !== undefined) await run.call('factory_decide', { decisions: [decision] });
    const blocked = async (file: string, last = false) => {
      commit(run.ws, file);
      await withRun(run.ws, 'demo', current => runChecks(run.ws, current));
      const { reviewId } = await withRun(run.ws, 'demo', current => startReview(run.ws, current));
      const a = { ...finding('thermo', 'high', 'a'), ...(decision === undefined ? {} : { decision: 1 }) };
      const b = { ...finding('bug', 'high', last && leak !== undefined ? 'c' : 'b'), ...(leak === undefined || last ? {} : { title: leak }) };
      const verdicts = last && leak !== undefined ? [{ id: 'thermo-a', reason: 'fixed', status: 'fixed' as const }, { id: 'bug-b', reason: 'still broken', status: 'open' as const }] : undefined;
      await review(run.ws, reviewId, [a, b], undefined, verdicts);
    };
    for (const file of ['one', 'two', 'three']) {
      await blocked(file);
      await run.call('factory_review_record', {});
    }
    await blocked('four', true);
    return run;
  }

  it('github: a secret in a decision a finding breaks reaches neither the run nor gh', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const secret = `ghp_${'a'.repeat(30)}`;
    const { call, ws } = await fourthReview(repo.root, { kind: 'github' }, `Use token ${secret} for the API`);
    await call('factory_review_record', {});
    const run = readRun(ws, 'demo');
    assert.ok(run.deferred.some(item => item.body.includes('Breaks decision 1')));
    assert.ok(run.deferred.every(item => !item.body.includes(secret)));
    assert.ok(gh.args().includes('Breaks decision 1'));
    assert.ok(!gh.args().includes(secret));
  });

  it('github: a secret in an open fix item summary reaches neither the run nor gh', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const secret = `ghp_${'b'.repeat(30)}`;
    const { call, ws } = await fourthReview(repo.root, { kind: 'github' }, undefined, `leaks ${secret}`);
    await call('factory_review_record', {});
    const run = readRun(ws, 'demo');
    assert.ok(run.deferred.some(item => item.id === 'bug-b' && item.body.includes('Scope reviewer: still broken') && item.body.includes('leaks <REDACTED>')));
    assert.ok(run.deferred.every(item => !item.body.includes(secret) && !item.title.includes(secret)));
    assert.ok(!gh.args().includes(secret));
  });

  it('github: files one issue per open finding by itself when the review is accepted unresolved', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await fourthReview(repo.root, { kind: 'github' });
    const before = gh.calls().length;
    assert.equal(before, 0);
    await call('factory_review_record', {});
    assert.equal(gh.calls().length, 2);
    const run = readRun(ws, 'demo');
    assert.ok(run.slices[0]?.unresolved);
    assert.deepEqual(run.deferred.map(item => item.id).toSorted(), ['bug-b', 'thermo-a']);
    assert.ok(run.deferred.every(item => item.kind === 'unresolved' && item.location.startsWith('https://github.com/o/r/issues/') && item.body.includes('Review: 01-r4')));
  });

  it('file: queues them on the run', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await fourthReview(repo.root, { kind: 'file' });
    await call('factory_review_record', {});
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.deferred.map(item => item.location), ['docs/factory-deferred.md', 'docs/factory-deferred.md']);
  });

  it('github: does not accept the slice while an issue fails, keeps the filed URL, and the retry files only the rest', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await fourthReview(repo.root, { kind: 'github' });
    gh.failOn(2);
    await assert.rejects(call('factory_review_record', {}), /HTTP 502/);
    const failed = readRun(ws, 'demo');
    assert.equal(failed.slices[0]?.phase, 'review');
    assert.equal(failed.slices[0]?.unresolved, undefined);
    assert.equal(failed.deferred.length, 1);
    gh.healed();
    await call('factory_review_record', {});
    const run = readRun(ws, 'demo');
    assert.equal(run.slices[0]?.phase, 'ready');
    assert.ok(run.slices[0]?.unresolved);
    assert.equal(run.deferred.length, 2);
    assert.equal(gh.calls().length, 3);
    assert.equal(run.events.filter(event => event.kind === 'review-blocking' && event.slice === '01' && event.detail.startsWith('01-r4 ')).length, 1);
  });

  it('without a sink the review is accepted as before and nothing is deferred', async () => {
    using repo = tempRepo('factory-defer-', CHECKS_OK);
    const { call, ws } = await fourthReview(repo.root, undefined);
    await call('factory_review_record', {});
    const run = readRun(ws, 'demo');
    assert.ok(run.slices[0]?.unresolved);
    assert.deepEqual(run.deferred, []);
  });
});

describe('redaction in rendered findings and open fix items', () => {
  const secret = `ghp_${'c'.repeat(30)}`;

  it('renderFinding leaves a credential in the decision a finding breaks out of its text', () => {
    const broken = { ...finding('thermo', 'high', 'a'), decision: 1 };
    const rendered = renderFinding(broken, [{ author: 'user', text: `Use token ${secret} for the API` }], '###');
    assert.match(rendered, /- Breaks decision 1: Use token <REDACTED> for the API/);
    assert.ok(!rendered.includes(secret));
  });

  it('the fix file section of an open fix item holds its summary with a credential redacted', async () => {
    using ws = workspace({ maxRounds: 3 });
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    const first = await step(ws, run => startReview(ws, run));
    await review(ws, first.reviewId, [finding('bug', 'high', 'b')]);
    await step(ws, run => recordReview(ws, run));
    commit(ws, 'two');
    await step(ws, run => runChecks(ws, run));
    const second = await step(ws, run => startReview(ws, run));
    // A summary that reaches the item unredacted, as an older state file could hold it.
    await step(ws, run => void (run.slices[0]!.fixItems[0]!.summary = `leaks ${secret}`));
    await review(ws, second.reviewId, [], [], [{ id: 'bug-b', reason: 'still broken', status: 'open' }]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(!result.green && 'fixPath' in result);
    const section = /- Item: (.*)/.exec(readFileSync(result.fixPath ?? '', 'utf8'))?.[1];
    assert.equal(section, 'leaks <REDACTED>');
  });
});
