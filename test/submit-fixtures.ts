import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, type Source, type Workspace } from '../src/run.ts';
import { completeSlice, recordDecisions } from '../src/review.ts';
import { approvePlan, nextSlice, parseRetro, planSlices, recordRetro, resolveBase, startRun } from '../src/workflow.ts';
import { commit, green, sh, slice, step, tempDir } from './helpers.ts';

// The submit tests are split across files so node --test runs them in parallel processes: fakeGh changes
// process.env.PATH, so tests that use it cannot run concurrently inside one process.

interface DoneRunOptions {
  /** Plans the run onto this landOn branch; by default on the configured base. */
  landOn?: string;
  source?: Source;
  decisions?: string[];
  /** Takes the active slice (0-based `index`) from its committed work to a green review; by default one clean round. */
  toGreen?: (index: number) => Promise<unknown>;
}

/**
 * A done run of `count` chained slices `S1`…, each with a reviewed commit (`ok` for slice 01, `s<N>.txt` after it),
 * checked out on `main` (off the top slice). Returns the slice branches.
 */
export async function doneRun(ws: Workspace, count: number, { decisions = [], landOn, source = { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' }, toGreen = () => green(ws) }: DoneRunOptions = {}) {
  const titles = Array.from({ length: count }, (_, index) => `S${index + 1}`);
  await startRun(ws, { feature: 'demo', sessionId: 's', source });
  const base = landOn === undefined ? undefined : await resolveBase(ws, { landOn });
  const inputs = titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? '']));
  await step(ws, run => approvePlan(ws, run, planSlices(ws, run, inputs, base), base));
  if (decisions.length > 0) await step(ws, run => recordDecisions(ws, run, decisions));
  for (const [index] of titles.entries()) {
    await step(ws, run => nextSlice(ws, run));
    commit(ws, index === 0 ? 'ok' : `s${index + 1}.txt`);
    await toGreen(index);
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
  /** The stack `stack view --json` serves after `stack submit`, with each branch's PR number (none: no `pr`); `noUrl` leaves the PR's url out. */
  submitted?: { name: string; noUrl?: boolean; pr?: number }[];
}

/** The branches as a submitted stack, with PRs numbered from 101. */
export const withPrs = (branches: string[]) => branches.map((name, index) => ({ name, pr: 101 + index }));

/** The `gh api` calls that set the title of PR 101 onwards to `demo: NN Sn`. */
export const titleCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f title=demo: 0${index + 1} S${index + 1}`);

/**
 * Puts a fake `gh` first on PATH until the `using` scope that holds it ends, then removes it; it records each call.
 * With a stack, `stack checkout <branch>` switches to that branch, as gh-stack does; `stack init` switches to its last
 * (top) branch, `stack top` to the stack's top branch, and `stack add <branch>` to the branch it adds.
 */
export function fakeGh({ stack, checkoutFailure = NO_STACK, fail = '', onFail = ':', submitted }: FakeGh) {
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
    const items = submitted.map(({ name, noUrl = false, pr }) =>
      pr === undefined ? { name } : { name, pr: { number: pr, state: 'OPEN', ...(noUrl ? {} : { url: `https://example.test/pull/${pr}` }) } },
    );
    writeFileSync(after, JSON.stringify({ branches: items, currentBranch: submitted.at(-1)?.name, trunk: 'main' }));
  }
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    `if [ "$1 $2" = "stack checkout" ] && [ ! -f '${view}' ]; then echo "${checkoutFailure.stderr}" >&2; exit ${checkoutFailure.code}; fi`,
    `if [ "$1 $2" = "stack checkout" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = "stack view" ]; then cat '${view}' || exit 1; fi`,
    `if [ "$1 $2" = "stack init" ]; then eval "git switch -q \\"\\\${$#}\\"" || exit 1; fi`,
    `if [ "$1 $2" = "stack top" ]; then git switch -q "$(cat '${join(dir, 'top')}')" || exit 1; fi`,
    `if [ "$1 $2" = "stack add" ]; then git switch -q "$3" || exit 1; fi`,
    `if [ "$1 $2" = '${fail}' ]; then ${onFail}; exit 1; fi`,
    `if [ "$1 $2" = "stack submit" ]; then echo 'gh stack submitted'; fi`,
    `if [ "$1 $2" = "stack submit" ] && [ -f '${after}' ]; then cp '${after}' '${view}'; fi`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), script);
  chmodSync(join(dir, 'gh'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    // Removes only this fake's PATH entry, so several fakes in one test clean up in any order.
    [Symbol.dispose]: () => {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
      temp[Symbol.dispose]();
    },
  };
}
