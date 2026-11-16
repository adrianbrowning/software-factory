import { evidenceLine, redact } from './evidence.ts';
import { gh } from './exec.ts';
import type { DeferredSink } from './config.ts';
import type { DeferredItem, Run, Slice, Workspace } from './run.ts';

/** Whether `slice` is a Record deferred items slice: a headless run's own sink writer, whose reviews never defer to the sink. */
export function isRecordSlice(slice: Slice) {
  return slice.record === true;
}

/**
 * Whether a file-sink item's Record deferred items slice, or any slice split from it, is done but was accepted
 * unresolved, so the item may not have reached the sink file.
 */
export function recordFailed(run: Run, item: DeferredItem) {
  const record = run.slices.find(slice => slice.id === item.recorded);
  if (record === undefined) return false;
  const batch = record.recordBatch === undefined ? [record] : run.slices.filter(slice => slice.recordBatch === record.recordBatch);
  return batch.some(slice => slice.status === 'done' && (slice.unresolved ?? []).length > 0);
}

/** Whether the item waits for a Record slice: none lists it yet, or its one Record slice failed and no retry was made. */
export function waitsForRecord(run: Run, item: DeferredItem) {
  return item.recorded === undefined || (item.retried !== true && recordFailed(run, item));
}

/** The key of a review's item `id` (an observation id, `note:N`, or `unresolved:N`): the one format deferItems relies on to defer an item once. */
export function itemKey(reviewId: string, id: string) {
  return `${reviewId}:${id}`;
}

/** How the factory_defer dialog names the sink: `name` in its title, `line` in its body. */
export function describeSink(sink: DeferredSink) {
  return sink.kind === 'github'
    ? { line: 'GitHub issues (gh issue create, one per item)', name: 'GitHub issues' }
    : { line: `the sink file ${sink.path} (queued on the run)`, name: 'the sink file' };
}

/** An item to defer, before its sink location is known. */
export type DeferredDraft = Omit<DeferredItem, 'location'>;

/** A draft naming the run, slice and review it comes from, with `detail` as the rest of the body. */
export function draftOf(run: Run, slice: Slice, reviewId: string, item: Pick<DeferredItem, 'id' | 'key' | 'kind'> & { detail: string; title: string }): DeferredDraft {
  const { detail, ...rest } = item;
  return {
    ...rest,
    body: redact(`Run: ${run.feature}\nSlice: ${slice.id} "${slice.title}"\nReview: ${reviewId}\n\n${detail}`),
    review: reviewId,
    slice: slice.id,
    title: `${run.feature}/${slice.id}: ${evidenceLine(item.title, 200)}`,
  };
}

/** The key of the `number`th (1-based) finding of retro `ordinal`: the ordinal keeps a later retro's findings from matching an earlier one's. */
export function retroKey(ordinal: number, number: number) {
  return `retro:${ordinal}:${number}`;
}

/** A draft for the `number`th (1-based) finding of headless retro `ordinal`. Redacted: retro details come from a possibly private repository. */
export function retroDraft(run: Run, ordinal: number, number: number, finding: { category: string; detail: string; severity: string; target: string; title: string }): DeferredDraft {
  return {
    body: redact(`Run: ${run.feature}\nRetro finding (${finding.target}, ${finding.category}, ${finding.severity})\n\n${finding.detail}`),
    key: retroKey(ordinal, number),
    kind: 'retro',
    review: 'retro',
    slice: 'retro',
    title: `${run.feature}/retro: ${evidenceLine(finding.title, 200)}`,
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

/** Throws for an observation already sent to the deferred sink. */
export function requireNotDeferred(run: Run, reviewId: string, observations: { id: string }[]) {
  const deferred = observations.filter(finding => run.deferred.some(item => item.key === itemKey(reviewId, finding.id)));
  if (deferred.length > 0) throw new Error(`Observations already deferred: ${deferred.map(finding => finding.id).join(', ')}.`);
}

/** Throws for an observation already carried to a slice or the end queue, then for one already deferred. */
export function requireNotCarriedOrDeferred(run: Run, reviewId: string, observations: { id: string }[]) {
  const carried = observations.filter(finding => run.carriedObservations.includes(itemKey(reviewId, finding.id)));
  if (carried.length > 0) throw new Error(`Observations already carried: ${carried.map(finding => finding.id).join(', ')}.`);
  requireNotDeferred(run, reviewId, observations);
}

/** The configured deferred sink. Throws without one. */
export function requireSink(ws: Workspace) {
  if (ws.config.deferred === undefined) throw new Error('No deferred sink: set "deferred" ({ "kind": "file" } or { "kind": "github" }) in .omp/factory.json.');
  return ws.config.deferred;
}
