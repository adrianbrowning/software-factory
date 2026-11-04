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

/** Identity of the committed and uncommitted repository state; ignored files (the run state) are excluded. */
export async function snapshot(root: string) {
  return createHash('sha256')
    .update(`${await head(root)}\n${await porcelain(root)}`)
    .digest('hex');
}

export async function requireClean(root: string, action: string) {
  const status = await porcelain(root);
  if (status.trim() !== '') throw new Error(`${action}: commit or remove these changes first:\n${evidence(status, 2_000)}`);
}

export async function requireOnBranch(root: string, slice: Slice) {
  const branch = (await git(root, 'branch', '--show-current')).trim();
  if (branch !== slice.branch) throw new Error(`Slice ${slice.id} works on ${slice.branch}, but ${branch || 'a detached HEAD'} is checked out.`);
}
