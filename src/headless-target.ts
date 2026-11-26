import { basename } from 'node:path';
import { requireFeatureName } from './feature-name.ts';
import { RELATED_MAX, type SourceInput } from './source.ts';

/**
 * What `/factory headless <issue ref> [--related <ref>,<ref>] [--base <branch>] [--max-rounds <n>]` starts a run from, and the run's name. A GitHub issue (`102`, `#102`, or its
 * URL) is named `issue-<n>` after its number; anything else is an issue file, named after its file name in kebab-case.
 * `--base` names the local branch the run builds on, returned as `base`. `--related` adds issue refs (number, `#number` or issue URL) as `source.related`; it needs a GitHub primary ref.
 * `--max-rounds` sets the run's fix rounds per slice, returned as `maxRounds`.
 */
export function headlessTarget(argument: string): { base?: string; feature: string; maxRounds?: number; source: SourceInput } {
  const rounds = extractFlag(argument, 'max-rounds', 'number', 'a positive whole number');
  if (rounds.value !== undefined && !(/^[1-9]\d*$/.test(rounds.value) && Number.isSafeInteger(Number(rounds.value)))) throw new Error('--max-rounds needs a value: a positive whole number.');
  const { value: base, rest } = extractFlag(rounds.rest, 'base', 'branch', 'the name of an existing local branch');
  const target = targetWithoutBase(rest);
  return { ...(base === undefined ? {} : { base }), ...target, ...(rounds.value === undefined ? {} : { maxRounds: Number(rounds.value) }) };
}

/** Takes `--<name> <value>` out of the argument, wherever it sits after the primary ref. */
function extractFlag(argument: string, name: string, noun: string, value: string) {
  const flag = new RegExp(`\\s+--${name}(?=\\s|$)(?:\\s+(\\S+))?`, 'g');
  const found = [...argument.matchAll(flag)];
  if (found.length > 1) throw new Error(`--${name} takes one ${noun}; it was given more than once.`);
  const match = found[0];
  if (match === undefined) return { rest: argument };
  const given = match[1];
  if (given === undefined || given.startsWith('--')) throw new Error(`--${name} needs a value: ${value}.`);
  return { rest: argument.slice(0, match.index) + argument.slice(match.index + match[0].length), value: given };
}

function targetWithoutBase(argument: string): { feature: string; source: SourceInput } {
  const split = /^(.*?)\s+--related(?:\s+(.*))?$/s.exec(argument);
  const ref = split === null ? argument : split[1]!;
  const target = headlessPrimary(ref);
  if (split === null) return target;
  if (target.source.kind !== 'github') throw new Error('--related needs a GitHub issue as the primary ref, not an issue file.');
  if ((split[2] ?? '').trim() === '') throw new Error('--related needs a value: a comma-separated list of issue numbers, #numbers or GitHub issue URLs.');
  const items = split[2]!.trim().split(',').map(item => item.trim());
  const related = items.map(item => {
    if (item === '') throw new Error('--related has an empty item in its comma-separated list.');
    const bare = /^#?(\d+)$/.exec(item);
    if (bare?.[1] !== undefined) return bare[1];
    if (isIssueUrl(item)) return item;
    throw new Error(`--related takes a comma-separated list of issue numbers, #numbers or GitHub issue URLs; "${item}" is not one.`);
  });
  if (related.length > RELATED_MAX) throw new Error(`--related takes at most ${RELATED_MAX} issue refs (the limit is ${RELATED_MAX}).`);
  return { feature: target.feature, source: { ...target.source, related } };
}

function isIssueUrl(item: string) {
  try {
    const url = new URL(item);
    return url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function headlessPrimary(ref: string): { feature: string; source: SourceInput } {
  const bare = /^#?(\d+)$/.exec(ref);
  const issue = bare ?? /github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/.exec(ref);
  if (issue?.[1] !== undefined) return { feature: `issue-${issue[1]}`, source: { kind: 'github', ref: bare === null ? ref : issue[1] } };
  const name = basename(ref).replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  if (name === '') throw new Error(`Cannot name a run after "${ref}". Give an issue number, an issue URL, or a file with letters or digits in its name.`);
  return { feature: requireFeatureName(name), source: { kind: 'file', ref } };
}

/**
 * The start line a `/factory headless` run sends the orchestrator: it names the run's base and the branch its PRs target.
 * Without `--base` the base is the configured base (`configured`); with `--base` it is that branch at the first 12
 * characters of its pinned sha, and a base that is neither the configured base nor the trunk adds a warning that the
 * stack carries that branch's commits until it merges.
 */
export function headlessStartMessage(run: { baseBranch?: string | undefined; baseRef: string; baseSha?: string | undefined; trunk: string }, configured: string): string {
  const branch = run.baseBranch;
  if (branch === undefined) return `Base: ${run.baseRef} (the configured base); PRs target ${run.trunk}; slice 01 branches from ${run.baseRef} when the plan is approved.`;
  const named = `Base: ${branch} at ${(run.baseSha ?? '').slice(0, 12)}; PRs target ${run.trunk}.`;
  if (branch === configured || branch === run.trunk) return named;
  return `${named} Warning: "${branch}" is not the configured base (${configured}) or the PR target (${run.trunk}); the stack carries the commits of ${branch} until it merges.`;
}
