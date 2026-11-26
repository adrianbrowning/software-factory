import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Finding, findingSchema, readRun, REVIEW_DOMAINS, ticketPath, type Workspace } from '../src/run.ts';
import { pathSkips, recordDecisions, recordReview, runChecks, startReview, submitDomain, submitValidation } from '../src/review.ts';
import { nextSlice } from '../src/workflow.ts';
import { bindRun } from '../src/active-run.ts';
import { ctx, load } from './extension.ts';
import { commit, finding, newRun, noFixItems, review, sh, slice, step, workspace } from './helpers.ts';

describe('review submissions', { concurrency: 4 }, () => {
  /** Opens a review in `ws` of a slice that commits `ok`. By default it keeps the path-ruled domains, so every domain reviews. */
  async function openReview(
    ws: Workspace,
    decisions: string[] = [],
    skip: { domain: Finding['domain']; reason: string }[] = [],
    input = slice('Feature'),
    keep: Finding['domain'][] = (['react-ts', 'test-validity', 'devops'] as const).filter(domain => !skip.some(entry => entry.domain === domain)),
  ) {
    await newRun(ws, [input]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    if (decisions.length > 0) await step(ws, run => recordDecisions(ws, run, decisions));
    await step(ws, run => runChecks(ws, run));
    return step(ws, run => startReview(ws, run, skip, keep));
  }

  it('checks domain and id prefix separately, and lets the validator only select', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId, ...noFixItems(domain) }));

    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), domain: 'security' }]), /must have domain "bug"/);
    await assert.rejects(submit('bug', [{ ...finding('bug', 'high', 'x'), id: 'security-x' }]), /id starting "bug-"/);
    for (const domain of REVIEW_DOMAINS) {
      await submit(domain, domain === 'bug' ? [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')] : []);
    }
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'someone-else', domain: 'bug', findings: [], reviewId })),
      /submitted by another agent/,
    );

    const validate = (keep: string[], dropped: { id: string; reason: string }[] = []) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
    await assert.rejects(validate(['bug-a', 'bug-invented']), /Unknown finding ids: bug-invented/);
    await assert.rejects(validate(['bug-a']), /Undecided: bug-b/);
    await validate(['bug-a'], [{ id: 'bug-b', reason: 'not in diff' }]);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
  });

  it('lets a reviewer replace its findings any number of times until validation', async () => {
    using ws = workspace();
    const { findingsDir, reviewId } = await openReview(ws);
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings, reviewId, ...noFixItems(domain) }));
    for (const domain of REVIEW_DOMAINS) await submit(domain, []);

    await submit('bug', [finding('bug', 'high', 'a'), finding('bug', 'critical', 'b')]);
    await submit('bug', [finding('bug', 'high', 'a'), finding('bug', 'high', 'c')]);
    await submit('bug', [finding('bug', 'high', 'a')]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(findingsDir, 'bug.json'), 'utf8')).map((item: Finding) => item.id),
      ['bug-a'],
    );

    const validate = (keep: string[]) => step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep, reviewId }));
    await assert.rejects(validate(['bug-a', 'bug-c']), /Unknown finding ids: bug-c/);
    await validate(['bug-a']);
    await assert.rejects(submit('bug', []), /already validated/);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
  });

  it('accepts a finding only on a changed path and inside a new-side hunk', async () => {
    using ws = workspace();
    commit(ws, 'long.txt', Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join(''));
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    writeFileSync(join(ws.root, 'long.txt'), Array.from({ length: 20 }, (_, index) => `line ${index === 9 ? 'ten' : index + 1}\n`).join(''));
    writeFileSync(join(ws.root, 'a b.txt'), 'spaced\n');
    writeFileSync(join(ws.root, 'bin'), Buffer.from([0, 1, 2, 0]));
    rmSync(join(ws.root, 'README.md'));
    commit(ws, 'ok');
    sh(ws.root, 'add', '-A');
    sh(ws.root, 'commit', '-qm', 'slice work');
    await step(ws, run => runChecks(ws, run));
    const { reviewId } = await step(ws, run => startReview(ws, run));
    const at = (name: string, path: string, line?: number): Finding => {
      const { line: _line, ...rest } = finding('bug', 'high', name);
      return { ...rest, path, ...(line === undefined ? {} : { line }) };
    };
    const submit = (findings: Finding[]) => step(ws, run => submitDomain(ws, run, { agentId: 'r-bug', domain: 'bug', findings, reviewId }));

    await assert.rejects(submit([at('above', 'long.txt', 6)]), /line 6 of long\.txt, outside the diff\. Its new-side hunk lines: 7-13\./);
    await assert.rejects(submit([at('below', 'long.txt', 14)]), /outside the diff/);
    await assert.rejects(submit([at('unchanged', 'other.txt')]), /names other\.txt, which the diff does not change/);
    await assert.rejects(submit([at('binary-line', 'bin', 1)]), /file-level findings only: omit line/);
    await assert.rejects(submit([at('deleted-line', 'README.md', 1)]), /file-level findings only/);
    const valid = [at('first', 'long.txt', 7), at('last', 'long.txt', 13), at('spaced', 'a b.txt', 1), at('binary', 'bin'), at('deleted', 'README.md')];
    assert.equal(await submit(valid), valid.length);
  });

  it('skips a path-ruled domain only when no changed file could hold its subject', async () => {
    const contents: Record<string, string> = {
      'src/plain.js': "const fs = require('fs');\nmodule.exports = () => fs.readFileSync('reactor.txt');\n",
      'src/View.js': "import React from 'react';\nexport const View = () => React.createElement('div');\n",
      'src/client.mjs': 'import { createRoot } from "react-dom/client";\n',
      'src/legacy.cjs': "const { jsx } = require('react/jsx-runtime');\n",
    };
    const skipsFor = async (files: string[]) => (await pathSkips(files, async file => contents[file])).map(entry => entry.domain);
    assert.deepEqual(await skipsFor(['README.md', 'docs/guide.md']), ['react-ts', 'test-validity', 'devops']);
    for (const file of ['src/app.ts', 'ui/View.tsx', 'lib/a.mts', 'b.cts', 'c.jsx', 'src/View.js', 'src/client.mjs', 'src/legacy.cjs']) {
      assert.ok(!(await skipsFor([file])).includes('react-ts'), file);
    }
    for (const file of ['src/plain.js', 'lib/a.mjs', 'b.cjs']) assert.ok((await skipsFor([file])).includes('react-ts'), file);
    assert.deepEqual(
      (await pathSkips(['src/plain.js'], async file => contents[file])).find(entry => entry.domain === 'react-ts')?.reason,
      'no TypeScript, JSX, or React file changed (factory path rule)',
    );
    for (const file of ['test/a.ts', 'src/__tests__/b.ts', 'a.test.ts', 'b.spec.js', 'pkg/c_test.go', 'tests/test_d.py', 'spec/e.rb']) {
      assert.ok(!(await skipsFor([file])).includes('test-validity'), file);
    }
    for (const file of ['.github/workflows/ci.yml', 'Dockerfile', 'api/Dockerfile.prod', 'docker-compose.yml', 'Jenkinsfile', 'Makefile', 'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.build.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements-dev.txt', 'infra/main.tf', 'vite.config.ts', 'helm/chart.yaml']) {
      assert.ok(!(await skipsFor([file])).includes('devops'), file);
    }
    assert.deepEqual(await skipsFor(['src/contest.md', 'src/latest.ts']), ['test-validity', 'devops']);
  });

  it('keeps react-ts for a JavaScript file that imports React at the checked commit, not for plain or deleted ones', async () => {
    using ws = workspace();
    commit(ws, 'gone.js', "import React from 'react';\n");
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    rmSync(join(ws.root, 'gone.js'));
    sh(ws.root, 'add', '-A');
    commit(ws, 'ok');
    commit(ws, 'plain.js', 'module.exports = 1;\n');
    const plain = await step(ws, run => runChecks(ws, run));
    assert.ok(plain.passed);
    assert.ok(plain.pathSkipped.find(entry => entry.domain === 'react-ts'), `react-ts not skipped: ${JSON.stringify(plain.pathSkipped)}`);
    const plainReview = await step(ws, run => startReview(ws, run));
    assert.ok(plainReview.pathSkipped.find(entry => entry.domain === 'react-ts'), `react-ts not skipped: ${JSON.stringify(plainReview.pathSkipped)}`);

    commit(ws, 'view.js', "const React = require('react');\n");
    const react = await step(ws, run => runChecks(ws, run));
    assert.ok(react.passed);
    assert.deepEqual(react.pathSkipped.filter(entry => entry.domain === 'react-ts'), []);
    assert.deepEqual((await step(ws, run => startReview(ws, run))).pathSkipped.filter(entry => entry.domain === 'react-ts'), []);
  });

  it('skips path-ruled-out domains unless kept, alongside the orchestrator skips', async () => {
    using ws = workspace();
    const { domains, pathSkipped } = await openReview(ws, [], [{ domain: 'performance', reason: 'no hot path' }], slice('Feature'), []);
    assert.deepEqual(pathSkipped.map(entry => entry.domain), ['react-ts', 'test-validity', 'devops']);
    assert.deepEqual(domains, ['security', 'testing', 'holistic', 'thermo', 'bug', 'scope', 'comments']);
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r', domain: 'devops', findings: [], reviewId: '01-r1' })),
      /skipped the devops domain/,
    );

    using kept = workspace();
    await newRun(kept, [slice('Feature')]);
    await step(kept, run => nextSlice(kept, run));
    commit(kept, 'ok');
    await step(kept, run => runChecks(kept, run));
    await assert.rejects(
      step(kept, run => startReview(kept, run, [{ domain: 'devops', reason: 'none' }], ['devops'])),
      /both skipped and kept: devops/,
    );
    const opened = await step(kept, run => startReview(kept, run, [{ domain: 'react-ts', reason: 'orchestrator reason' }], ['devops']));
    assert.ok(opened.domains.includes('devops'));
    assert.deepEqual(opened.pathSkipped.map(entry => entry.domain), ['test-validity']);
    assert.deepEqual(readRun(kept, 'demo').slices[0]?.review?.skipped.map(entry => `${entry.domain}: ${entry.reason}`), [
      'test-validity: no test file changed (factory path rule)',
      'react-ts: orchestrator reason',
    ]);
  });

  it('lets the validator correct its verdict once, so a confirmed blocking finding blocks', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS) {
      const findings = domain === 'testing' ? [finding('testing', 'high', 'mutation-survives')] : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId, ...noFixItems(domain) }));
    }
    const validate = (agentId: string, input: { downgrade?: { id: string; reason: string }[]; keep: string[] }) =>
      step(ws, run => submitValidation(ws, run, { agentId, dropped: [], reviewId, ...input }));
    const downgrade = [{ id: 'testing-mutation-survives', reason: 'not a correctness or requirement gap' }];

    await validate('v', { downgrade, keep: [] });
    await assert.rejects(validate('other', { keep: ['testing-mutation-survives'] }), /validated by another agent/);
    await validate('v', { keep: ['testing-mutation-survives'] });
    await assert.rejects(validate('v', { downgrade, keep: [] }), /already corrected once/);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
  });

  it('refuses a validation after the review is recorded', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    await review(ws, reviewId, []);
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    await assert.rejects(step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped: [], keep: [], reviewId })), /already recorded/);
  });

  it('blocks on findings that break a recorded decision', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws, ['The shared field is a non-optional record.']);
    const submit = (domain: Finding['domain'], findings: Finding[]) =>
      step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId, ...noFixItems(domain) }));
    const declared = { ...finding('react-ts', 'high', 'undefined-field'), decision: 1 };

    await assert.rejects(submit('react-ts', [{ ...declared, severity: 'observation' }]), /breaks a recorded decision, so it must be critical or high/);
    await assert.rejects(submit('react-ts', [{ ...declared, decision: 2 }]), /names decision 2, but the review data lists 1 decisions/);
    for (const domain of REVIEW_DOMAINS) {
      await submit(domain, domain === 'react-ts' ? [declared] : domain === 'bug' ? [finding('bug', 'observation', 'missed-conflict')] : []);
    }
    const validate = (input: { downgrade?: { id: string; reason: string }[]; escalate?: { decision: number; id: string; reason: string }[]; keep: string[] }) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], reviewId, ...input }));
    const reason = 'breaks the decision';

    await assert.rejects(
      validate({ downgrade: [{ id: 'react-ts-undefined-field', reason }], keep: ['bug-missed-conflict'] }),
      /breaks a recorded decision cannot be downgraded/,
    );
    await assert.rejects(
      validate({ escalate: [{ decision: 1, id: 'react-ts-undefined-field', reason }], keep: ['bug-missed-conflict'] }),
      /Only observation findings can be escalated/,
    );
    await assert.rejects(
      validate({ escalate: [{ decision: 3, id: 'bug-missed-conflict', reason }], keep: ['react-ts-undefined-field'] }),
      /names decision 3, but the review data lists 1 decisions/,
    );
    await validate({ escalate: [{ decision: 1, id: 'bug-missed-conflict', reason }], keep: ['react-ts-undefined-field'] });

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 2);
    const fix = readFileSync(result.fixPath, 'utf8');
    assert.match(fix, /\[high\] bug-missed-conflict[\s\S]*- Breaks decision 1: The shared field is a non-optional record\./);
    assert.match(fix, /\[high\] react-ts-undefined-field[\s\S]*- Breaks decision 1:/);
  });

  it('escalates an observation that shows an unmet acceptance criterion, with no decision behind it', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run =>
        submitDomain(ws, run, {
          agentId: domain,
          domain,
          findings: domain === 'bug' ? [{ ...finding('bug', 'observation', 'kept-guard'), category: 'structure' }] : [],
          reviewId,
          ...noFixItems(domain),
        }),
      );
    }
    type Entry = { criterion?: string; decision?: number; id: string; reason: string };
    const validate = (escalate: Entry[]) => step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], escalate, keep: [], reviewId }));
    const reason = 'the code keeps the guard the criterion removes';
    const criterion = `Loop over the narrowed values with no runtime guard${' and keep every branch explicit'.repeat(20)}`;

    await assert.rejects(validate([{ id: 'bug-kept-guard', reason }]), /bug-kept-guard.*decision.*criterion/);
    await assert.rejects(validate([{ criterion, decision: 1, id: 'bug-kept-guard', reason }]), /bug-kept-guard.*decision.*criterion/);
    await validate([{ criterion, id: 'bug-kept-guard', reason }]);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
    assert.match(readFileSync(result.fixPath, 'utf8'), /\[high\] bug-kept-guard/);
    assert.match(readFileSync(result.fixPath, 'utf8'), new RegExp(`- Does not meet criterion: ${criterion}`));
  });

  it('refuses a reviewer-supplied criterion, so only the validator can name one in the fix file', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    const claimed = { ...finding('bug', 'high', 'claims-criterion'), criterion: 'Reviewer-chosen criterion' };
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'bug', domain: 'bug', findings: [claimed], reviewId, ...noFixItems('bug') })),
      /bug-claims-criterion.*criterion.*validator/,
    );
    const { criterion: _refused, ...plain } = claimed;
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run =>
        submitDomain(ws, run, { agentId: domain, domain, findings: domain === 'bug' ? [plain] : [], reviewId, ...noFixItems(domain) }),
      );
    }
    await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: ['bug-claims-criterion'], reviewId }));
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    const fix = readFileSync(result.fixPath, 'utf8');
    assert.match(fix, /\[high\] bug-claims-criterion/);
    assert.doesNotMatch(fix, /Does not meet criterion|Reviewer-chosen criterion/);
  });

  it('refuses every findingSchema field described as set by the validator', async () => {
    const samples: Record<string, unknown> = { criterion: 'Some acceptance criterion' };
    const fields = Object.entries(findingSchema.shape)
      .filter(([, schema]) => schema.description?.startsWith('Set by the validator'))
      .map(([name]) => name);
    assert.ok(fields.length > 0);
    assert.ok(fields.includes('criterion'));
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const field of fields) {
      assert.ok(field in samples, `no sample value for validator-set field "${field}"`);
      const claimed = { ...finding('bug', 'high', `claims-${field}`), [field]: samples[field] };
      await assert.rejects(
        step(ws, run => submitDomain(ws, run, { agentId: 'bug', domain: 'bug', findings: [claimed], reviewId, ...noFixItems('bug') })),
        new RegExp(`bug-claims-${field}.*${field}`),
      );
    }
  });

  it('refuses to escalate a blocking finding with a criterion', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run =>
        submitDomain(ws, run, {
          agentId: domain,
          domain,
          findings: domain === 'bug' ? [finding('bug', 'high', 'already-high')] : [],
          reviewId,
          ...noFixItems(domain),
        }),
      );
    }
    await assert.rejects(
      step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], escalate: [{ criterion: 'c', id: 'bug-already-high', reason: 'r' }], keep: [], reviewId })),
      /Only observation findings can be escalated/,
    );
  });

  it('takes the escalate entry through the factory_review_validate tool', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    bindRun(join(ws.root, '.git', 'software-factory-active-run.json'), { feature: 'demo', mainId: 'main', ws });
    const tools = load();
    const call = async (name: string, params: unknown, agent: 'factory-reviewer' | 'factory-review-validator') => {
      const caller = { ...ctx('sub', agent), cwd: ws.root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { notify() {} } };
      return tools.get(name)?.execute('id', params, undefined, undefined, caller);
    };
    for (const domain of REVIEW_DOMAINS) {
      const findings = domain === 'bug' ? [{ ...finding('bug', 'observation', 'kept-guard'), category: 'structure' }] : [];
      await call('factory_review_submit', { domain, findings, reviewId, ...noFixItems(domain) }, 'factory-reviewer');
    }
    const validate = (entry: object) => call('factory_review_validate', { dropped: [], escalate: [{ id: 'bug-kept-guard', reason: 'r', ...entry }], keep: [], reviewId }, 'factory-review-validator');

    const refusal = /^✖ "bug-kept-guard": an escalate entry gives exactly one of/;
    for (const entry of [{}, { criterion: 'c', decision: 1 }]) {
      await assert.rejects(validate(entry), (error: Error) => refusal.test(error.message) && !/invalid_union|expected never|"code"/.test(error.message));
    }
    await assert.rejects(
      call('factory_review_validate', { dropped: [], keep: [], reviewId: 'unknown' }, 'factory-review-validator'),
      (error: Error) => error.message === 'Review unknown is not the active review.',
    );
    await validate({ criterion: 'No runtime guard' });
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
  });

  it('skips the domains the orchestrator leaves out, but never the required ones', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => runChecks(ws, run));
    for (const domain of ['bug', 'scope', 'testing'] as const) {
      await assert.rejects(step(ws, run => startReview(ws, run, [{ domain, reason: 'small' }])), new RegExp(`always review this slice: ${domain}`));
    }
    await assert.rejects(
      step(ws, run => startReview(ws, run, [{ domain: 'devops', reason: 'a' }, { domain: 'devops', reason: 'b' }])),
      /appears twice/,
    );
    const opened = await step(ws, run => startReview(ws, run, [{ domain: 'react-ts', reason: 'no TypeScript or React' }], ['test-validity', 'devops']));
    assert.deepEqual(opened.domains, REVIEW_DOMAINS.filter(domain => domain !== 'react-ts'));
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'r', domain: 'react-ts', findings: [], reviewId: opened.reviewId })),
      /skipped the react-ts domain/,
    );
    for (const domain of opened.domains) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: [], reviewId: opened.reviewId, ...noFixItems(domain) }));
    }
    await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId: opened.reviewId }));
    assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
    assert.match(readRun(ws, 'demo').events.find(event => event.kind === 'review-start')?.detail ?? '', /skipped react-ts \(no TypeScript or React\)/);
  });

  it('lets a slice without test seams skip the testing domain', async () => {
    const docs = slice('Docs', [], { noTestReason: 'docs only', seams: [] });
    using ws = workspace();
    const { domains } = await openReview(ws, [], [{ domain: 'testing', reason: 'docs only' }, { domain: 'test-validity', reason: 'docs only' }], docs);
    assert.ok(!domains.includes('testing'));
  });

  it('merges duplicates across domains into the most severe kept finding', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    const same = { path: 'ok', problem: 'TS5097', title: 'ts-extension-import' };
    for (const domain of REVIEW_DOMAINS) {
      const findings =
        domain === 'react-ts'
          ? [{ ...finding('react-ts', 'high', 'ts5097'), ...same }]
          : domain === 'thermo' || domain === 'devops'
            ? [{ ...finding(domain, 'observation', 'ts5097'), ...same }]
            : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId, ...noFixItems(domain) }));
    }
    const validate = (keep: string[], dropped: { duplicateOf?: string; id: string; reason: string }[]) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));

    await assert.rejects(
      validate(['thermo-ts5097'], [
        { duplicateOf: 'thermo-ts5097', id: 'react-ts-ts5097', reason: 'same issue' },
        { duplicateOf: 'thermo-ts5097', id: 'devops-ts5097', reason: 'same issue' },
      ]),
      /Keep the most severe of the duplicates: "react-ts-ts5097" is high/,
    );
    await assert.rejects(
      validate(['react-ts-ts5097', 'devops-ts5097'], [{ duplicateOf: 'missing', id: 'thermo-ts5097', reason: 'same issue' }]),
      /not a kept finding/,
    );
    await validate(['react-ts-ts5097'], [
      { duplicateOf: 'react-ts-ts5097', id: 'thermo-ts5097', reason: 'same issue' },
      { duplicateOf: 'react-ts-ts5097', id: 'devops-ts5097', reason: 'same issue' },
    ]);
    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'fix');
    assert.equal(result.blocking, 1);
  });

  it('turns downgraded blocking findings into non-blocking observations', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS) {
      const findings =
        domain === 'thermo'
          ? [finding('thermo', 'high', 'extract-layer'), finding('thermo', 'observation', 'naming')]
          : domain === 'bug'
            ? [finding('bug', 'critical', 'unreachable-guard')]
            : [];
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings, reviewId, ...noFixItems(domain) }));
    }
    const validate = (downgrade: { id: string; reason: string }[], keep: string[]) =>
      step(ws, run => submitValidation(ws, run, { agentId: 'v', downgrade, dropped: [], keep, reviewId }));
    const reason = 'not a correctness or requirement gap';

    await assert.rejects(validate([{ id: 'thermo-naming', reason }], ['thermo-extract-layer', 'bug-unreachable-guard']), /Only critical or high findings can be downgraded: thermo-naming/);
    await validate([{ id: 'thermo-extract-layer', reason }, { id: 'bug-unreachable-guard', reason }], ['thermo-naming']);

    const result = await step(ws, run => recordReview(ws, run));
    assert.ok(result.kind === 'green');
    assert.equal(result.observations.length, 3);
    assert.match(result.observations.join('\n'), /\[observation\] thermo-extract-layer/);
  });

  it('rejects findings submitted after validation', async () => {
    using ws = workspace();
    const { reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS.filter(domain => domain !== 'bug')) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: [], reviewId, ...noFixItems(domain) }));
    }
    await step(ws, run => submitDomain(ws, run, { agentId: 'bug', domain: 'bug', findings: [], reviewId }));
    await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId }));
    await assert.rejects(
      step(ws, run => submitDomain(ws, run, { agentId: 'late', domain: 'security', findings: [finding('security', 'critical', 'late')], reviewId })),
      /already validated/,
    );
  });

  it('rejects a findings file edited after it was submitted', async () => {
    using ws = workspace();
    const { findingsDir, reviewId } = await openReview(ws);
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: domain === 'security' ? [finding('security', 'critical', 'leak')] : [], reviewId, ...noFixItems(domain) }));
    }
    writeFileSync(join(findingsDir, 'security.json'), '[]\n');
    await assert.rejects(step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId })), /changed after it was submitted/);
  });
});

describe('autonomous decisions', { concurrency: 4 }, () => {
  async function decisionReview(ws: Workspace, mode: 'headless' | 'interactive') {
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => void (run.mode = mode));
    await step(ws, run => nextSlice(ws, run));
    commit(ws, 'ok');
    await step(ws, run => recordDecisions(ws, run, ['Narrow reading: no export.']));
    await step(ws, run => runChecks(ws, run));
    return step(ws, run => startReview(ws, run, [], ['react-ts', 'test-validity', 'devops']));
  }

  it('records the author by run mode, marks autonomous ones in the review data, and loads old string decisions as user', async () => {
    using ws = workspace();
    const { dataFile } = await decisionReview(ws, 'headless');
    assert.deepEqual(readRun(ws, 'demo').decisions, [{ author: 'autonomous', text: 'Narrow reading: no export.' }]);
    assert.match(readFileSync(ticketPath(ws, 'demo', readRun(ws, 'demo').slices[0]!), 'utf8'), /1\. Narrow reading: no export\. \[AUTONOMOUS:/);
    assert.match(readFileSync(dataFile, 'utf8'), /1\. Narrow reading: no export\. \[AUTONOMOUS:[^\]]*not a waiver\]/);
    await step(ws, run => void (run.decisions = ['Old plain.'] as never));
    assert.deepEqual(readRun(ws, 'demo').decisions, [{ author: 'user', text: 'Old plain.' }]);
  });

  it('records user as the author in an interactive run', async () => {
    using ws = workspace();
    await newRun(ws, [slice('Feature')]);
    await step(ws, run => nextSlice(ws, run));
    await step(ws, run => recordDecisions(ws, run, ['User says so.']));
    assert.equal(readRun(ws, 'demo').decisions[0]?.author, 'user');
  });

  it('refuses to drop (even as a duplicate) or downgrade a blocking finding that cites an autonomous decision', async () => {
    using ws = workspace();
    const { reviewId } = await decisionReview(ws, 'headless');
    const cited = { ...finding('react-ts', 'high', 'cited'), decision: 1 };
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: domain === 'react-ts' ? [cited] : domain === 'bug' ? [finding('bug', 'high', 'dup')] : [], reviewId, ...noFixItems(domain) }));
    }
    const validate = (input: object) => step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [], keep: [], reviewId, ...input }));
    await assert.rejects(validate({ dropped: [{ id: 'react-ts-cited', reason: 'x' }], keep: ['bug-dup'] }), /autonomous decision cannot be dropped or downgraded/);
    await assert.rejects(validate({ dropped: [{ id: 'react-ts-cited', reason: 'x', duplicateOf: 'bug-dup' }], keep: ['bug-dup'] }), /autonomous decision cannot be dropped or downgraded/);
    // The downgrade is refused by the check that covers every decision, which runs before the autonomous one.
    await assert.rejects(validate({ downgrade: [{ id: 'react-ts-cited', reason: 'x' }], keep: ['bug-dup'] }), /breaks a recorded decision cannot be downgraded/);
    await validate({ keep: ['bug-dup', 'react-ts-cited'] });
  });

  it('still lets the validator drop a blocking finding that cites a user decision in an interactive run', async () => {
    using ws = workspace();
    const { reviewId } = await decisionReview(ws, 'interactive');
    const cited = { ...finding('react-ts', 'high', 'cited'), decision: 1 };
    for (const domain of REVIEW_DOMAINS) {
      await step(ws, run => submitDomain(ws, run, { agentId: domain, domain, findings: domain === 'react-ts' ? [cited] : domain === 'bug' ? [finding('bug', 'high', 'dup')] : [], reviewId, ...noFixItems(domain) }));
    }
    const result = await step(ws, run => submitValidation(ws, run, { agentId: 'v', dropped: [{ id: 'react-ts-cited', reason: 'x' }], keep: ['bug-dup'], reviewId }));
    assert.equal(result.dropped, 1);
  });
});
