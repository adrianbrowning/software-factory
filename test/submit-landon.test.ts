import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Finding, forgetRun, readRun, REVIEW_DOMAINS, runDir, statePath } from '../src/run.ts';
import { recordReview, runChecks, startReview } from '../src/review.ts';
import { submitStack } from '../src/submit.ts';
import { resolveBase } from '../src/workflow.ts';
import { commit, finding, review, sh, step, workspace } from './helpers.ts';
import { doneRun, fakeGh, titleCalls, withPrs } from './submit-fixtures.ts';

describe('landOn submit', () => {
  it('submits a landOn run as a gh stack onto the landOn branch, leaving that branch where it was', async () => {
    using ws = workspace();
    sh(ws.root, 'switch', '-q', '-c', 'ext-953');
    commit(ws, 'ext.txt');
    sh(ws.root, 'switch', '-q', 'main');
    await assert.rejects(resolveBase(ws, { baseRef: 'main', landOn: 'ext-953' }), /"ext-953" is not at or below main/);
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'plan')?.detail ?? '', /, PRs target ext-953: /);
    const landOn = sh(ws.root, 'rev-parse', 'ext-953');
    // origin is this repository, so it holds ext-953.
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const steps: string[] = [];
    await step(ws, run => submitStack(ws, run, message => steps.push(message)));
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base ext-953 ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...titleCalls(2)]);
    assert.ok(steps.includes('adopting 2 branches into a gh stack onto ext-953'), steps.join('\n'));
    assert.equal(sh(ws.root, 'rev-parse', 'ext-953'), landOn, 'submit does not move the landOn branch');
  });

  it('writes a single-PR handoff to pr.md after a landOn submit and says how to land it', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    // Two decisions. Slice 01's one green review skipped security and kept a thermo observation. Slice 02 took two
    // rounds: the first kept a blocking bug and a thermo observation, the fix's green review a testing observation.
    const branches = await doneRun(ws, 2, {
      decisions: ['Keep the old flag working', 'Ship without a migration'],
      landOn: 'ext-953',
      source: { body: 'Land it', kind: 'github', ref: '#149', title: 'Land the work on ext-953', url: 'https://github.com/acme/app/issues/149' },
      toGreen: async index => {
        await step(ws, run => runChecks(ws, run));
        if (index === 0) {
          const kept = REVIEW_DOMAINS.filter(domain => domain !== 'security');
          const opened = await step(ws, run => startReview(ws, run, [{ domain: 'security', reason: 'no inputs' }], kept));
          await review(ws, opened.reviewId, [finding('thermo', 'observation', 'naming')]);
          return step(ws, run => recordReview(ws, run));
        }
        const at = (item: Finding) => ({ ...item, path: 's2.txt' });
        const first = await step(ws, run => startReview(ws, run));
        await review(ws, first.reviewId, [at(finding('bug', 'high', 'null-crash')), at(finding('thermo', 'observation', 'first-round'))]);
        assert.ok(!(await step(ws, run => recordReview(ws, run))).green);
        commit(ws, 's2.txt', 'fixed\n');
        await step(ws, run => runChecks(ws, run));
        const second = await step(ws, run => startReview(ws, run));
        await review(ws, second.reviewId, [at(finding('testing', 'observation', 'late'))]);
        const recorded = await step(ws, run => recordReview(ws, run));
        assert.ok(recorded.green);
        return recorded;
      },
    });
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const output = await step(ws, run => submitStack(ws, run));
    const path = join(runDir(ws, 'demo'), 'pr.md');
    assert.deepEqual(gh.calls(), [`stack checkout ${branches[0]}`, `stack init --base ext-953 ${branches.join(' ')}`, 'stack submit --auto', 'stack view --json', ...titleCalls(2)], 'nothing is merged and no PR to the trunk is opened');
    const handoff = readFileSync(path, 'utf8');
    assert.match(handoff, /^# Land the work on ext-953\n/);
    assert.doesNotMatch(handoff, /first-round|null-crash/, "the first round's findings are not outstanding concerns");
    for (const expected of [
      /## Issue\n\n- Ref: #149\n- Title: Land the work on ext-953\n- URL: https:\/\/github\.com\/acme\/app\/issues\/149\n/,
      /## Summary\n\nLands software-factory run demo: 2 slices, each built test-first, checked and reviewed, stacked onto ext-953: 01 S1; 02 S2\.\n/,
      /### 01 S1 \(https:\/\/example\.test\/pull\/101\)\n\nS1\n\n- S1 works/,
      /### 02 S2 \(https:\/\/example\.test\/pull\/102\)\n\nS2\n\n- S2 works/,
      /## Checks\n\n- 01 S1: test -f ok: passed in \d+ms\n- 02 S2: test -f ok: passed in \d+ms\n/,
      /## Reviews\n\n- 01 S1: 1 review round; domains: performance, react-ts, testing, test-validity, devops, holistic, thermo, bug, scope, comments\n/,
      // Slice 02 changed only s2.txt, so its review skipped react-ts, test-validity and devops.
      /- 02 S2: 2 review rounds; domains: security, performance, testing, holistic, thermo, bug, scope, comments\n/,
      /## Decisions\n\n1\. Keep the old flag working\n2\. Ship without a migration\n\n/,
      // Only each slice's final green review counts: slice 02's first-round observation is gone.
      /## Outstanding concerns\n\n- Slice 01 observation thermo-naming: naming \(ok:1\)\n- Slice 02 observation testing-late: late \(s2\.txt:1\)\n\n/,
      /## Retro findings applied\n\nNone\n/,
      /## Factory\n\nFeature: demo\n/,
    ]) {
      assert.match(handoff, expected);
    }
    assert.match(output, /^gh stack submitted\n/);
    for (const expected of ['merge the stack into ext-953', 'open one PR from ext-953 to main', path, 'Land the work on ext-953']) {
      assert.ok(output.includes(expected), `${expected}\n---\n${output}`);
    }
    assert.ok(!/push/i.test(output.replace(/^gh stack submitted\n/, '')), output);
  });

  it('submits a landOn run whose state stored a different trunk onto the landOn branch', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    // A state written before trunk followed landOn stored the old trunk.
    const state = JSON.parse(readFileSync(statePath(ws, 'demo'), 'utf8'));
    writeFileSync(statePath(ws, 'demo'), JSON.stringify({ ...state, trunk: 'main' }));
    forgetRun(ws, 'demo');
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    await step(ws, run => submitStack(ws, run));
    assert.ok(gh.calls().includes(`stack init --base ext-953 ${branches.join(' ')}`), gh.calls().join('\n'));
  });

  it('writes no pr.md for a landOn run when a PR title fails to set', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using _gh = fakeGh({ fail: 'api -X', stack: undefined, submitted: withPrs(branches) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), /titles were not set/);
    assert.ok(!existsSync(join(runDir(ws, 'demo'), 'pr.md')));
  });

  it('sets no title and writes no pr.md for a landOn run when gh stack view gives a slice PR no URL', async () => {
    using ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using gh = fakeGh({ stack: undefined, submitted: withPrs(branches).map((item, index) => ({ ...item, noUrl: index === 1 })) });
    await assert.rejects(step(ws, run => submitStack(ws, run)), new RegExp(`titles were not set: gh stack view gave no PR URL for these slice branches, so the handoff cannot link them: ${branches[1]}\\.`, 's'));
    assert.deepEqual(gh.calls().filter(call => call.startsWith('api')), [], 'no title is set when a slice PR has no URL');
    assert.ok(!existsSync(join(runDir(ws, 'demo'), 'pr.md')));
  });

  it('names the configured trunk, not main, as the target of the one PR in the landOn handoff', async () => {
    using ws = workspace({ trunk: 'release' });
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    using _gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const output = await step(ws, run => submitStack(ws, run));
    assert.ok(output.includes('open one PR from ext-953 to release.'), output);
  });

  it('names the configured base without its remote as the target of the one PR when no trunk is configured', async () => {
    using ws = workspace({ baseRef: 'origin/develop', trunk: undefined });
    // origin is this repository; develop and its remote-tracking ref are the configured base.
    sh(ws.root, 'remote', 'add', 'origin', ws.root);
    sh(ws.root, 'branch', 'develop');
    sh(ws.root, 'update-ref', 'refs/remotes/origin/develop', 'develop');
    sh(ws.root, 'branch', 'ext-953');
    const branches = await doneRun(ws, 2, { landOn: 'ext-953' });
    using _gh = fakeGh({ stack: undefined, submitted: withPrs(branches) });
    const output = await step(ws, run => submitStack(ws, run));
    assert.ok(output.includes('open one PR from ext-953 to develop.'), output);
  });
});
