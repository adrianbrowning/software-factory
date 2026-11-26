/**
 * File-level overlap between the carried items waiting on the run and the done slices they came from: factory_follow_up
 * reports it before the follow-up slice is added, because a later factory_reopen of that slice can conflict when the
 * follow-up slice restacks onto it.
 */
import { git } from './exec.ts';
import { carriedKeys } from './legacy-observations.ts';
import type { Run } from './run.ts';

/** Whether `place` is `path`, or `path:<line>`. Line numbers are not compared. */
function isPlace(place: string, path: string) {
  return place === path || (place.startsWith(`${path}:`) && /^\d+$/.test(place.slice(path.length + 1)));
}

/** Whether a ledger location (`<place>`, or `<symbol> (<place>)`) points at `path`. */
function pointsAt(location: string, path: string) {
  if (isPlace(location, path)) return true;
  if (!location.endsWith(')')) return false;
  for (let at = location.indexOf(' ('); at !== -1; at = location.indexOf(' (', at + 1)) {
    if (isPlace(location.slice(at + 2, -1), path)) return true;
  }
  return false;
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
        const out = await git(root, 'diff', '--name-only', '-z', `${slice.parentBranch}..${slice.branch}`);
        changed.set(slice.id, out.split('\0').filter(Boolean));
      }
      const path = changed.get(slice.id)?.find(candidate => pointsAt(entry.location, candidate));
      if (path !== undefined) {
        lines.push(`- ${key} (${path}): slice ${slice.id} "${slice.title}" changed this file; a factory_reopen of slice ${slice.id} that changes the same lines conflicts when this slice restacks onto it.`);
      }
    }
  }
  return lines.length === 0 ? '' : `Overlap with done slices (file-level):\n${lines.join('\n')}`;
}
