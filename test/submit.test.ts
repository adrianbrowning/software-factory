import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type Command, ctx, load } from './extension.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { addEvent, greenCommit, readRun, withRun, type Workspace } from '../src/run.ts';
import { completeSlice, recordReview, runChecks, startReview } from '../src/review.ts';
import { fitDeferred, planSubmit, prBody, submitStack } from '../src/submit.ts';
import { approvePlan, nextSlice, parseRetro, planSlices, recordRetro, resolveBase } from '../src/workflow.ts';
import { commit, finding, green, newRun, review, sh, slice, start, step, tempDir, tempRepo, workspace } from './helpers.ts';

beforeEach(() => resetModuleState());

/** A done run of `count` chained slices, each with a reviewed commit, checked out on `main` (off the top slice). */
async function doneRun(ws: Workspace, count: number) {
  const titles = Array.from({ length: count }, (_, index) => `S${index + 1}`);
  await newRun(ws, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])));
  for (const [index] of titles.entries()) {
    await step(ws, run => nextSlice(ws, run));
    commit(ws, index === 0 ? 'ok' : `s${index + 1}.txt`);
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
  }
  await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
  sh(ws.root, 'switch', '-q', 'main');
  return readRun(ws, 'demo').slices.map(item => item.branch);
}

const NO_STACK = { code: 2, stderr: '✗ no local or remote stack found for "$3"' };

interface FakeGh {
  /** The stack `stack view --json` serves (a raw string is served as is); undefined means no stack. */
  stack: string[] | string | undefined;
  /** How `stack checkout` fails without a stack; by default gh-stack's real "no stack" exit and stderr. */
  checkoutFailure?: { code: number; stderr: string };
  /** The subcommand (such as `stack submit`) that runs `onFail` and exits 1. */
  fail?: string;
  onFail?: string;
  /** A shell command run when `stack submit` succeeds. */
  onSubmit?: string;
  /** The stack `stack view --json` serves after `stack submit`, with each branch's PR number (none: no `pr`). */
  submitted?: { name: string; pr?: number }[];
}

/** The branches as a submitted stack, with PRs numbered from 101. */
const withPrs = (branches: string[]) => branches.map((name, index) => ({ name, pr: 101 + index }));

/** The `gh api` call that sets the title and the body of PR 101 onwards (`demo: NN Sn`) in one PATCH; `calls()` abbreviates a body to `…`. */
const prCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f title=demo: 0${index + 1} S${index + 1} -f body=…`);

/**
 * Puts a fake `gh` first on PATH until the `using` scope that holds it ends, then removes it; it records each call.
 * With a stack, `stack checkout <branch>` switches to that branch, as gh-stack does; `stack init` switches to its last
 * (top) branch, `stack top` to the stack's top branch, and `stack add <branch>` to the branch it adds.
 */
function fakeGh({ stack, checkoutFailure = NO_STACK, fail = '', onFail = ':', onSubmit = ':', submitted }: FakeGh) {
  const temp = tempDir('factory-gh-');
  const dir = temp.root;
  const log = join(dir, 'calls');
  const view = join(dir, 'view.json');
  if (typeof stack === 'string') writeFileSync(view, stack);
  else if (stack !== undefined) {
    writeFileSync(view, JSON.stringify({ branches: stack.map(name => ({ name })), currentBranch: stack[0], trunk: 'main' }));
    writeFileSync(join(dir, 'top'), stack.at(-1) ?? '');
  }
  const after = join(dir, 'submitted.json');
  if (submitted !== undefined) {
    const items = submitted.map(({ name, pr }) => (pr === undefined ? { name } : { name, pr: { number: pr, url: `https://example.test/pull/${pr}`, state: 'OPEN' } }));
    writeFileSync(after, JSON.stringify({ branches: items, currentBranch: submitted.at(-1)?.name, trunk: 'main' }));
  }
  const script = [
    '#!/bin/sh',
    // A newline in an argument (a PR body) is logged as \\036, so each call stays one line.
    `printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' '\\036')" >> '${log}'`,
    `if [ "$1 $2" = "stack checkout" ] && [ ! -f '${view}' ]; then echo "${checkoutFailure.stderr}" >&2; exit ${checkoutFailure.code}; fi`,
    `if [ "$1 $2" = "stack checkout" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = "stack view" ]; then cat '${view}' || exit 1; fi`,
    `if [ "$1 $2" = "stack init" ]; then eval "git switch -q \\"\\\${$#}\\"" || exit 1; fi`,
    `if [ "$1 $2" = "stack top" ]; then git switch -q "$(cat '${join(dir, 'top')}')" || exit 1; fi`,
    `if [ "$1 $2" = "stack add" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = '${fail}' ]; then ${onFail}; exit 1; fi`,
    `if [ "$1 $2" = "stack submit" ]; then ${onSubmit}; fi`,
    `if [ "$1 $2" = "stack submit" ] && [ -f '${after}' ]; then cp '${after}' '${view}'; fi`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const raw = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(call => call.replaceAll('\x1e', '\n')) : []);
  return {
    calls: () => raw().map(call => call.replace(/ -f body=[\s\S]*/, ' -f body=…')),
    /** The body each PR (by number) was last given. */
    bodies: () => new Map(raw().map(call => /pulls\/(\d+) -f title=[^\n]* -f body=([\s\S]*)/.exec(call)).filter((match): match is RegExpExecArray => match !== null).map(match => [Number(match[1]), match[2] ?? ''] as const)),
    // Removes only this fake's PATH entry, so several fakes in one test clean up in any order.
    [Symbol.dispose]: () => {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
      temp[Symbol.dispose]();
    },
  };
}

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
      run.source = { ...run.source, url: 'https://github.com/o/r/issues/7' };
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
  });

  it('fails without adopting when gh stack checkout fails for another reason than no stack', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ checkoutFailure: { code: 4, stderr: '✗ failed to list stacks: HTTP 401: Bad credentials' }, stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /Bad credentials/);
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`]);
  });

  it('adds only the slices the existing stack does not hold on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 6);
    using gh = fakeGh({ stack: branches.slice(0, 5), submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack view --json',
      'stack top',
      `stack add ${branches[5]}`,
      'stack submit --auto',
      'stack view --json',
      ...prCalls(6),
    ]);
    assert.ok(steps.includes(`adding 1 branch to the existing gh stack: ${branches[5]}`), steps.join('\n'));
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'an add re-submit ends on the top slice');
  });

  it('adds every missing slice in run order on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [
      `stack checkout ${branches[0]}`,
      'stack view --json',
      'stack top',
      `stack add ${branches[1]}`,
      `stack add ${branches[2]}`,
      'stack submit --auto',
      'stack view --json',
      ...prCalls(3),
    ]);
    assert.ok(steps.includes(`adding 2 branches to the existing gh stack: ${branches[1]}, ${branches[2]}`), steps.join('\n'));
  });

  it('only submits when the existing stack holds every slice branch', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ stack: branches, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json', 'stack top', 'stack submit --auto', 'stack view --json', ...prCalls(2)]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a full-stack re-submit ends on the top slice');
    assert.ok(steps.includes('the gh stack already holds all 2 slice branches'), steps.join('\n'));
  });

  it('fails naming each slice branch that has no PR after gh stack submit, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using gh = fakeGh({ stack: branches.slice(0, 1), submitted: [{ name: branches[0] ?? '', pr: 101 }, { name: branches[1] ?? '' }, { name: branches[2] ?? '', pr: 103 }] });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, new RegExp(`submitted.*titles were not set.*${branches[1]}`, 's'));
    assert.match(failure.message, /\/factory submit again sets them/);
    assert.doesNotMatch(failure.message, /Already added/);
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice has no PR');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('fails saying the titles were not set when a title PATCH fails, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using _gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches), fail: 'api -X' });
    const { failure } = await step(ws, run => submitStack(ws, run));
    assert.ok(failure instanceof Error, 'the failure comes back in the result');
    assert.match(failure.message, /submitted.*titles were not set.*\/factory submit again sets them/s);
    assert.doesNotMatch(failure.message, /Already added/);
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'submit'), 'the submit event is saved with the run');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('keeps the submit event, and reports the failure, when interactive /factory submit cannot set a PR title or body', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    const commands = new Map<string, Command>();
    load({ commands });
    const caller = { ...ctx('main', 'main'), cwd: ws.root, hasUI: true, ui: { confirm: async () => true, notify() {}, setStatus() {} } };
    await assert.rejects(commands.get('factory')?.handler('submit demo', caller) ?? Promise.resolve(), /titles were not set/);
    assert.equal(readRun(ws, 'demo').events.filter(event => event.kind === 'submit').length, 1, 'the PRs are on GitHub, so the run records the submit');
  });

  it('refuses a stack with branches outside the run or out of run order, and changes nothing', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    const [one = '', two = '', three = ''] = branches;
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, one, 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [stack, message] of [
      [[one, 'stranger'], /outside the run: stranger/],
      [[one, three, two], new RegExp(`out of run order: ${three}, ${two}`)],
    ] as const) {
      using gh = fakeGh({ stack: [...stack] });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.deepEqual(gh.calls(), [`stack checkout ${one}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before, 'a refused submit checks out the branch it started on');
    }
  });

  it('returns to a detached HEAD at the same commit after a refused submit', async () => {
    using ws = workspace();
    const [one = ''] = await doneRun(ws, 3);
    sh(ws.root, 'switch', '-q', '--detach', 'HEAD');
    const sha = sh(ws.root, 'rev-parse', 'HEAD');
    using _gh = fakeGh({ stack: [one, 'stranger'] });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /outside the run/);
    assert.equal(sh(ws.root, 'branch', '--show-current'), '');
    assert.equal(sh(ws.root, 'rev-parse', 'HEAD'), sha);
  });

  it('checks out the branch it started on when the gh stack view fails or is malformed', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const view of ['not json', JSON.stringify({ stacks: [] })]) {
      using gh = fakeGh({ stack: view });
      await assert.rejects(step(ws, run => submitStack(ws, run)));
      assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, 'stack view --json']);
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack add or submit fails on a re-submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 3);
    const before = sh(ws.root, 'branch', '--show-current');
    assert.notEqual(before, branches[0], 'the submit starts off slice 01, so a checkout left behind shows');
    for (const [fail, message] of [
      ['stack add', /^(?![\s\S]*Already added)/],
      ['stack submit', new RegExp(`Already added to the gh stack: ${branches[2]}; run /factory submit again`)],
    ] as const) {
      using gh = fakeGh({ fail, stack: branches.slice(0, 2) });
      await assert.rejects(step(ws, run => submitStack(ws, run)), message);
      assert.equal(gh.calls().at(-1)?.startsWith(fail), true, gh.calls().join('\n'));
      assert.equal(sh(ws.root, 'branch', '--show-current'), before);
    }
  });

  it('checks out the branch it started on when gh stack init fails on a first submit', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    using gh = fakeGh({ fail: 'stack init', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches.join(' ')}`]);
    assert.equal(sh(ws.root, 'branch', '--show-current'), 'main');
  });

  it('keeps the gh stack error when switching back to the starting branch also fails', async () => {
    using ws = workspace();
    await doneRun(ws, 2);
    // s2.txt exists only on slice 02; a local change to it blocks the switch back to main.
    using _gh = fakeGh({ fail: 'stack init', onFail: 'echo changed > s2.txt; echo "init exploded" >&2', stack: undefined });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /init exploded[\s\S]*Switching back to main also failed/);
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

const HEADLESS_FILES = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
type Reply = { content: { text: string }[] };

/** A headless run planned with `titles` (each blocked by the one before), whose UI throws on any dialog; slice 01 is active with `ok` committed. */
async function headlessSubmitRun(root: string, titles: string[], policy: Record<string, string> = {}) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], headless: policy }));
  sh(root, 'commit', '-qam', 'policy');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const noDialog = async (title: string) => {
    throw new Error(`dialog: ${title}`);
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])))));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  return { branches: readRun(ws, 'demo').slices.map(item => item.branch), call, ws };
}

/** Takes the active slice to a green review. */
async function greenWithObservation(ws: Workspace) {
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
  await withRun(ws, 'demo', run => recordReview(ws, run));
}

describe('headless submit', () => {
  it('records one submission-stop event, not an autonomous one, when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1'], { submission: 'stop' });
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    await withRun(ws, 'demo', run => { run.retroRecorded = false; });
    await call('factory_retro', { findings: [] });
    const { events } = readRun(ws, 'demo');
    const stops = events.filter(event => event.kind === 'submission-stop');
    assert.equal(stops.length, 1, 'a repeated submission records the stop once');
    assert.match(stops[0]?.detail ?? '', /gate submission \(stop\): no PRs opened/);
    assert.ok(!events.some(event => event.kind === 'autonomous' && /submission/.test(event.detail)), 'the PR bodies list autonomous events only');
    assert.deepEqual(gh.calls(), []);
  });

  it('opens nothing and records no gate event when no done slice is below the slice a stopped run is red at', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    let text = '';
    for (let round = 0; round < 4; round++) text = (await call('factory_checks', {})).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'paused');
    assert.match(text, /No done slice is below slice 01, so no PRs were opened/);
    assert.deepEqual(gh.calls(), []);
    assert.ok(!readRun(ws, 'demo').events.some(event => /gate submission/.test(event.detail)), 'a submission that was never eligible leaves no gate event');
  });

  it('opens draft PRs when the stack becomes ready, with no /factory submit, and the reply names the PR URLs', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const completed = await call('factory_complete_slice', {});
    assert.deepEqual(gh.calls(), [], 'the stack is not ready until the retro is recorded');
    assert.doesNotMatch(completed.content[0]?.text ?? '', /pull/);
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'done');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json', ...prCalls(1)]);
    assert.match(text, /https:\/\/example\.test\/pull\/101/);
    assert.match(gh.bodies().get(101) ?? '', /S1/);
    assert.ok(readRun(ws, 'demo').events.some(event => event.kind === 'submit'));
  });

  it('does not tell the user to run /factory submit after a headless run opened its PRs', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.match(text, /Next: The draft PRs are open; merging stays manual\./);
    assert.doesNotMatch(text, /Next:[^\n]*\/factory submit/);
  });

  it('does not submit and leaves the run ready when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1'], { submission: 'stop' });
    await greenWithObservation(ws);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'done');
    assert.deepEqual(gh.calls(), []);
    assert.match(text, /submission to stop/);
  });

  it('tells a paused stopped stack to resume before submitting when the policy sets submission to stop', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2'], { submission: 'stop' });
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    let text = '';
    for (let round = 0; round < 4; round++) text = (await call('factory_checks', {})).content[0]?.text ?? '';
    assert.equal(readRun(ws, 'demo').status, 'paused');
    assert.deepEqual(gh.calls(), []);
    assert.match(text, /submission to stop[\s\S]*After \/factory resume finishes the stack/);
  });

  it('submits the done slices below a slice that stays red, with bodies that say where and why the stack stopped, and not the red slice', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 3; round++) await call('factory_checks', {});
    assert.deepEqual(gh.calls(), [], 'nothing is submitted before the last fix round');
    const text = (await call('factory_checks', {})).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'paused');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json', ...prCalls(1)]);
    assert.match(text, /https:\/\/example\.test\/pull\/101/);
    assert.match(gh.bodies().get(101) ?? '', /stack stopped at slice 02 "S2".*still red after 3 fix rounds/);
    assert.equal(sh(repo.root, 'branch', '--show-current'), branches[1], 'the run is back on the red slice');
  });

  it('puts the checkout back on the red slice when a PR title or body PATCH fails during a stopped submit', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    using gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 4; round++) await call('factory_checks', {});
    assert.deepEqual(gh.calls().slice(0, 4), [`stack checkout ${branches[0]}`, `stack init --base main ${branches[0]}`, 'stack submit --auto', 'stack view --json']);
    assert.ok(gh.calls().at(-1)?.startsWith('api -X PATCH'), gh.calls().join('\n'));
    assert.equal(readRun(ws, 'demo').status, 'paused');
    assert.equal(sh(repo.root, 'branch', '--show-current'), branches[1], 'the run is back on the red slice');
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    assert.ok(kinds.includes('autonomous') && kinds.includes('submit') && kinds.includes('submit-failed'), kinds.join());
  });

  it('keeps the submit event when the switch back to the red slice fails after a successful stopped submit', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1', 'S2']);
    await greenWithObservation(ws);
    await call('factory_complete_slice', {});
    await withRun(ws, 'demo', run => nextSlice(ws, run));
    sh(repo.root, 'rm', '-q', 'ok');
    sh(repo.root, 'commit', '-qm', 'break the check');
    // `ok` is deleted on slice 02 and tracked on slice 01; a local change to it blocks the switch back.
    using _gh = fakeGh({ onSubmit: 'echo changed > ok', stack: undefined, submitted: withPrs(branches.slice(0, 1)) });
    for (let round = 0; round < 4; round++) await call('factory_checks', {});
    const events = readRun(ws, 'demo').events;
    const kinds = events.map(event => event.kind);
    assert.ok(kinds.includes('submit') && kinds.includes('submit-failed'), kinds.join());
    assert.match(events.find(event => event.kind === 'submit-failed')?.detail ?? '', /Switching back to .* failed/);
  });

  it('keeps the saved result when gh fails: the reply names the failure and /factory submit, and ends with Next', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using gh = fakeGh({ fail: 'stack submit', onFail: 'echo "push rejected" >&2', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    const text = (await call('factory_retro', { findings: [] })).content[0]?.text ?? '';
    const run = readRun(ws, 'demo');
    assert.equal(run.status, 'done');
    assert.equal(run.slices[0]?.status, 'done');
    assert.ok(run.retroRecorded);
    assert.ok(gh.calls().includes('stack submit --auto'));
    assert.match(text, /Submission failed[\s\S]*push rejected[\s\S]*\/factory submit retries it/);
    assert.match(text, /\nNext: [^\n]*$/, 'the reply ends with the Next line');
    assert.ok(run.events.some(event => event.kind === 'submit-failed'));
  });

  it('saves the autonomous gate event and submit-failed, but no submit event, when gh stack submit fails', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ fail: 'stack submit', onFail: 'echo "push rejected" >&2', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    assert.ok(kinds.includes('autonomous'), kinds.join());
    assert.ok(kinds.includes('submit-failed'));
    assert.ok(!kinds.includes('submit'));
    await withRun(ws, 'demo', run => { run.retroRecorded = false; });
    await call('factory_retro', { findings: [] });
    const gateChoices = readRun(ws, 'demo').events.filter(event => event.kind === 'autonomous' && event.detail.startsWith('gate submission (auto)'));
    assert.equal(gateChoices.length, 1, 'a repeat submission lists the gate choice once');
  });

  it('saves the autonomous, submit and submit-failed events when a PATCH fails after gh stack submit succeeds', async () => {
    using repo = tempRepo('factory-hsubmit-', HEADLESS_FILES);
    const { branches, call, ws } = await headlessSubmitRun(repo.root, ['S1']);
    await greenWithObservation(ws);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    await call('factory_complete_slice', {});
    await call('factory_retro', { findings: [] });
    const kinds = readRun(ws, 'demo').events.map(event => event.kind);
    for (const kind of ['autonomous', 'submit', 'submit-failed']) assert.ok(kinds.includes(kind), `${kind} in ${kinds.join()}`);
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
