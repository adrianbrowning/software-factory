import { evidenceLine } from './evidence.ts';
import { gh } from './exec.ts';
import type { DeferredItem, Run, Slice, Workspace } from './run.ts';

/** An item to defer, before its sink location is known. */
export type DeferredDraft = Omit<DeferredItem, 'location'>;

/** A draft naming the run, slice and review it comes from, with `detail` as the rest of the body. */
export function draftOf(run: Run, slice: Slice, reviewId: string, item: Pick<DeferredItem, 'id' | 'key' | 'kind'> & { detail: string; title: string }): DeferredDraft {
  const { detail, ...rest } = item;
  return {
    ...rest,
    body: `Run: ${run.feature}\nSlice: ${slice.id} "${slice.title}"\nReview: ${reviewId}\n\n${detail}`,
    review: reviewId,
    slice: slice.id,
    title: `${run.feature}/${slice.id}: ${evidenceLine(item.title, 200)}`,
  };
}

/**
 * Sends each draft the run has not deferred yet (by key) to the configured sink and records it on the run: a GitHub
 * issue is created at once and its URL stored, a file item waits on the run with the file's path. An issue that fails
 * stops the loop; the items already filed stay recorded, so a retry files only the rest. Returns the failure, if any.
 * Without a sink it records nothing.
 */
export async function deferItems(ws: Workspace, run: Run, drafts: DeferredDraft[]) {
  const sink = ws.config.deferred;
  if (sink === undefined) return undefined;
  for (const draft of drafts) {
    if (run.deferred.some(item => item.key === draft.key)) continue;
    if (sink.kind === 'file') {
      run.deferred.push({ ...draft, location: sink.path });
      continue;
    }
    try {
      const url = (await gh(ws.root, 'issue', 'create', '--title', draft.title, '--body', draft.body)).trim().split('\n').at(-1) ?? '';
      if (!URL.canParse(url) || new URL(url).protocol !== 'https:') throw new Error(`gh issue create did not print an issue URL: ${evidenceLine(url, 200) || 'no output'}`);
      run.deferred.push({ ...draft, location: url });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  return undefined;
}
