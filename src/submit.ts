/*
 * The gh / gh-stack CLI contract submit relies on (observed against the real CLI):
 * - `gh stack checkout <branch>` for a branch in no stack exits 2 with stderr `no local or remote stack found for "<branch>"`;
 *   a 401 exits 4 with `failed to list stacks: HTTP 401`.
 * - `gh stack view --json` prints {trunk, currentBranch, branches: [{name, head, base, isCurrent, isMerged, isQueued,
 *   needsRebase, pr?: {number, url, state}}]}: branches bottom first, trunk not in branches, `pr` left out for a branch
 *   with no PR.
 * - `gh api` fills `{owner}/{repo}` in the endpoint from the current repo.
 * - `gh pr edit` fails with a Projects (classic) deprecation error, so PR titles go through `gh api -X PATCH`.
 */
import { z } from 'zod';
import { redact } from './evidence.ts';
import { gh, git } from './exec.ts';
import { head, requireClean } from './repo.ts';
import { addEvent, greenCommit, type Run, type Slice, type Workspace } from './run.ts';

/** The part of `gh stack view --json` submit reads: the stack's branches, bottom (closest to trunk) first, with each branch's PR when it has one. */
const stackView = z.object({ branches: z.array(z.object({ name: z.string(), pr: z.object({ number: z.number(), url: z.string().optional() }).optional() })) });

export type SubmitPlan = { kind: 'init' } | { kind: 'refuse'; outside: string[]; unordered: string[] } | { kind: 'add'; missing: string[] };

/**
 * Decides what submit does with the gh stack that holds slice 01: `stacked` is that stack's branches (bottom first), or
 * undefined when slice 01 is in no stack. A stack must hold a prefix of the run's `branches`, in run order; submit then
 * adds the branches it lacks (possibly none).
 */
export function planSubmit(stacked: string[] | undefined, branches: string[]): SubmitPlan {
  if (stacked === undefined) return { kind: 'init' };
  const outside = stacked.filter(name => !branches.includes(name));
  const unordered = stacked.filter((name, index) => branches.includes(name) && branches[index] !== name);
  if (outside.length > 0 || unordered.length > 0) return { kind: 'refuse', outside, unordered };
  return { kind: 'add', missing: branches.slice(stacked.length) };
}

/**
 * Checks out `branch` with gh stack and returns its stack's branches, or undefined when it is in no stack. Only
 * gh-stack's "no stack" checkout failure means that; any other failure, and a failed or malformed view, propagates.
 */
async function readStack(root: string, branch: string) {
  try {
    await gh(root, 'stack', 'checkout', branch);
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('no local or remote stack found for')) return undefined;
    throw error;
  }
  return stackView.parse(JSON.parse(await gh(root, 'stack', 'view', '--json'))).branches.map(item => item.name);
}

/** The stack was submitted (the `submit` event is on the run) but writing the PR titles or bodies failed. */
export class PrTextsFailed extends Error {}

/**
 * Submits the reviewed stack. On a first submit it adopts every slice branch into one gh-stack stack and opens draft
 * PRs; on a re-submit, when slice 01 is already stacked, it adds only the slice branches that stack lacks.
 * A run with `landOn` instead fast-forwards that local branch to the top slice; no PRs are opened. Never merges.
 * The user-invoked `/factory submit` command calls this, and so does a headless run's own submission (`submitHeadless`);
 * with `stop`, a paused headless run submits only the done slices below the stopped one. `progress` names each step
 * before it starts, so the user sees what the submit is waiting on.
 */
export async function submitStack(ws: Workspace, run: Run, progress: (step: string) => void = () => {}, stop?: Stop) {
  if (stop === undefined ? run.status !== 'done' : run.status !== 'paused') throw new Error(`Run "${run.feature}" is ${run.status}; its stack is not ready.`);
  // A stopped stack submits only the done slices below the stopped one.
  const slices = stop === undefined ? run.slices : doneBelow(run, stop.slice);
  if (slices.length === 0) return '';
  if (stop !== undefined && run.landOn !== undefined) throw new Error(`Run "${run.feature}" lands on ${run.landOn}: a stopped stack opens no PRs.`);
  progress('checking the working tree and the slice branches');
  await requireClean(ws.root, 'Cannot submit the stack');
  const unreviewed: string[] = [];
  for (const slice of slices) {
    const tip = (await git(ws.root, 'rev-parse', `refs/heads/${slice.branch}`)).trim();
    if (tip !== greenCommit(slice)) unreviewed.push(slice.branch);
  }
  if (unreviewed.length > 0) {
    throw new Error(
      `These branches moved after their green review and were not submitted: ${unreviewed.join(', ')}. To keep the new commits, ask the orchestrator to re-gate them: factory_reopen on that slice gives them checks and a full review. Otherwise reset each branch to its reviewed commit.`,
    );
  }
  if (run.landOn !== undefined) {
    progress(`fast-forwarding ${run.landOn} to the top slice`);
    return landStack(ws, run, run.landOn);
  }
  const branches = slices.map(slice => slice.branch);
  const bottom = branches[0];
  if (bottom === undefined) throw new Error(`Run "${run.feature}" has no slices to submit.`);
  progress(`reading the gh stack that holds ${bottom}`);
  // `gh stack checkout` and the gh stack steps after it move HEAD; on a refusal or any failure, submit switches back to
  // where it started, so a refused submit changes nothing. A successful submit stays where gh stack leaves it.
  const start = await git(ws.root, 'symbolic-ref', '-q', '--short', 'HEAD').then(
    name => [name.trim()],
    async () => ['--detach', await head(ws.root)],
  );
  let output: string;
  const added: string[] = [];
  try {
    const plan = planSubmit(await readStack(ws.root, bottom), branches);
    if (plan.kind === 'init') {
      progress(`adopting ${branches.length} branches into a gh stack onto ${run.trunk}`);
      await gh(ws.root, 'stack', 'init', '--base', run.trunk, ...branches);
    } else if (plan.kind === 'refuse') {
      const problems = [
        plan.outside.length > 0 ? `branches outside the run: ${plan.outside.join(', ')}` : '',
        plan.unordered.length > 0 ? `run branches out of run order: ${plan.unordered.join(', ')}` : '',
      ].filter(Boolean);
      throw new Error(`The gh stack holding ${bottom} has ${problems.join('; ')}. Nothing was submitted; fix the stack with gh stack, then submit again.`);
    } else {
      const { missing } = plan;
      progress(missing.length === 0
        ? `the gh stack already holds all ${branches.length} slice branches`
        : `adding ${missing.length} ${missing.length === 1 ? 'branch' : 'branches'} to the existing gh stack: ${missing.join(', ')}`);
      // `gh stack checkout` left the bottom slice checked out; move to the top so a submit always ends on the top slice, even when no branch is added.
      await gh(ws.root, 'stack', 'top');
      for (const branch of missing) {
        await gh(ws.root, 'stack', 'add', branch);
        added.push(branch);
      }
    }
    progress(`pushing ${slices.length} branches and opening draft PRs (gh stack submit; this can take a few minutes)`);
    output = await gh(ws.root, 'stack', 'submit', '--auto');
  } catch (caught) {
    const error = added.length === 0
      ? caught
      : new Error(
          `${caught instanceof Error ? caught.message : String(caught)}\nAlready added to the gh stack: ${added.join(', ')}; run /factory submit again to add the rest and submit.`,
          { cause: caught },
        );
    try {
      await git(ws.root, 'switch', '-q', ...start);
    } catch (switchError) {
      const original = error instanceof Error ? error.message : String(error);
      const failure = switchError instanceof Error ? switchError.message : String(switchError);
      throw new Error(`${original}\nSwitching back to ${start.at(-1)} also failed: ${failure}`, { cause: error });
    }
    throw error;
  }
  addEvent(run, 'submit', 'stack submitted as draft PRs');
  let urls: string[] = [];
  let failed: Error | undefined;
  // The stack and its PRs are now on GitHub; a title failure leaves the checkout where gh stack put it, except for a
  // stopped stack, which goes back to where the run is (the stopped slice) on every exit.
  try {
    urls = await setPrTexts(ws.root, run, slices, stop, progress);
  } catch (caught) {
    failed = new PrTextsFailed(
      `The stack and its PRs were submitted, but the PR titles were not set: ${caught instanceof Error ? caught.message : String(caught)}\nRunning /factory submit again sets them.`,
      { cause: caught },
    );
  } finally {
    if (stop !== undefined) {
      try {
        await git(ws.root, 'switch', '-q', ...start);
      } catch (switchError) {
        const failure = switchError instanceof Error ? switchError.message : String(switchError);
        failed = new PrTextsFailed(
          `${failed?.message ?? 'The stack and its PRs were submitted'}\nSwitching back to ${start.at(-1)} also failed: ${failure}`,
          { cause: failed ?? switchError },
        );
      }
    }
  }
  if (failed !== undefined) throw failed;
  return `${output.trim()}\nPull requests:\n${urls.map(url => `- ${url}`).join('\n')}`.trim();
}

/** The unbroken run of done slices from the bottom up to (not including) `stopped`; throws when `stopped` is not a slice of the run. */
function doneBelow(run: Run, stopped: Slice) {
  const index = run.slices.findIndex(slice => slice.id === stopped.id);
  if (index < 0) throw new Error(`Slice ${stopped.id} is not a slice of run "${run.feature}".`);
  const below: Slice[] = [];
  for (const slice of run.slices.slice(0, index)) {
    if (slice.status !== 'done') break;
    below.push(slice);
  }
  return below;
}

/** The slice a headless run stopped at, and why; the PR bodies of the done slices below it say so. */
export type Stop = { reason: string; slice: Slice };

const BODY_LIMIT = 60_000;
const MARKER = '… (truncated)';

/** `text` cut to at most `max` characters, ending with a visible marker when it was cut. */
function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - MARKER.length)}${MARKER}`;
}

/**
 * The PR body of `slice`, written from run state: the issue link, the slice summary and acceptance criteria, the checks
 * it passed, its review rounds, the run's autonomous decisions and gate choices, its accepted-unresolved findings, and
 * its deferred items with their sink locations (the retro's items go on the top submitted slice). A stopped stack says
 * where and why it stopped.
 */
export function prBody(run: Run, slice: Slice, submitted: Slice[], stop?: Stop) {
  const list = (items: string[]) => {
    if (items.length === 0) return 'None.';
    const lines: string[] = [];
    let used = 0;
    for (const item of items) {
      const line = `- ${clip(redact(item), 1_000)}`;
      if (used + line.length + 1 > 6_900) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length < items.length) lines.push(`…and ${items.length - lines.length} more (truncated)`);
    return lines.join('\n');
  };
  const issue = run.source.url ?? `${run.source.kind} ${run.source.ref}`;
  const top = submitted.at(-1) === slice;
  const deferred = run.deferred.filter(item => item.slice === slice.id || (top && item.slice === 'retro'));
  const autonomous = [
    ...run.decisions.filter(decision => decision.author === 'autonomous').map(decision => decision.text),
    ...run.events.filter(event => event.kind === 'autonomous').map(event => event.detail),
  ];
  const sections = [
    `Issue: ${clip(redact(issue), 1_000)} (${clip(redact(run.source.title), 1_000)})`,
    ...(stop === undefined ? [] : [`**The stack stopped at slice ${clip(redact(stop.slice.id), 100)} "${clip(redact(stop.slice.title), 500)}", which is not submitted:** ${clip(redact(stop.reason), 2_000)}`]),
    `## Slice ${clip(redact(slice.id), 100)}: ${clip(redact(slice.title), 500)}\n\n${clip(redact(slice.whatToBuild), 15_000)}\n\nAcceptance:\n${list(slice.acceptance)}`,
    `## Checks run\n\n${list(slice.checked?.results ?? run.checks)}`,
    `## Review rounds\n\n${slice.reviews} ${slice.reviews === 1 ? 'review' : 'reviews'}, ${slice.fixRounds} fix ${slice.fixRounds === 1 ? 'round' : 'rounds'}.`,
    `## Autonomous decisions\n\n${list(autonomous)}`,
    `## Accepted unresolved\n\n${list(slice.unresolved ?? [])}`,
  ];
  const head = '## Deferred items\n\n';
  const budget = BODY_LIMIT - sections.join('\n\n').length - 2 - head.length;
  const full = deferred.map(item => `- ${clip(redact(item.title), 120)}: ${redact(item.location)}`);
  const bare = deferred.map(item => `- ${redact(item.location)}`);
  const size = (line: string) => line.length + 1;
  const moreLine = (from: number) => {
    const locations = [...new Set(deferred.slice(from).map(item => redact(item.location)))];
    const sink = locations.every(location => /^https?:\/\//.test(location))
      ? 'the issues are listed in the run state'
      : clip(locations.join(', '), 500);
    return `…and ${deferred.length - from} more deferred items: ${sink} (truncated)`;
  };
  // Tier 1: full lines for a leading run, location-only lines for the rest, as many full lines as the budget allows.
  let used = bare.reduce((sum, line) => sum + size(line), 0);
  let fullCount = 0;
  if (used <= budget) {
    while (fullCount < full.length && used - size(bare[fullCount]!) + size(full[fullCount]!) <= budget) {
      used += size(full[fullCount]!) - size(bare[fullCount]!);
      fullCount++;
    }
  }
  let shown = [...full.slice(0, fullCount), ...bare.slice(fullCount)];
  if (used > budget) {
    // Tier 2: not even location-only lines fit; keep what fits, then one count line naming the sink.
    let kept = 0;
    let sum = 0;
    while (kept < bare.length && sum + size(bare[kept]!) + 600 <= budget) sum += size(bare[kept++]!);
    shown = [...bare.slice(0, kept), moreLine(kept)];
  }
  sections.push(`${head}${shown.length === 0 ? 'None.' : shown.join('\n')}`);
  return clip(redact(sections.join('\n\n')), BODY_LIMIT);
}

/**
 * Sets every submitted slice PR's title to `<feature>: NN <slice title>` and its body from run state, overwriting any other title and body. Returns the PR URLs. Uses the REST API, not
 * `gh pr edit`, which fails on repositories with Projects (classic). Fails, setting no title, when a slice has no PR.
 */
async function setPrTexts(root: string, run: Run, slices: Slice[], stop: Stop | undefined, progress: (step: string) => void) {
  progress('setting the slice PR titles and bodies');
  const view = stackView.parse(JSON.parse(await gh(root, 'stack', 'view', '--json')));
  const prs = new Map(view.branches.map(item => [item.name, item.pr?.number]));
  const missing = slices.filter(slice => prs.get(slice.branch) === undefined).map(slice => slice.branch);
  if (missing.length > 0) throw new Error(`gh stack submit left these slice branches with no PR: ${missing.join(', ')}.`);
  for (const slice of slices) {
    const endpoint = `repos/{owner}/{repo}/pulls/${prs.get(slice.branch)}`;
    await gh(root, 'api', '-X', 'PATCH', endpoint, '-f', `title=${run.feature}: ${slice.id} ${slice.title}`);
    await gh(root, 'api', '-X', 'PATCH', endpoint, '-f', `body=${prBody(run, slice, slices, stop)}`);
  }
  const urls = new Map(view.branches.map(item => [item.name, item.pr?.url]));
  return slices.flatMap(slice => urls.get(slice.branch) ?? []);
}

/**
 * Fast-forwards `landOn` to the top slice's green commit with a compare-and-swap ref update: no checkout, no merge
 * commit, and a branch that moved since the ancestry check is left alone.
 */
async function landStack(ws: Workspace, run: Run, landOn: string) {
  const top = run.slices.at(-1);
  const green = top === undefined ? undefined : greenCommit(top);
  if (top === undefined || green === undefined) throw new Error(`Run "${run.feature}" has no reviewed slice to land.`);
  const ref = `refs/heads/${landOn}`;
  // Any worktree (this one or a linked one) with the branch checked out would be left behind by the ref update.
  const worktree = (await git(ws.root, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .map(block => block.split('\n'))
    .find(lines => lines.includes(`branch ${ref}`));
  if (worktree !== undefined) {
    const path = worktree[0]?.replace(/^worktree /, '');
    throw new Error(`${landOn} is checked out in ${path}, and moving it would leave that working tree behind. Switch it to another branch, then run /factory submit again.`);
  }
  let old: string;
  try {
    old = (await git(ws.root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim();
    await git(ws.root, 'merge-base', '--is-ancestor', old, green);
  } catch {
    throw new Error(`${landOn} is gone or moved off the stack's base, so it cannot fast-forward to ${top.branch}. Nothing changed.`);
  }
  await git(ws.root, 'update-ref', '-m', `factory: land ${run.feature}`, ref, green, old);
  const landed = `${landOn} fast-forwarded to ${top.branch} (${green.slice(0, 12)})`;
  addEvent(run, 'submit', landed);
  return `${landed}. No PRs were opened.\n`;
}
