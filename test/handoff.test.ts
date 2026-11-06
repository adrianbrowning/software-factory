import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { renderHandoff } from '../src/handoff.ts';
import { readRun, type Run, type Workspace } from '../src/run.ts';
import { finding, sh, workspace } from './helpers.ts';
import { doneRun } from './submit-fixtures.ts';

describe('renderHandoff', () => {
  // renderHandoff is pure, so its tests share one done landOn run and each changes its own copy.
  let ws: Workspace & Disposable;
  let done: Run;
  before(async () => {
    ws = workspace();
    sh(ws.root, 'branch', 'ext-953');
    await doneRun(ws, 2, { landOn: 'ext-953' });
    done = readRun(ws, 'demo');
  });
  after(() => ws[Symbol.dispose]());
  const fresh = () => structuredClone(done);
  /** Each slice's PR, numbered from 101 with an example URL. */
  const prsOf = (run: Run) => run.slices.map((slice, index) => ({ number: 101 + index, slice, url: `https://example.test/pull/${101 + index}` }));

  it('refuses a slice with no recorded review', () => {
    const run = fresh();
    const [one] = run.slices;
    if (one !== undefined) one.review = undefined;
    assert.throws(() => renderHandoff(run, new Map(), prsOf(run)), /Slice 01 has no recorded review/);
  });

  it('lists stalls, budget overruns and retro findings not applied as concerns, and applied repo findings apart', () => {
    const run = fresh();
    run.events.push(
      { at: 'now', detail: 'fix budget of 1 rounds used', kind: 'stall', slice: '01' },
      { at: 'now', detail: 'peak 2000 tokens, 0 compactions', kind: 'budget-exceeded', slice: '02' },
    );
    run.retroFindings = [
      { action: 'apply', category: 'automated-checks', severity: 'high', target: 'repo', title: 'Add a lint rule' },
      { action: 'file-issue', category: 'tool-economy', severity: 'medium', target: 'factory', title: 'Faster checks' },
      { action: 'skip', category: 'navigation', severity: 'low', target: 'repo', title: 'Rename a folder' },
    ];
    const { body } = renderHandoff(run, new Map(), prsOf(run));
    assert.match(
      body,
      /## Outstanding concerns\n\n- Retro finding not applied \(factory, file-issue, medium\): Faster checks\n- Retro finding not applied \(repo, skip, low\): Rename a folder\n- Slice 01 stall: fix budget of 1 rounds used\n- Slice 02 budget-exceeded: peak 2000 tokens, 0 compactions\n\n## Retro findings applied\n\n- \[high\] Add a lint rule\n/,
    );
  });

  it('says None when there are no concerns, keeps a long title exactly, and redacts issue and finding text', () => {
    const run = fresh();
    const long = `Make ${'the long title '.repeat(25)}work`;
    run.source.title = long;
    const calm = renderHandoff(run, new Map([['01', []]]), prsOf(run));
    assert.match(calm.body, /## Outstanding concerns\n\nNone\n/);
    assert.equal(calm.title, long);
    run.source.title = 'Rotate GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123';
    const leaky = { ...finding('thermo', 'observation', 'naming'), path: 'src/API_KEY=hunter2.ts' };
    const { body, title } = renderHandoff(run, new Map([['01', [leaky]]]), prsOf(run));
    assert.equal(title, 'Rotate GITHUB_TOKEN=<REDACTED>');
    assert.match(body, /- Slice 01 observation thermo-naming: naming \(src\/API_KEY=<REDACTED>\)\n/);
    assert.doesNotMatch(body, /ghp_|hunter2/);
  });

  it('collapses a multi-line source title to one line so it adds no sections', () => {
    const run = fresh();
    run.source.title = 'Fix it\n## Outstanding concerns\nNone';
    const { body, title } = renderHandoff(run, new Map([['01', []]]), prsOf(run));
    assert.equal(title, 'Fix it ## Outstanding concerns None');
    assert.equal(body.match(/^## Outstanding concerns$/gm)?.length, 1);
  });
});
