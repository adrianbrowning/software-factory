import { z } from 'zod';
import { gh, git } from './exec.ts';
import { head, requireClean } from './repo.ts';
import { addEvent, greenCommit, type Run, type Workspace } from './run.ts';

/** The part of `gh stack view --json` submit reads: the stack's branches, bottom (closest to trunk) first. */
const stackView = z.object({ branches: z.array(z.object({ name: z.string() })) });

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
 * A run with `landOn` instead fast-forwards that local branch to the top slice; no PRs are opened. Never merges.
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
    progress(`fast-forwarding ${run.landOn} to the top slice`);
    return landStack(ws, run, run.landOn);
  }
  const branches = run.slices.map(slice => slice.branch);
  const bottom = branches[0] ?? '';
  progress(`reading the gh stack that holds ${bottom}`);
  // `gh stack checkout` and the gh stack steps after it move HEAD; on a refusal or any failure, submit switches back to
  // where it started, so a refused submit changes nothing. A successful submit stays where gh stack leaves it.
  const start = await git(ws.root, 'symbolic-ref', '-q', '--short', 'HEAD').then(
    name => [name.trim()],
    async () => ['--detach', await head(ws.root)],
  );
  let output: string;
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
    } else if (plan.missing.length === 0) {
      progress(`the gh stack already holds all ${branches.length} slice branches`);
    } else {
      const { missing } = plan;
      progress(`adding ${missing.length} ${missing.length === 1 ? 'branch' : 'branches'} to the existing gh stack: ${missing.join(', ')}`);
      await gh(ws.root, 'stack', 'top');
      for (const branch of missing) await gh(ws.root, 'stack', 'add', branch);
    }
    progress(`pushing ${run.slices.length} branches and opening draft PRs (gh stack submit; this can take a few minutes)`);
    output = await gh(ws.root, 'stack', 'submit', '--auto');
  } catch (error) {
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
  return output;
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
