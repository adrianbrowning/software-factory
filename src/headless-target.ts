import { basename } from 'node:path';
import { requireFeatureName } from './feature-name.ts';
import { RELATED_MAX, type SourceInput } from './source.ts';

/**
 * What `/factory headless <issue ref> [--related <ref>,<ref>] [--base <branch>]` starts a run from, and the run's name. A GitHub issue (`102`, `#102`, or its
 * URL) is named `issue-<n>` after its number; anything else is an issue file, named after its file name in kebab-case.
 * `--base` names the local branch the run builds on, returned as `base`. `--related` adds issue refs (number, `#number` or issue URL) as `source.related`; it needs a GitHub primary ref.
 */
export function headlessTarget(argument: string): { base?: string; feature: string; source: SourceInput } {
  const { base, rest } = extractBase(argument);
  const target = targetWithoutBase(rest);
  return base === undefined ? target : { base, ...target };
}

/** Takes `--base <branch>` out of the argument, wherever it sits after the primary ref. */
function extractBase(argument: string) {
  const flag = /\s+--base(?=\s|$)(?:\s+(\S+))?/g;
  const found = [...argument.matchAll(flag)];
  if (found.length > 1) throw new Error('--base takes one branch; it was given more than once.');
  const match = found[0];
  if (match === undefined) return { rest: argument };
  const base = match[1];
  if (base === undefined || base.startsWith('--')) throw new Error('--base needs a value: the name of an existing local branch.');
  return { base, rest: argument.slice(0, match.index) + argument.slice(match.index + match[0].length) };
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
