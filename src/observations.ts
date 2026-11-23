/**
 * What the user does with the observations of a green review: carry them to a later slice or the end of the run, defer
 * them to the sink, fix them in the active slice, or leave them. Each resolves the observations from the review that
 * lists them, refuses one the run's ledger already holds, and adds a ledger entry for each it places.
 */
import { z } from 'zod';
import { evidence, evidenceLine, redact } from './evidence.ts';
import { draftOf, isRecordSlice, itemKey, requireSink } from './deferred.ts';
import { findUnplaced, placeObservations, requireUnplaced } from './ledger.ts';
import { carriedSections, renderFinding } from './finding-text.ts';
import { findingRecord, keptFindings, readRecorded, recordedFindings, type Review, targetingAfter, validationFile, validationSchema } from './review-record.ts';
import { addEvent, greenCommit, requireActive, type Finding, type Run, type Slice, type Workspace } from './run.ts';
import { type FixRecord, needsFullReview, startFix, writeFixFile, writeTicket } from './workflow.ts';

function noGreenReview(sliceId: string, purpose: string): Error {
  return new Error(`Slice ${sliceId} has no green review to ${purpose} from.`);
}

/** What the user chose to fix in the active slice after its green review: observation ids, a free-text bug, or both. */
export type FixRequest = { bug?: string | undefined; observations?: string[] | undefined };

/** The kept observations of `slice`'s last green review, with the review. Throws when the slice has none. */
function reviewObservations(ws: Workspace, run: Run, slice: Slice, purpose: string) {
  const review = slice.review;
  if (slice.phase !== 'ready' || greenCommit(slice) === undefined || review === undefined) {
    throw noGreenReview(slice.id, purpose);
  }
  const raw = readRecorded(validationFile(ws, run, review.id), review.validation);
  if (raw === undefined) throw new Error(`Review ${review.id} has no validation.`);
  const { findings } = recordedFindings(ws, run, review);
  const observations = keptFindings(findings, validationSchema.parse(raw)).filter(finding => finding.severity === 'observation');
  return { observations, review, slice };
}

function unknownObservations(review: Review, observations: Finding[], unknown: string[]) {
  const listed = observations.map(finding => finding.id).join(', ') || 'none';
  return new Error(`Not observations of green review ${review.id}: ${unknown.join(', ')}. Its observations: ${listed}.`);
}

/**
 * The active slice's green review and the observations from it whose ids are in `chosen`. Throws for a slice without a
 * green review (naming what `purpose` needed it for) and for an id that is not one of its observations. Does not change
 * the run.
 */
function greenObservations(ws: Workspace, run: Run, chosen: Set<string>, purpose: string) {
  const { observations, review, slice } = reviewObservations(ws, run, requireActive(run), purpose);
  const unknown = [...chosen].filter(id => !observations.some(finding => finding.id === id));
  if (unknown.length > 0) throw unknownObservations(review, observations, unknown);
  return { observations: observations.filter(finding => chosen.has(finding.id)), review, slice };
}

/** Throws when `chosen` has ids and the active slice's last green review was targeted: ids are placed after its full review, by factory_place or these tools. */
function requireFullForIds(run: Run, chosen: Set<string>, tool: string) {
  const slice = requireActive(run);
  if (chosen.size > 0 && needsFullReview(slice)) {
    throw new Error(`The last green review of slice ${slice.id} was targeted: ${tool} takes observation ids only after its full review.`);
  }
}

/** The free text (undefined when blank) and the chosen observation ids of a request; throws `empty` when it has neither. */
function normalizeRequest(text: string | undefined, observations: string[] | undefined, empty: string) {
  const trimmed = text?.trim() ? text : undefined;
  const chosen = new Set(z.array(z.string().min(1)).parse(observations ?? []));
  if (trimmed === undefined && chosen.size === 0) throw new Error(empty);
  return { chosen, text: trimmed };
}

/**
 * What factory_carry takes: observation ids from the active slice's green review, a free-text note, or both, and where they go: a pending slice id, or "end" to wait on the run for the
 * next follow-up slice.
 */
export type CarryRequest = { note?: string | undefined; observations?: string[] | undefined; to: string };

/** Where carried work goes: the run's waiting queue for the next follow-up slice, or the ticket of a pending slice. */
export type CarryDestination = { kind: 'end' } | { kind: 'slice'; slice: Slice };

/**
 * The destination of `request.to` (a pending slice, or "end"), the observations chosen from the green review
 * that lists them of the active slice, and the note. Throws for a request with neither,
 * for a slice without a green review, for ids its review does not list, for ids the ledger already
 * holds, and for a target that is neither "end" nor a pending slice. Does not change the run.
 */
export function planCarry(ws: Workspace, run: Run, request: CarryRequest) {
  const { text: note, chosen } = normalizeRequest(request.note, request.observations, 'factory_carry needs observation ids, a note, or both.');
  requireFullForIds(run, chosen, 'factory_carry');
  const green = greenObservations(ws, run, chosen, 'carry observations or a note');
  requireUnplaced(run, green.review.id, green.observations);
  const labels = [...(note === undefined ? [] : ['note']), ...green.observations.map(finding => finding.id)];
  if (request.to === 'end') return { labels, note, ...green, destination: { kind: 'end' } as CarryDestination };
  const found = run.slices.find(candidate => candidate.id === request.to);
  if (found === undefined) throw new Error(`No slice ${request.to}. Slices: ${run.slices.map(candidate => candidate.id).join(', ')}.`);
  if (found.status !== 'pending') throw new Error(`Slice ${found.id} is ${found.status}; factory_carry takes a pending slice.`);
  return { labels, note, ...green, destination: { kind: 'slice', slice: found } as CarryDestination };
}

/**
 * Carries the observations chosen from the active slice's green review, and the user's free-text note, into the
 * ticket of a pending slice, whose implementer builds them and whose reviewers check them, or, for "end", onto the
 * run's waiting queue for the next follow-up slice. The active slice keeps its green review.
 */
export function carryObservations(ws: Workspace, run: Run, request: CarryRequest) {
  const planned = planCarry(ws, run, request);
  const { labels, note, observations, review, slice, destination } = planned;
  const sections = carriedSections(run, review, slice, observations, note);
  placeObservations(run, review, slice, observations, 'carried', destination.kind === 'end' ? 'end' : destination.slice.id);
  if (destination.kind === 'end') run.waiting.push(...sections);
  else {
    destination.slice.carried.push(...sections);
    writeTicket(ws, run, destination.slice);
  }
  addEvent(run, 'carry', `${review.id} to ${destination.kind === 'end' ? 'the end of the run' : `slice ${destination.slice.id}`}: ${labels.join(', ')}`, slice);
  return planned;
}

/** What factory_defer takes: observation ids from a green review (as for factory_carry), a free-text note, or both. */
export type DeferRequest = { note?: string | undefined; observations?: string[] | undefined };

/**
 * One draft per observation and note, with the observations and the green review and slice that list them. Throws
 * without a deferred sink, for a request with neither ids nor a note, and for ids that are unknown or already placed.
 * Does not change the run.
 */
export function planDefer(ws: Workspace, run: Run, request: DeferRequest) {
  requireSink(ws);
  const { text: note, chosen } = normalizeRequest(request.note, request.observations, 'factory_defer needs observation ids, a note, or both.');
  requireFullForIds(run, chosen, 'factory_defer');
  const { observations, review, slice } = greenObservations(ws, run, chosen, 'defer observations or a note');
  if (isRecordSlice(slice)) throw new Error(`Slice ${slice.id} "${slice.title}" writes the deferred sink file, so its review items are not deferred. They stay in the review itself (the green review observations, and for accepted-unresolved findings slice.unresolved and the accepted-unresolved event).`);
  requireUnplaced(run, review.id, observations);
  const noted = run.deferred.filter(item => item.review === review.id && item.kind === 'note').length;
  return {
    drafts: [
      ...(note === undefined ? [] : [draftOf(run, slice, review.id, { detail: redact(note), key: itemKey(review.id, `note:${noted + 1}`), kind: 'note', title: note })]),
      ...observations.map(finding => draftOf(run, slice, review.id, { detail: renderFinding(finding, run.decisions, '###'), id: finding.id, key: itemKey(review.id, finding.id), kind: 'observation', title: finding.title })),
    ],
    observations,
    review,
    slice,
  };
}

/**
 * The bug the user found and the observations the user chose to fix, with `groups` (each chosen observation under the review that kept it, red reviews included) and `review`, the slice's last review (the one the fix follows). The ids
 * may be unplaced observations of any of the active slice's reviews. Throws for a request with neither bug nor ids, for a slice without a green review, and for an id no
 * review lists. Does not change the run.
 */
export function planFix(ws: Workspace, run: Run, request: FixRequest) {
  const { text: bug, chosen } = normalizeRequest(request.bug, request.observations, 'factory_fix needs a bug, observation ids, or both.');
  const found = unplacedObservations(run, chosen) ?? { ...greenObservations(ws, run, chosen, 'fix observations or a bug'), groups: undefined };
  requireUnplaced(run, found.review.id, found.observations);
  const shownBug = bug === undefined ? undefined : redact(bug);
  const items = [
    ...(shownBug === undefined ? [] : [{ label: 'bug', line: `- Bug: ${shownBug}` }]),
    ...found.observations.map(finding => ({ label: finding.id, line: `- ${finding.id}: ${finding.title}` })),
  ];
  return { bug, items, shownBug, ...found, groups: found.groups ?? [{ observations: found.observations, review: found.review }] };
}

/**
 * The observations in `chosen` when every id is still unplaced on the active slice, whichever of its reviews (red ones
 * too) kept it, with the slice's last review (the one the fix follows) and the observations grouped by their review.
 * An id is an observation id, or `<review>:<id>` for one two reviews kept. Undefined when the slice is not ready on a review, or some id is not unplaced on it.
 */
function unplacedObservations(run: Run, chosen: Set<string>) {
  const slice = run.slices.find(candidate => candidate.status === 'active');
  const review = slice?.review;
  if (slice === undefined || review === undefined || slice.phase !== 'ready' || greenCommit(slice) === undefined || chosen.size === 0) return undefined;
  const entries = [...chosen].map(id => findUnplaced(slice, id));
  if (entries.some(found => found.length === 0)) return undefined;
  const ambiguous = [...chosen].filter((_, index) => (entries[index]?.length ?? 0) > 1);
  if (ambiguous.length > 0) throw new Error(`Observation ids unplaced under more than one review of slice ${slice.id}: ${ambiguous.join(', ')}.`);
  const picked = entries.flat();
  const groups = [...new Set(picked.map(entry => entry.review))].map(id => ({ observations: picked.filter(entry => entry.review === id).map(entry => entry.finding), review: { id } }));
  return { groups, observations: picked.map(entry => entry.finding), review, slice };
}

/**
 * Sends the active slice from its green review back to the fix loop for the bug the user found and the observations
 * the user chose to fix in this slice. A round with a bug counts against the round limit; an observation-only round
 * does not, and never stalls. The slice earns checks and a new review before it completes.
 */
export function fixAfterGreen(ws: Workspace, run: Run, request: FixRequest, reason: string) {
  const { bug, groups, items, observations, review, shownBug, slice } = planFix(ws, run, request);
  const why = evidence(reason, 4_000);
  const records: FixRecord[] = [
    ...(shownBug === undefined
      ? []
      : [
          {
            item: { kind: 'bug' as const, summary: evidenceLine(`Bug found after green review ${review.id}: ${bug}`) },
            section: `## Bug found after green review ${review.id}\n\n${why}\n\n${shownBug}`,
          },
        ]),
    ...groups.flatMap(group =>
      group.observations.map(finding => findingRecord(finding, `## Observations from ${group.review.id === review.id ? 'green review' : 'review'} ${group.review.id} the user chose to fix\n\n${why}`, run.decisions)),
    ),
  ];
  // The fix file is written before the run changes, so a failed write leaves the run as it was.
  const written = writeFixFile(ws, run, slice, records);
  addEvent(run, 'fix-after-green', `${groups.map(group => group.review.id).join(', ')}: ${items.map(item => item.label).join(', ')}`, slice);
  for (const group of groups) placeObservations(run, group.review, slice, group.observations, 'fixed');
  // A bug round needs a full review; an observation-only round is reviewed only where it changed things (a targeted review).
  slice.targeting = bug === undefined ? targetingAfter(review, observations.map(finding => finding.domain)) : undefined;
  return startFix(run, slice, review.sha, written, bug !== undefined);
}

/** What factory_leave takes: observation ids from a green review (as for factory_carry). */
export type LeaveRequest = { observations: string[] };

/**
 * The observations the user chose to leave, with the green review that lists them (as for factory_carry). Throws for a
 * request with no ids, for ids that are unknown or already placed, and for a slice without a green review. Does not
 * change the run.
 */
export function planLeave(ws: Workspace, run: Run, request: LeaveRequest) {
  const chosen = new Set(z.array(z.string().min(1)).parse(request.observations));
  if (chosen.size === 0) throw new Error('factory_leave needs observation ids.');
  requireFullForIds(run, chosen, 'factory_leave');
  const found = greenObservations(ws, run, chosen, 'leave observations');
  requireUnplaced(run, found.review.id, found.observations);
  return found;
}

/** Records the chosen observations as left: no slice builds them and no sink gets them, and no later review of the run raises them again. The slice keeps its green review. */
export function leaveObservations(ws: Workspace, run: Run, request: LeaveRequest) {
  const planned = planLeave(ws, run, request);
  placeObservations(run, planned.review, planned.slice, planned.observations, 'left');
  addEvent(run, 'leave', `${planned.review.id}: ${planned.observations.map(finding => finding.id).join(', ')}`, planned.slice);
  return planned;
}
