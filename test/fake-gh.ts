import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';

const NO_STACK = { code: 2, stderr: '✗ no local or remote stack found for "$3"' };

export interface FakeGh {
  /** The stack `stack view --json` serves (a raw string is served as is); undefined means no stack. */
  stack: string[] | string | undefined;
  /** How `stack checkout` fails without a stack; by default gh-stack's real "no stack" exit and stderr. */
  checkoutFailure?: { code: number; stderr: string };
  /** The subcommand (such as `stack submit`) that runs `onFail` and exits 1. */
  fail?: string;
  onFail?: string;
  /** The stack `stack view --json` serves after `stack submit`, with each branch's PR number (none: no `pr`). */
  submitted?: { name: string; pr?: number }[];
}

/** The branches as a submitted stack, with PRs numbered from 101. */
export const withPrs = (branches: string[]) => branches.map((name, index) => ({ name, pr: 101 + index }));

/** The `gh api` calls that set the title, then the body, of PR 101 onwards (`demo: NN Sn`); `calls()` abbreviates a body to `…`. */
export const prCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => [
    `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f title=demo: 0${index + 1} S${index + 1}`,
    `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f body=…`,
  ]).flat();

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
    bodies: () => new Map(raw().map(call => /pulls\/(\d+) -f body=([\s\S]*)/.exec(call)).filter((match): match is RegExpExecArray => match !== null).map(match => [Number(match[1]), match[2] ?? ''] as const)),
    // Removes only this fake's PATH entry, so several fakes in one test clean up in any order.
    [Symbol.dispose]: () => {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
      temp[Symbol.dispose]();
    },
  };
}

