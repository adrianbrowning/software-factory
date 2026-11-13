import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, runDir, ticketPath, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { approvePlan, nextAction, nextSlice, planSlices } from '../src/workflow.ts';
import { commit, finding, review, sh, slice, tempDir, tempRepo } from './helpers.ts';

beforeEach(() => resetModuleState());

const CHECKS_OK = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
type Reply = { content: { text: string }[] };

/** A fake `gh` first on PATH that logs each `issue create` call's arguments and prints a numbered issue URL. */
function fakeGh() {
  const dir = tempDir('factory-retro-gh-');
  const log = join(dir.root, 'args.log');
  writeFileSync(join(dir.root, 'gh'), `#!/bin/sh\nif [ "$1 $2" != 'issue create' ]; then exit 0; fi\necho "$@" >> '${log}'\necho "https://github.com/o/r/issues/$(wc -l < '${log}' | tr -d ' ')"\n`);
  chmodSync(join(dir.root, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir.root}:${path}`;
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    [Symbol.dispose]: () => {
      process.env.PATH = path;
      dir[Symbol.dispose]();
    },
  };
}

/** A headless run with its one slice done, UI dialogs throwing, and the deferred sink `deferred`. With `deferEarlier`, the slice's green review lists one observation, deferred before the slice completes. */
async function doneRun(root: string, deferred: unknown, deferEarlier = false) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], ...(deferred === undefined ? {} : { deferred }) }));
  sh(root, 'commit', '-qam', 'config', '--allow-empty');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const noDialog = async (title: string) => {
    throw new Error(`dialog: ${title}`);
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, deferEarlier ? [finding('thermo', 'observation', 'naming')] : []);
  await withRun(ws, 'demo', run => recordReview(ws, run));
  if (deferEarlier) await call('factory_defer', { observations: ['thermo-naming'] });
  await withRun(ws, 'demo', run => completeSlice(ws, run));
  return { call, ws };
}

const FINDINGS = [
  { action: 'apply', category: 'automated-checks', detail: 'Add a lint rule', severity: 'high', target: 'repo', title: 'Lint rule' },
  { action: 'file-issue', category: 'agents-md', detail: 'The skill is vague', severity: 'medium', target: 'factory', title: 'Vague skill' },
  { action: 'skip', category: 'automated-checks', detail: 'Minor', severity: 'low', target: 'repo', title: 'Minor thing' },
];

describe('headless retro', () => {
  it('file sink: records retro.md, defers every finding, files no issue, adds no apply slice, and adds a Record deferred items slice', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' });
    const reply = (await call('factory_retro', { findings: FINDINGS })).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.ok(existsSync(join(runDir(ws, 'demo'), 'retro.md')));
    assert.equal(run.retroRecorded, true);
    assert.deepEqual(run.deferred.map(item => item.title).toSorted(), ['demo/retro: Lint rule', 'demo/retro: Minor thing', 'demo/retro: Vague skill']);
    assert.ok(run.deferred.every(item => item.location === 'notes/later.md' && item.review === 'retro'));
    assert.deepEqual(gh.calls(), []);
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items']);
    assert.equal(run.status, 'running');
    const added = run.slices[1] ?? assert.fail('no slice');
    const ticket = readFileSync(ticketPath(ws, 'demo', added), 'utf8');
    assert.match(ticket, /notes\/later\.md/);
    for (const title of ['Lint rule', 'Vague skill', 'Minor thing']) assert.match(ticket, new RegExp(title));
    assert.match(reply, /Next: .*factory_next/);
    const status = JSON.parse((await call('factory_status', {})).content[0]?.text ?? '') as { deferred: { location: string; slice: string; title: string }[]; nextAction: string; slices: { title: string }[] };
    assert.deepEqual(status.slices.map(item => item.title), ['Feature', 'Record deferred items']);
    assert.match(status.nextAction, /factory_next/);
    assert.equal(status.deferred.length, 3);
    assert.ok(status.deferred.every(item => item.location === 'notes/later.md' && item.slice === 'retro'));
  });

  it('github sink: files one issue per finding on the project, none on the factory repository, and adds no slice', async () => {
    using gh = fakeGh();
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'github' });
    await call('factory_retro', { findings: FINDINGS });
    const run = readRun(ws, 'demo');
    assert.equal(gh.calls().filter(args => args.startsWith('issue create')).length, 3);
    assert.ok(gh.calls().every(args => !args.includes(' -R ')));
    assert.ok(run.deferred.every(item => item.location.startsWith('https://github.com/o/r/issues/')));
    assert.equal(run.slices.length, 1);
    assert.equal(run.status, 'done');
  });

  it('without a sink: no slice is added and the run is ready', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, undefined);
    await call('factory_retro', { findings: FINDINGS });
    const run = readRun(ws, 'demo');
    assert.equal(run.slices.length, 1);
    assert.equal(run.status, 'done');
  });

  it('a retro without findings and a file sink adds no slice', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file' });
    await call('factory_retro', { findings: [] });
    const run = readRun(ws, 'demo');
    assert.equal(run.slices.length, 1);
    assert.equal(run.status, 'done');
  });

  it('a retro without findings still adds the Record deferred items slice for items deferred earlier in the run', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' }, true);
    const reply = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items']);
    const ticket = readFileSync(ticketPath(ws, 'demo', run.slices[1] ?? assert.fail('no slice')), 'utf8');
    assert.match(ticket, /notes\/later\.md/);
    assert.match(ticket, /naming/);
    assert.match(reply, /Next: .*factory_next/);
  });

  it('a second retro after the record slice is done defers its findings and records only the new items', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' });
    await call('factory_retro', { findings: [FINDINGS[1]] });
    const finishActive = async (file: string) => {
      await withRun(ws, 'demo', run => nextSlice(ws, run));
      commit(ws, file);
      await withRun(ws, 'demo', run => runChecks(ws, run));
      const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
      await review(ws, reviewId, []);
      await withRun(ws, 'demo', run => recordReview(ws, run));
      await withRun(ws, 'demo', run => completeSlice(ws, run));
    };
    await finishActive('record');
    assert.equal(readRun(ws, 'demo').status, 'done');
    await call('factory_follow_up', { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Polish', whatToBuild: 'Polish' });
    await finishActive('polish');
    await call('factory_retro', { findings: [FINDINGS[0]] });
    const run = readRun(ws, 'demo');
    assert.deepEqual(run.deferred.map(item => item.title), ['demo/retro: Vague skill', 'demo/retro: Lint rule']);
    assert.deepEqual(run.slices.map(item => item.title), ['Feature', 'Record deferred items', 'Polish', 'Record deferred items 2']);
    const ticket = readFileSync(ticketPath(ws, 'demo', run.slices[3] ?? assert.fail('no slice')), 'utf8');
    assert.match(ticket, /Lint rule/);
    assert.doesNotMatch(ticket, /Vague skill/);
  });

  /** Runs the active slice through checks, a green review listing `findings`, and returns the review's slice work so the caller can defer before completing. */
  const reviewActive = async (ws: Workspace, file: string, findings: ReturnType<typeof finding>[]) => {
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    commit(ws, 'ok', `${file}\n`);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, findings);
    await withRun(ws, 'demo', run => recordReview(ws, run));
  };

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
    await reviewActive(ws, 'record', [finding('thermo', 'observation', 'wording')]);
    const refused = await call('factory_defer', { observations: ['thermo-wording'] }).then(
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

  it('an ordinary slice titled like the Record slice still defers its review items', async () => {
    using repo = tempRepo('factory-retro-', CHECKS_OK);
    const { call, ws } = await doneRun(repo.root, { kind: 'file', path: 'notes/later.md' });
    await call('factory_retro', { findings: [] });
    await call('factory_follow_up', { acceptance: ['logged'], estimateTokens: 500, seams: ['cli'], title: 'Record deferred items for X', whatToBuild: 'Polish' });
    await reviewActive(ws, 'polish', [finding('thermo', 'observation', 'wording')]);
    await call('factory_defer', { observations: ['thermo-wording'] });
    assert.deepEqual(readRun(ws, 'demo').deferred.map(item => item.id), ['thermo-wording']);
  });
});
