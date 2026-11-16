/** Repository-state queries and guards shared by the workflow and review lifecycles. */
import { createHash } from 'node:crypto';
import { evidence } from './evidence.ts';
import { git } from './exec.ts';
import type { Slice } from './run.ts';

export async function head(root: string) {
  return (await git(root, 'rev-parse', 'HEAD')).trim();
}

export async function porcelain(root: string) {
  return git(root, 'status', '--porcelain=v1', '--untracked-files=all');
}

/** Identity of the committed and uncommitted repository state at `sha` with `status` (as `porcelain` returns it); ignored files (the run state) are excluded. */
function snapshotOf(sha: string, status: string) {
  return createHash('sha256').update(`${sha}\n${status}`).digest('hex');
}

/**
 * HEAD, the checked-out branch ('' when detached) and whether the tree is clean, from one `git status` call. A clean
 * tree is the common case, so the dirty text (`porcelain`) is read only when something needs it.
 */
async function readState(root: string) {
  const lines = (await git(root, 'status', '--porcelain=v2', '--branch', '--untracked-files=all')).split('\n').filter(Boolean);
  const header = (name: string) => lines.find(line => line.startsWith(`# ${name} `))?.slice(`# ${name} `.length);
  const oid = header('branch.oid');
  const branch = header('branch.head');
  return {
    branch: branch === undefined || branch === '(detached)' ? '' : branch,
    clean: lines.every(line => line.startsWith('# ')),
    // A repository with no commit has no HEAD: `head` then fails as it always did.
    sha: oid === undefined || oid === '(initial)' ? await head(root) : oid,
  };
}

export async function snapshot(root: string) {
  const state = await readState(root);
  return snapshotOf(state.sha, state.clean ? '' : await porcelain(root));
}

export async function requireClean(root: string, action: string) {
  const status = await porcelain(root);
  if (status.trim() !== '') throw new Error(`${action}: commit or remove these changes first:\n${evidence(status, 2_000)}`);
}

/**
 * Refuses unless the slice branch is checked out and the working tree is clean, from one `git status` call.
 * Returns HEAD, so a caller that needs it does not read it again.
 */
export async function requireOnBranchClean(root: string, slice: Slice, action: string) {
  const state = await readState(root);
  if (state.branch !== slice.branch) throw new Error(`Slice ${slice.id} works on ${slice.branch}, but ${state.branch || 'a detached HEAD'} is checked out.`);
  if (!state.clean) await requireClean(root, action);
  return state.sha;
}
