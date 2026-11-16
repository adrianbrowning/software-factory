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
export function snapshotOf(sha: string, status: string) {
  return createHash('sha256').update(`${sha}\n${status}`).digest('hex');
}

export async function snapshot(root: string) {
  return snapshotOf(await head(root), await porcelain(root));
}

function refuseDirty(status: string, action: string) {
  if (status.trim() !== '') throw new Error(`${action}: commit or remove these changes first:\n${evidence(status, 2_000)}`);
}

export async function requireClean(root: string, action: string) {
  refuseDirty(await porcelain(root), action);
}

/**
 * Refuses unless the slice branch is checked out and the working tree is clean, from one `git status` call. Returns the
 * status (as `porcelain` returns it), so a caller that needs the state it just checked does not read it again.
 */
export async function requireOnBranchClean(root: string, slice: Slice, action: string) {
  const out = await git(root, 'status', '--porcelain=v1', '--branch', '--untracked-files=all');
  const end = out.indexOf('\n');
  const header = (end === -1 ? out : out.slice(0, end)).slice('## '.length);
  const status = end === -1 ? '' : out.slice(end + 1);
  // `main`, `main...origin/main [ahead 1]`, `No commits yet on main`, or `HEAD (no branch)`; a branch name holds no space and no `...`.
  const branch = header.startsWith('HEAD (no branch)') ? '' : (/^(?:No commits yet on |Initial commit on )?(.*?)(?:\.\.\.| |$)/.exec(header)?.[1] ?? '');
  if (branch !== slice.branch) throw new Error(`Slice ${slice.id} works on ${slice.branch}, but ${branch || 'a detached HEAD'} is checked out.`);
  refuseDirty(status, action);
  return status;
}
