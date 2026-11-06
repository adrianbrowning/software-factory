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
import { gh, git } from './exec.ts';
import { head, requireClean } from './repo.ts';
import { addEvent, greenCommit, type Run, type Workspace } from './run.ts';

/** The part of `gh stack view --json` submit reads: the stack's branches, bottom (closest to trunk) first, with each branch's PR when it has one. */
const stackView = z.object({ branches: z.array(z.object({ name: z.string(), pr: z.object({ number: z.number() }).optional() })) });

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

/**
 * Submits the reviewed stack. On a first submit it adopts every slice branch into one gh-stack stack and opens draft
 * PRs; on a re-submit, when slice 01 is already stacked, it adds only the slice branches that stack lacks.
 * A run with `landOn` stacks onto that branch (its trunk), and is refused before any gh call while origin lacks it;
 * submit never pushes or moves the landOn branch. Never merges.
 * Only the user-invoked `/factory submit` command calls this; no model-callable tool does. `progress` names each step
 * before it starts, so the user sees what the submit is waiting on.
 */
export async function submitStack(ws: Workspace, run: Run, progress: (step: string) => void = () => {}) {
  if (run.status !== 'done') throw new Error(`Run "${run.feature}" is ${run.status}; its stack is not ready.`);
  progress('checking the working tree and the slice branches');
  await requireClean(ws.root, 'Cannot submit the stack');
  const unreviewed: string[] = [];
  for (const slice of run.slices) {
    const tip = (await git(ws.root, 'rev-parse', `refs/heads/${slice.branch}`)).trim();
    if (tip !== greenCommit(slice)) unreviewed.push(slice.branch);
  }
  if (unreviewed.length > 0) {
    throw new Error(
      `These branches moved after their green review and were not submitted: ${unreviewed.join(', ')}. To keep the new commits, ask the orchestrator to re-gate them: factory_reopen on that slice gives them checks and a full review. Otherwise reset each branch to its reviewed commit.`,
    );
  }
  if (run.landOn !== undefined) {
    progress(`checking that origin has ${run.landOn}`);
    const heads = await git(ws.root, 'ls-remote', '--heads', 'origin', `refs/heads/${run.landOn}`).catch((cause: unknown) => {
      throw new Error(
        `Submit could not read origin to check for ${run.landOn}. Make sure the origin remote exists and has the branch (git push origin ${run.landOn}), then run /factory submit again. Nothing was submitted.`,
        { cause },
      );
    });
    if (heads.trim() === '') {
      throw new Error(`${run.landOn} is not on origin, so its slice PRs have no branch to target. Push it first (git push origin ${run.landOn}), then run /factory submit again. Nothing was submitted.`);
    }
  }
  const branches = run.slices.map(slice => slice.branch);
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
    progress(`pushing ${run.slices.length} branches and opening draft PRs (gh stack submit; this can take a few minutes)`);
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
  // The stack and its PRs are now on GitHub; a title failure leaves the checkout where gh stack put it.
  try {
    await setTitles(ws.root, run, progress);
  } catch (caught) {
    throw new Error(
      `The stack and its PRs were submitted, but the PR titles were not set: ${caught instanceof Error ? caught.message : String(caught)}\nRunning /factory submit again sets them.`,
      { cause: caught },
    );
  }
  return output;
}

/**
 * Sets every slice PR's title to `<feature>: NN <slice title>`, overwriting any other title. Uses the REST API, not
 * `gh pr edit`, which fails on repositories with Projects (classic). Fails, setting no title, when a slice has no PR.
 */
async function setTitles(root: string, run: Run, progress: (step: string) => void) {
  progress('setting the slice PR titles');
  const view = stackView.parse(JSON.parse(await gh(root, 'stack', 'view', '--json')));
  const prs = new Map(view.branches.map(item => [item.name, item.pr?.number]));
  const missing = run.slices.filter(slice => prs.get(slice.branch) === undefined).map(slice => slice.branch);
  if (missing.length > 0) throw new Error(`gh stack submit left these slice branches with no PR: ${missing.join(', ')}.`);
  for (const slice of run.slices) {
    await gh(root, 'api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${prs.get(slice.branch)}`, '-f', `title=${run.feature}: ${slice.id} ${slice.title}`);
  }
}
