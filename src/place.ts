/**
 * The one batched placement of a slice's observations: after the slice's final full green review, every kept observation
 * of its reviews (red ones too) that no tool placed yet gets a placement, by its category unless the user names another.
 * factory_place applies the list in one step, factory_complete_slice refuses while any is left, and a headless run
 * applies the defaults when it completes the slice.
 */
import { z } from 'zod';
import { draftOf, deferItems, isRecordSlice, itemKey, requireSink } from './deferred.ts';
import { evidenceHead } from './evidence.ts';
import { placeObservations } from './ledger.ts';
import { carriedSection, renderFinding } from './finding-text.ts';
import { addEvent, DEFAULT_PLACEMENT, greenCommit, Invalidated, requireActive, type Finding, type Run, type Slice, type Unplaced, type Workspace } from './run.ts';
import { needsFullReview, writeTicket } from './workflow.ts';

export const PLACE_CHOICES = ['fix', 'carry', 'end', 'defer', 'leave'] as const;
export type PlaceChoice = (typeof PLACE_CHOICES)[number];

export const placementSchema = z.object({
  id: z.string().min(1).describe('Observation id, for example "thermo-naming"; "<review>:<id>" when two reviews of the slice kept the same id'),
  placement: z.enum(PLACE_CHOICES).describe('fix: the implementer fixes it in this slice; carry: into the ticket of the pending slice named by "to"; end: the queue for the next factory_follow_up slice; defer: the deferred sink; leave: record it and never raise it again'),
  to: z.string().regex(/^\d{2}$/).optional().describe('For carry only: id of the pending slice whose ticket takes it, for example "03"'),
});
export type PlaceRequest = { placements: z.infer<typeof placementSchema>[] };

/** The placement an observation gets when the user names none: by its category, with a leave sent to the deferred sink in a headless run that has one (the Record slice defers nothing). */
export function defaultChoice(ws: Workspace, run: Run, slice: Slice, entry: Unplaced): PlaceChoice {
  if (DEFAULT_PLACEMENT[entry.category] === 'end') return 'end';
  return run.mode === 'headless' && ws.config.deferred !== undefined && !isRecordSlice(slice) ? 'defer' : 'leave';
}

/** The same default as `defaultChoice`, in words, for the review reply and the dialog. */
export function describeChoice(choice: PlaceChoice, to?: string) {
  return { carry: `carry to slice ${to}`, defer: 'defer to the sink', end: 'end queue', fix: 'fix in this slice', leave: 'leave' }[choice];
}

type Planned = { choice: PlaceChoice; entry: Unplaced; target?: Slice };

/**
 * The placement of every observation unplaced on the active slice: the named ones, and the default for each other one.
 * Throws unless the slice is ready on a green review that is final (not a targeted green awaiting its full review),
 * for an id that is not unplaced on the slice (naming its placement when the ledger holds it), an id given twice or
 * ambiguous between reviews, a carry without a pending slice, and a defer without a sink or on the Record slice. Does
 * not change the run.
 */
export function planPlace(ws: Workspace, run: Run, request: PlaceRequest) {
  const slice = requireActive(run);
  if (slice.phase !== 'ready' || greenCommit(slice) === undefined) throw new Error(`Slice ${slice.id} has no green review to place observations after.`);
  if (needsFullReview(slice)) throw new Error(`The last green review of slice ${slice.id} was targeted: place observations after its full review.`);
  const chosen = new Map<Unplaced, { choice: PlaceChoice; to?: string | undefined }>();
  for (const { id, placement, to } of request.placements) {
    const found = slice.unplaced.filter(entry => entry.finding.id === id || itemKey(entry.review, entry.finding.id) === id);
    const [entry, ...others] = found;
    if (entry === undefined) {
      const held = run.observations.find(candidate => candidate.id === id || candidate.key === id);
      if (held !== undefined) throw new Error(`Observation ${id} is already ${held.placement}.`);
      const listed = slice.unplaced.map(candidate => candidate.finding.id).join(', ') || 'none';
      throw new Error(`Observation ${id} is not unplaced on slice ${slice.id}. Unplaced: ${listed}.`);
    }
    if (others.length > 0) throw new Error(`Observation ${id} is unplaced under reviews ${found.map(candidate => candidate.review).join(', ')}: name it as <review>:${id}.`);
    if (chosen.has(entry)) throw new Error(`Observation ${id} is placed twice in one request.`);
    if (placement !== 'carry' && to !== undefined) throw new Error(`Observation ${id}: "to" belongs to carry only.`);
    if (placement === 'carry' && to === undefined) throw new Error(`Observation ${id}: carry needs "to", the id of a pending slice.`);
    chosen.set(entry, { choice: placement, to });
  }
  const items: Planned[] = slice.unplaced.map(entry => {
    const named = chosen.get(entry);
    if (named === undefined) return { choice: defaultChoice(ws, run, slice, entry), entry };
    if (named.choice !== 'carry') return { choice: named.choice, entry };
    const target = run.slices.find(candidate => candidate.id === named.to);
    if (target === undefined) throw new Error(`No slice ${named.to}. Slices: ${run.slices.map(candidate => candidate.id).join(', ')}.`);
    if (target.status !== 'pending') throw new Error(`Slice ${target.id} is ${target.status}; carry takes a pending slice.`);
    return { choice: 'carry', entry, target };
  });
  if (items.some(item => item.choice === 'defer')) {
    requireSink(ws);
    if (isRecordSlice(slice)) throw new Error(`Slice ${slice.id} "${slice.title}" writes the deferred sink file, so its observations are not deferred.`);
  }
  return { items, slice };
}

/** What the confirm dialog shows: one line per observation with its placement. */
export function describePlan(items: Planned[]) {
  return items.map(({ choice, entry, target }) => `- ${entry.finding.id} (${entry.category}): ${describeChoice(choice, target?.id)}. ${evidenceHead(entry.finding.title, 200)}`).join('\n');
}

const byReview = (items: Planned[]) => [...new Set(items.map(item => item.entry.review))].map(review => ({ findings: items.filter(item => item.entry.review === review).map(item => item.entry.finding), review: { id: review } }));

/**
 * Applies `planPlace` to the run: carried and end-queued observations go into ticket sections or the waiting queue,
 * left ones into the ledger, and deferred ones to the sink; each is then in the ledger and off the slice's unplaced list.
 * Returns the sink failure, if any, and `fixes`, the qualified ids chosen to fix (empty after a failure): the caller
 * sends them to factory_fix's observation round, which this module cannot, as review.ts imports it.
 */
export async function placeObservationBatch(ws: Workspace, run: Run, request: PlaceRequest) {
  const { items, slice } = planPlace(ws, run, request);
  const lastReview = slice.review?.id;
  const carried = items.filter(item => item.choice === 'carry' || item.choice === 'end');
  const targets = new Set<Slice>();
  for (const target of new Set(carried.map(item => item.target))) {
    for (const group of byReview(carried.filter(item => item.target === target))) {
      const section = carriedSection(run, group.review, slice, group.findings, undefined, group.review.id === lastReview);
      placeObservations(run, group.review, slice, group.findings, 'carried', target?.id ?? 'end');
      if (target === undefined) run.waiting.push(section);
      else {
        target.carried.push(section);
        targets.add(target);
      }
    }
  }
  for (const target of targets) writeTicket(ws, run, target);
  for (const group of byReview(items.filter(item => item.choice === 'leave'))) placeObservations(run, group.review, slice, group.findings, 'left');

  const deferred = items.filter(item => item.choice === 'defer');
  const drafts = deferred.map(({ entry }) => draftOf(run, slice, entry.review, { detail: renderFinding(entry.finding, run.decisions, '###'), id: entry.finding.id, key: itemKey(entry.review, entry.finding.id), kind: 'observation', title: entry.finding.title }));
  const before = run.deferred.length;
  const failure = await deferItems(ws, run, drafts);
  const filed = run.deferred.slice(before);
  for (const group of byReview(deferred)) {
    const placed = group.findings.filter((finding: Finding) => filed.some(item => item.key === itemKey(group.review.id, finding.id)));
    placeObservations(run, group.review, slice, placed, 'deferred');
  }
  const rest = drafts.filter(draft => !filed.some(item => item.key === draft.key)).map(draft => draft.id ?? 'the note');
  addEvent(run, 'place', items.map(({ choice, entry }) => `${entry.review}:${entry.finding.id} ${choice}`).join(', '), slice);
  const fixes = failure === undefined ? items.filter(item => item.choice === 'fix').map(item => itemKey(item.entry.review, item.entry.finding.id)) : [];
  return { failure, filed, fixes, rest, slice };
}

/**
 * A headless run's step before it completes its slice: places the observations still unplaced by their defaults, with no
 * dialog. Throws Invalidated when the deferred sink fails, so withRun saves what was filed and the ledger entries; it stays recorded and a second call places the rest.
 */
export async function placeDefaults(ws: Workspace, run: Run) {
  const slice = requireActive(run);
  if (run.mode !== 'headless' || slice.unplaced.length === 0) return;
  const { failure } = await placeObservationBatch(ws, run, { placements: [] });
  if (failure !== undefined) throw new Invalidated(`The deferred sink failed, so slice ${slice.id} is not complete: ${failure.message}. Items already filed stay recorded; call factory_complete_slice again.`);
}
