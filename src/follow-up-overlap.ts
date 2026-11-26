/**
 * File-level overlap between the carried items waiting on the run and the done slices they came from: factory_follow_up
 * reports it before the follow-up slice is added, because a later factory_reopen of that slice can conflict when the
 * follow-up slice restacks onto it.
 */
import { git } from './exec.ts';
import { carriedKeys } from './legacy-observations.ts';
import type { Run } from './run.ts';

/** Whether a ledger location (`<path>:<line>`, `<path>`, or `<symbol> (<that place>)`) points at `path`. Line numbers are not compared. */
function pointsAt(location: string, path: string) {
  const place = location.endsWith(')') ? location.slice(0, -1) : location;
  const base = place.replace(/:\d+$/, '');
  return base === path || base.endsWith(` (${path}`);
}

/**
 * The block `Overlap with done slices (file-level):` with one line per waiting carried item whose ledger observation
 * points at a file that the observation's own done slice changed in its own commits (`git diff --name-only
 * <parentBranch>..<branch>`); `''` when no item overlaps. Items without keys (notes) and keys not in the ledger never overlap.
 */
export async function followUpOverlap(root: string, run: Run) {
  const changed = new Map<string, string[]>();
  const lines: string[] = [];
  for (const section of run.waiting) {
    for (const key of carriedKeys(section) ?? []) {
      const entry = run.observations.find(candidate => candidate.key === key);
      const slice = run.slices.find(candidate => candidate.id === entry?.slice && candidate.status === 'done');
      if (entry === undefined || slice === undefined) continue;
      if (!changed.has(slice.id)) {
        const out = await git(root, 'diff', '--name-only', `${slice.parentBranch}..${slice.branch}`).catch(() => '');
        changed.set(slice.id, out.split('\n').filter(Boolean));
      }
      const path = changed.get(slice.id)?.find(candidate => pointsAt(entry.location, candidate));
      if (path !== undefined) {
        lines.push(`- ${key} (${path}): slice ${slice.id} "${slice.title}" changed this file; a factory_reopen of slice ${slice.id} that changes the same lines conflicts when this slice restacks onto it.`);
      }
    }
  }
  return lines.length === 0 ? '' : `Overlap with done slices (file-level):\n${lines.join('\n')}`;
}
