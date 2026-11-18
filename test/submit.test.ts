import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetModuleState } from '../src/index.ts';
import { addEvent, greenCommit, readRun, type Workspace } from '../src/run.ts';
import { completeSlice } from '../src/review.ts';
import { fitDeferred, planSubmit, prBody, submitStack } from '../src/submit.ts';
import { approvePlan, nextSlice, planSlices, resolveBase } from '../src/workflow.ts';
import { parseRetro, recordRetro } from '../src/retro.ts';
import { commit, green, newRun, sh, slice, start, step, tempDir, workspace, withPrs, prCalls, submitFakeGh as fakeGh, submitDoneRun as doneRun } from './helpers.ts';

beforeEach(() => resetModuleState());

describe('submit', () => {
  it('refuses to submit a branch that moved after its green review', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    const started = await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));

    commit(ws, 'unreviewed.txt');
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`moved after their green review.*${started?.branch}`));
  });

  it('lands a multi-slice run on an existing branch by fast-forwarding it to the top slice, without checkout', async () => {
    using ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-953');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: 'ext-953' }), /"ext-953" is not at or below main/);
    await start(ws);
    const base = await resolveBase(ws, { landOn: 'ext-953' });
    assert.equal(base.baseRef, 'ext-953');
    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('One'), slice('Two', ['One'])], base), base));
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'plan')?.detail ?? '', /lands on ext-953/);
    for (const file of ['ok', 'two.txt']) {
      await step(ws, run => nextSlice(ws, run));
      commit(ws, file);
      await green(ws);
      await step(ws, run => completeSlice(ws, run));
    }
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    const top = readRun(ws, 'demo').slices[1];
    const checkedOut = sh(ws.root, 'branch', '--show-current');

    sh(ws.root, 'switch', '-q', 'ext-953');
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is checked out/);
    sh(ws.root, 'switch', '-q', checkedOut);
    using linked = tempDir('factory-wt-');
    sh(ws.root, 'worktree', 'add', '-q', linked.root, 'ext-953');
    await assert.rejects(step(ws, run => submitStack(ws, run)), /ext-953 is checked out in .*factory-wt-/);
    sh(ws.root, 'worktree', 'remove', linked.root);

    const steps: string[] = [];
    const { output } = await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(steps, ['checking the working tree and the slice branches', 'fast-forwarding ext-953 to the top slice']);
    assert.match(output, /ext-953 fast-forwarded to .*No PRs were opened/);
    assert.equal(sh(ws.root, 'rev-parse', 'ext-953'), top === undefined ? undefined : greenCommit(top));
    assert.equal(sh(ws.root, 'branch', '--show-current'), checkedOut, 'the checkout is unchanged');
    assert.equal(sh(ws.root, 'rev-list', '--merges', '--count', 'ext-953'), '0');
  });

  it('refuses at plan time a landOn that is a revision expression or not a local branch', async () => {
    using ws = workspace();
    sh(ws.root, 'update-ref', 'refs/remotes/origin/main', 'main');
    for (const name of ['main^{commit}', 'main~0', 'origin/main', 'refs/heads/main', '../main', '-main', 'missing']) {
      await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: name }), /is not an existing local branch/, name);
    }
    assert.equal((await resolveBase(ws, { baseRef: 'main', landOn: 'main' })).landOn, 'main');
  });

  it('refuses to land when the target branch moved off the stack', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'target');
    await start(ws);
    const base = await resolveBase(ws, { landOn: 'target' });
    await step(ws, run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')], base), base));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
    await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
    const slices = sh(ws.root, 'branch', '--show-current');
    sh(ws.root, 'switch', '-q', 'target');
    commit(ws, 'elsewhere.txt');
    const moved = sh(ws.root, 'rev-parse', 'HEAD');
    sh(ws.root, 'switch', '-q', slices);
    await assert.rejects(step(ws, run => submitStack(ws, run)), /target is gone or moved off the stack's base/);
    assert.equal(sh(ws.root, 'rev-parse', 'target'), moved);
  });

  it('adopts every slice branch with gh stack init on a first submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'only gh stack init can leave the top slice checked out');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...prCalls(3)]);
    assert.ok(steps.includes('adopting 3 branches into a gh stack onto main'), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a first submit ends on the top slice');
  });

  it('sets every PR body from run state: the issue link, slice summary, checks, review rounds, autonomous decisions, unresolved findings and deferred items', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    await step(ws, run => {
      run.source = { ...run.source, url: 'https://github.com/o/r/issues/7', related: [{ ref: '8', title: 'Eighth', url: 'https://github.com/o/r/issues/8' }, { ref: '9', title: 'Ninth', url: 'https://github.com/o/r/issues/9' }] };
      run.decisions.push({ author: 'autonomous', text: 'Took the narrower reading.' }, { author: 'user', text: 'Skip the CLI.' }, { author: 'autonomous', text: 'Used token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the fixture.' });
      addEvent(run, 'autonomous', 'gate intake (auto): left out text from outside authors @mallory');
      const [one] = run.slices;
      if (one !== undefined) { one.unresolved = ['blocking finding bug-x: [high] a.ts:1: wrong']; one.whatToBuild = 'Build the S1 widget end to end.'; }
      run.deferred.push({ body: 'b', key: 'r1:thermo-naming', kind: 'observation', location: 'docs/factory-deferred.md', review: 'r1', slice: '01', title: 'demo/01: naming' });
      run.deferred.push({ body: 'b', key: 'retro:1:1', kind: 'retro', location: 'https://github.com/o/r/issues/9', review: 'retro', slice: 'retro', title: 'demo/retro: lint rule' });
    });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await step(ws, run => submitStack(ws, run));
    const first = gh.bodies().get(101) ?? '';
    const second = gh.bodies().get(102) ?? '';
    assert.match(first, /https:\/\/github\.com\/o\/r\/issues\/7/);
    assert.match(first, /## Slice 01: S1\n\nBuild the S1 widget end to end\./, 'the slice summary');
    assert.match(first, /S1 works/, 'the acceptance criteria');
    assert.match(first, /test -f ok/, 'the checks the slice passed');
    assert.match(first, /1 review/);
    assert.match(first, /Autonomous decisions[\s\S]*Took the narrower reading\./);
    assert.doesNotMatch(first, /Skip the CLI/);
    assert.doesNotMatch(first, /ghp_abcdefghij/, 'a credential in a decision is redacted');
    assert.match(first, /Used token <REDACTED>/);
    assert.match(first, /left out text from outside authors @mallory/);
    assert.match(first, /blocking finding bug-x: \[high\] a\.ts:1: wrong/);
    assert.match(first, /demo\/01: naming.*docs\/factory-deferred\.md/);
    assert.doesNotMatch(first, /lint rule/);
    assert.doesNotMatch(second, /bug-x/);
    assert.match(second, /demo\/retro: lint rule.*https:\/\/github\.com\/o\/r\/issues\/9/, 'retro items are listed on the top slice');
    for (const body of [first, second]) {
      const lines = body.split('\n');
      assert.match(lines[0] ?? '', /^Issue: https:\/\/github\.com\/o\/r\/issues\/7 \(/);
      assert.equal(lines[1], 'Related: https://github.com/o/r/issues/8 (Eighth)');
      assert.equal(lines[2], 'Related: https://github.com/o/r/issues/9 (Ninth)');
      assert.doesNotMatch(body, /\b(closes|fixes|resolves) #/i);
    }
  });
});

describe('planSubmit', () => {
  const branches = ['b1', 'b2', 'b3'];
  it('adopts every branch when slice 01 is in no stack', () => {
    assert.deepEqual(planSubmit(undefined, branches), { kind: 'init' });
  });
  it('adds the branches a prefix stack lacks', () => {
    assert.deepEqual(planSubmit(['b1'], branches), { kind: 'add', missing: ['b2', 'b3'] });
  });
  it('adds nothing when the stack holds every branch', () => {
    assert.deepEqual(planSubmit(['b1', 'b2', 'b3'], branches), { kind: 'add', missing: [] });
  });
  it('refuses a stack with a branch outside the run', () => {
    assert.deepEqual(planSubmit(['b1', 'x'], branches), { kind: 'refuse', outside: ['x'], unordered: [] });
  });
  it('refuses a stack holding run branches out of order', () => {
    assert.deepEqual(planSubmit(['b1', 'b3', 'b2'], branches), { kind: 'refuse', outside: [], unordered: ['b3', 'b2'] });
  });
  it('refuses a stack with a stranger below slice 01', () => {
    assert.deepEqual(planSubmit(['x', 'b1'], branches), { kind: 'refuse', outside: ['x'], unordered: ['b1'] });
  });
});


/** The Run and its only Slice for a one-slice run, with `whatToBuild` and the deferred items set; built through the real planner so the fixtures follow the Run and Slice types. */
async function bigRun(ws: Workspace, { deferred = [], whatToBuild = 'x'.repeat(100_000) }: { deferred?: { location: string; title: string }[]; whatToBuild?: string } = {}) {
  await newRun(ws, [slice('Big')]);
  const run = readRun(ws, 'demo');
  const [only] = run.slices;
  assert.ok(only);
  only.whatToBuild = whatToBuild;
  only.unresolved = ['left-over finding'];
  run.decisions.push({ author: 'autonomous', text: 'chose option A' });
  run.deferred = deferred.map((item, index) => ({ body: 'b', key: `r1:item-${index}`, kind: 'observation', review: 'r1', slice: only.id, ...item }));
  return { run, slice: only };
}

const CLOSING_SECTIONS = ['## Checks run', '## Review rounds', '## Autonomous decisions', '## Accepted unresolved', '## Deferred items'];

describe('prBody', () => {
  it('lists one Related line per related issue after the Issue line, with no closing keywords', async () => {
    using ws = workspace();
    const { run, slice: one } = await bigRun(ws, { whatToBuild: 'x' });
    run.source.url = 'https://github.com/o/r/issues/1';
    run.source.related = [
      { ref: '2', title: 'Second', url: 'https://github.com/o/r/issues/2' },
      { ref: '3', title: 'Third', url: 'https://github.com/o/r/issues/3' },
    ];
    const lines = prBody(run, one, [one]).split('\n');
    assert.equal(lines[0], `Issue: https://github.com/o/r/issues/1 (${run.source.title})`);
    assert.equal(lines[1], 'Related: https://github.com/o/r/issues/2 (Second)');
    assert.equal(lines[2], 'Related: https://github.com/o/r/issues/3 (Third)');
    assert.doesNotMatch(lines.join('\n'), /\b(closes|fixes|resolves)\b/i);
  });

  it('does not let a primary or related title form a GitHub closing keyword', async () => {
    using ws = workspace();
    const { run, slice: one } = await bigRun(ws, { whatToBuild: 'x' });
    run.source.title = 'Resolves #41';
    run.source.related = [{ ref: '2', title: 'Fixes #42', url: 'https://github.com/o/r/issues/2' }, { ref: '3', title: 'closed https://github.com/o/r/issues/43', url: 'https://github.com/o/r/issues/3' }];
    const body = prBody(run, one, [one]);
    assert.doesNotMatch(body, /\b(close[sd]?|fix(es|ed)?|resolve[sd]?)\b[:\s]*(#|https?:\/\/)/i);
    assert.match(body, /Fixes/);
  });

  it('keeps every closing section and its entries when the slice summary is huge', async () => {
    using ws = workspace();
    const { run, slice: big } = await bigRun(ws, { deferred: [{ location: 'notes/later.md', title: 'later item' }] });
    const body = prBody(run, big, [big]);
    assert.ok(body.length <= 60_000, `length ${body.length}`);
    for (const part of [...CLOSING_SECTIONS, '- chose option A', '- left-over finding', '- later item: notes/later.md', '(truncated)']) assert.ok(body.includes(part), part);
  });

  it('lists every sink location with 300 deferred items and a long whatToBuild', async () => {
    using ws = workspace();
    const deferred = Array.from({ length: 300 }, (_, i) => ({ location: 'docs/deferred.md', title: `item ${i} ${'t'.repeat(300)}` }));
    const { run, slice: big } = await bigRun(ws, { deferred });
    const body = prBody(run, big, [big]);
    assert.ok(body.length <= 60_000, `length ${body.length}`);
    for (const heading of CLOSING_SECTIONS) assert.ok(body.includes(heading), heading);
    assert.equal(body.split('\n').filter(line => line.startsWith('- ') && line.includes('docs/deferred.md')).length, 300, 'every item keeps its sink location');
  });

  it('lists every issue URL when 300 deferred items do not fit with their titles', async () => {
    using ws = workspace();
    const urls = Array.from({ length: 300 }, (_, i) => `https://github.com/o/r/issues/${1000 + i}`);
    const { run, slice: big } = await bigRun(ws, { deferred: urls.map((location, i) => ({ location, title: `item ${i} ${'t'.repeat(300)}` })) });
    const body = prBody(run, big, [big]);
    assert.ok(body.length <= 60_000, `length ${body.length}`);
    for (const url of urls) assert.ok(body.includes(url), url);
  });

  for (const [name, location, sink] of [
    ['file sink: ends with a count line naming the sink path', () => 'docs/deferred.md', /docs\/deferred\.md/],
    ['github sink: ends with a count line saying the issues are in the run state', (i: number) => `https://github.com/o/r/issues/${1000 + i}`, /listed in the run state/],
  ] as const) {
    it(`beyond the budget, ${name}`, async () => {
      using ws = workspace();
      const count = 5_000;
      const { run, slice: big } = await bigRun(ws, { deferred: Array.from({ length: count }, (_, i) => ({ location: location(i), title: `item ${i} ${'t'.repeat(300)}` })) });
      const body = prBody(run, big, [big]);
      assert.ok(body.length <= 60_000, `length ${body.length}`);
      for (const heading of ['## Slice 01: Big', ...CLOSING_SECTIONS]) assert.ok(body.includes(heading), heading);
      const section = body.slice(body.indexOf('## Deferred items'));
      const more = section.match(/…and (\d+) more deferred items: ([^\n]*)/) ?? assert.fail('no more-items line');
      assert.ok(body.endsWith(more[0]), 'the more-items line ends the Deferred items section and the body');
      assert.equal(section.split('\n').filter(line => line.startsWith('- ')).length + Number(more[1]), count, 'listed lines plus the count cover every item');
      assert.ok(Number(more[1]) > 0);
      assert.match(more[2] ?? '', sink);
    });
  }

  it('keeps the body within the limit when one deferred location is longer than the whole body', async () => {
    using ws = workspace();
    const { run, slice: big } = await bigRun(ws, { deferred: [{ location: `docs/${'d'.repeat(70_000)}.md`, title: 'huge location' }] });
    const body = prBody(run, big, [big]);
    assert.ok(body.length <= 60_000, `length ${body.length}`);
    for (const heading of CLOSING_SECTIONS) assert.ok(body.includes(heading), heading);
    assert.ok(body.includes('- chose option A') && body.includes('- left-over finding'), 'the earlier sections keep their entries');
  });
});

describe('fitDeferred', () => {
  const items = [{ location: 'a.md', title: 'first' }, { location: 'a.md', title: 'second' }];

  it('lists every item as title: location when the budget allows', () => {
    assert.deepEqual(fitDeferred(items, 1_000), ['- first: a.md', '- second: a.md']);
    assert.deepEqual(fitDeferred([], 1_000), []);
  });

  it('keeps titles on a leading run and location-only lines for the rest when the full lines do not all fit', () => {
    assert.deepEqual(fitDeferred(items, 21), ['- first: a.md', '- a.md']);
    assert.deepEqual(fitDeferred(items, 14), ['- a.md', '- a.md']);
  });

  it('ends with a count line naming the sink path when not even the locations fit', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => ({ location: 'docs/deferred.md', title: `item ${i}` }));
    const lines = fitDeferred(many, 2_000);
    const last = lines.at(-1) ?? '';
    const listed = lines.length - 1;
    assert.match(last, /^…and \d+ more deferred items: docs\/deferred\.md \(truncated\)$/);
    assert.equal(listed + Number(/\d+/.exec(last)?.[0]), 1_000, 'the listed lines and the count cover every item');
    assert.ok(lines.join('\n').length + 1 <= 2_000, 'the lines fit the budget');
  });

  it('names the run state instead of listing GitHub issue URLs in the count line', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => ({ location: `https://github.com/o/r/issues/${i}`, title: `item ${i}` }));
    assert.match(fitDeferred(many, 2_000).at(-1) ?? '', /more deferred items: the issues are listed in the run state \(truncated\)$/);
  });

  it('stays within the budget for mixed file and URL locations at every budget around the count line', () => {
    const mixed = Array.from({ length: 400 }, (_, i) => ({ location: i % 2 === 0 ? `https://github.com/o/r/issues/${i}` : `docs/${'d'.repeat(300)}-${i}.md`, title: `item ${i}` }));
    for (let budget = 0; budget <= 4_000; budget += 37) {
      const lines = fitDeferred(mixed, budget);
      assert.ok(lines.length === 0 || lines.join('\n').length + 1 <= budget, `budget ${budget}: length ${lines.join('\n').length}`);
    }
  });

  it('clips the count line, or leaves it out, when the budget is smaller than it', () => {
    const one = [{ location: 'docs/deferred.md', title: 'x' }];
    const clipped = fitDeferred(one, 30);
    assert.equal(clipped.length, 1);
    assert.ok(clipped.join('\n').length + 1 <= 30, `length ${clipped.join('\n').length}`);
    assert.deepEqual(fitDeferred(one, 1), []);
  });

  it('clips a location longer than the budget, so one item cannot outgrow it', () => {
    const lines = fitDeferred([{ location: `docs/${'d'.repeat(70_000)}.md`, title: 'huge' }, { location: 'b.md', title: 'second' }], 700);
    assert.ok(lines.join('\n').length + 1 <= 700, `length ${lines.join('\n').length}`);
    assert.ok(lines.some(line => line.includes('(truncated)')));
  });
});
