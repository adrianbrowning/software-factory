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
import { type SlicePr, writeHandoff } from './handoff.ts';
import { head, requireClean } from './repo.ts';
import { addEvent, greenCommit, type Run, type Workspace } from './run.ts';

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

/**
 * Submits the reviewed stack. On a first submit it adopts every slice branch into one gh-stack stack and opens draft
 * PRs; on a re-submit, when slice 01 is already stacked, it adds only the slice branches that stack lacks.
 * A run with `landOn` stacks onto that branch (its trunk), and is refused before any gh call while origin lacks it or
 * origin's tip of it is not the local one; submit never pushes or moves the landOn branch. For a landOn run, once the
 * PRs are titled, it also writes the single-PR handoff (pr.md) and returns what the user does next. Never merges, and
 * never opens the PR from landOn to the trunk.
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
    progress(`checking that origin has ${run.landOn} at its local tip`);
    const heads = await git(ws.root, 'ls-remote', '--heads', 'origin', `refs/heads/${run.landOn}`).catch((cause: unknown) => {
      throw new Error(
        `Submit could not read origin to check for ${run.landOn}. Make sure the origin remote exists and has the branch (git push origin ${run.landOn}), then run /factory submit again. Nothing was submitted.`,
        { cause },
      );
    });
    if (heads.trim() === '') {
      throw new Error(`${run.landOn} is not on origin, so its slice PRs have no branch to target. Push it first (git push origin ${run.landOn}), then run /factory submit again. Nothing was submitted.`);
    }
    // ls-remote prints `<sha>\trefs/heads/<landOn>`. The slices build on the local branch, so an origin tip that is not
    // the local one would put the local commits origin lacks into slice 01's PR. Origin may instead be ahead (a teammate
    // pushed to it), where a push is rejected, so the message names both remedies.
    const local = (await git(ws.root, 'rev-parse', `refs/heads/${run.landOn}`)).trim();
    const remote = heads.split('\t')[0] ?? '';
    if (remote !== local) {
      throw new Error(
        `${run.landOn} on origin (${remote.slice(0, 12)}) is not the local ${run.landOn} (${local.slice(0, 12)}) that the slices build on. Push your local commits (git push origin ${run.landOn}), or, if origin is ahead, update the local ${run.landOn} first (switch to ${run.landOn} and run git pull --ff-only origin ${run.landOn}); then run /factory submit again. Nothing was submitted.`,
      );
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
  let prs: SlicePr[];
  try {
    prs = await setTitles(ws.root, run, progress);
  } catch (caught) {
    throw new Error(
      `The stack and its PRs were submitted, but the PR titles were not set: ${caught instanceof Error ? caught.message : String(caught)}\nRunning /factory submit again sets them.`,
      { cause: caught },
    );
  }
  if (run.landOn === undefined) return output;
  progress('writing the single-PR handoff (pr.md)');
  try {
    return `${output}${output.endsWith('\n') || output === '' ? '' : '\n'}${await writeHandoff(ws, run, prs)}\n`;
  } catch (caught) {
    throw new Error(
      `The stack and its PRs were submitted and titled, but the handoff (pr.md) was not written: ${caught instanceof Error ? caught.message : String(caught)}\nRunning /factory submit again writes it.`,
      { cause: caught },
    );
  }
}

/**
 * Sets every slice PR's title to `<feature>: NN <slice title>`, overwriting any other title, and returns each slice's
 * PR in run order for the landOn handoff (empty for a run without landOn). Uses the REST API, not `gh pr edit`, which
 * fails on repositories with Projects (classic). Fails, setting no title, when a slice has no PR, or, on a landOn run,
 * when its PR has no URL.
 */
async function setTitles(root: string, run: Run, progress: (step: string) => void) {
  progress('setting the slice PR titles');
  const view = stackView.parse(JSON.parse(await gh(root, 'stack', 'view', '--json')));
  const byBranch = new Map(view.branches.map(item => [item.name, item.pr]));
  const pairs = run.slices.map(slice => ({ pr: byBranch.get(slice.branch), slice }));
  const noPr = pairs.filter(pair => pair.pr === undefined).map(pair => pair.slice.branch);
  if (noPr.length > 0) throw new Error(`gh stack submit left these slice branches with no PR: ${noPr.join(', ')}.`);
  const titled = pairs.flatMap(({ pr, slice }) => (pr === undefined ? [] : [{ number: pr.number, slice, url: pr.url }]));
  const prs: SlicePr[] = run.landOn === undefined ? [] : titled.flatMap(({ number, slice, url }) => (url === undefined ? [] : [{ number, slice, url }]));
  if (run.landOn !== undefined && prs.length < titled.length) {
    const noUrl = titled.filter(pr => pr.url === undefined).map(pr => pr.slice.branch);
    throw new Error(`gh stack view gave no PR URL for these slice branches, so the handoff cannot link them: ${noUrl.join(', ')}.`);
  }
  for (const { number, slice } of titled) {
    await gh(root, 'api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${number}`, '-f', `title=${run.feature}: ${slice.id} ${slice.title}`);
  }
  return prs;
}
