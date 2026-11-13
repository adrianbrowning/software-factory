import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addEvent, greenCommit, readRun, type Workspace } from '../src/run.ts';
import { completeSlice } from '../src/review.ts';
import { planSubmit, submitStack } from '../src/submit.ts';
import { approvePlan, nextSlice, parseRetro, planSlices, recordRetro, resolveBase } from '../src/workflow.ts';
import { fakeGh, prCalls, withPrs } from './fake-gh.ts';
import { commit, green, newRun, sh, slice, start, step, tempDir, workspace } from './helpers.ts';

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
    const output = await step(ws, run => submitStack(ws, run, message => steps.push(message)));
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
      if (one !== undefined) one.unresolved = ['blocking finding bug-x: [high] a.ts:1: wrong'];
      run.deferred.push({ body: 'b', key: 'r1:thermo-naming', kind: 'observation', location: 'docs/factory-deferred.md', review: 'r1', slice: '01', title: 'demo/01: naming' });
      run.deferred.push({ body: 'b', key: 'retro:1:1', kind: 'retro', location: 'https://github.com/o/r/issues/9', review: 'retro', slice: 'retro', title: 'demo/retro: lint rule' });
    });
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await step(ws, run => submitStack(ws, run));
    const first = gh.bodies().get(101) ?? '';
    const second = gh.bodies().get(102) ?? '';
    assert.match(first, /https:\/\/github\.com\/o\/r\/issues\/7/);
    assert.match(first, /S1/);
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
    const error = await step(ws, run => submitStack(ws, run)).then(() => assert.fail('submit should fail'), (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`submitted.*titles were not set.*${branches[1]}`, 's'));
    assert.match(error.message, /\/factory submit again sets them/);
    assert.doesNotMatch(error.message, /Already added/);
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice has no PR');
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
  });

  it('fails saying the titles were not set when a title PATCH fails, staying on the top slice', async () => {
    using ws = workspace();
    const branches = await doneRun(ws, 2);
    assert.notEqual(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'the submit starts off the top slice, so a switch-back shows');
    using _gh = fakeGh({ stack: branches.slice(0, 1), submitted: withPrs(branches), fail: 'api -X' });
    const error = await step(ws, run => submitStack(ws, run)).then(() => assert.fail('submit should fail'), (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, /submitted.*titles were not set.*\/factory submit again sets them/s);
    assert.doesNotMatch(error.message, /Already added/);
    assert.equal(sh(ws.root, 'branch', '--show-current'), branches.at(-1), 'a failed title step stays on the top slice gh stack left');
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

