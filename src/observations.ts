/**
 * What the user does with the observations of a green review: carry them to a later slice or the end of the run, defer
 * them to the sink, fix them in the active slice, or leave them. Each resolves the observations from the review that
 * lists them, refuses one the run's ledger already holds, and adds a ledger entry for each it places.
 */
import { z } from 'zod';
import { evidence, evidenceLine, redact } from './evidence.ts';
import { draftOf, isRecordSlice, itemKey, requireSink } from './deferred.ts';
import { placeObservations, requireUnplaced } from './ledger.ts';
import { findingRecord, keptFindings, readRecorded, recordedFindings, renderFinding, type Review, validationFile, validationSchema } from './review.ts';
import { addEvent, greenCommit, requireActive, type Finding, type Run, type Slice, type Workspace } from './run.ts';
import { type FixRecord, requestFix, writeTicket } from './workflow.ts';

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

/** The done slices, with the observations of their last green review, whose review lists every id in `chosen`. */
function doneSlicesListing(ws: Workspace, run: Run, chosen: Set<string>, purpose: string) {
  if (chosen.size === 0) return [];
  return run.slices
    .filter(slice => slice.status === 'done' && slice.phase === 'ready' && greenCommit(slice) !== undefined && slice.review !== undefined)
    .map(slice => reviewObservations(ws, run, slice, purpose))
    .filter(found => [...chosen].every(id => found.observations.some(finding => finding.id === id)));
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

/**
 * The slice whose last green review lists the observations in `chosen`, for factory_carry and factory_fix. The active
 * slice wins: when its green review lists every id, that is the result. Done slices' last green reviews are looked up
 * only when it does not, found by the review that lists the ids, never by recency; the result's slice is then a done
 * slice. Throws when no review lists the ids and when more than one done slice does. Does not change the run.
 */
function resolveObservations(ws: Workspace, run: Run, chosen: Set<string>, purpose: string) {
  if (chosen.size === 0) return greenObservations(ws, run, chosen, purpose);
  const active = run.slices.find(slice => slice.status === 'active');
  const own = active !== undefined && active.phase === 'ready' && greenCommit(active) !== undefined ? reviewObservations(ws, run, active, purpose) : undefined;
  if (own !== undefined && [...chosen].every(id => own.observations.some(finding => finding.id === id))) {
    return { observations: own.observations.filter(finding => chosen.has(finding.id)), review: own.review, slice: own.slice };
  }
  const found = doneSlicesListing(ws, run, chosen, purpose);
  if (found.length > 1) {
    const next = own === undefined ? 'Build them in a factory_follow_up slice.' : 'Build them in a factory_follow_up slice, or carry the items as a free-text note.';
    throw new Error(`Slices ${found.map(entry => entry.slice.id).join(', ')} all have green reviews that list these observations (${[...chosen].join(', ')}), and the active slice's review does not. ${next}`);
  }
  const only = found[0];
  if (only !== undefined) return { observations: only.observations.filter(finding => chosen.has(finding.id)), review: only.review, slice: only.slice };
  if (own !== undefined) {
    throw unknownObservations(own.review, own.observations, [...chosen].filter(id => !own.observations.some(finding => finding.id === id)));
  }
  const done = run.slices.filter(slice => slice.status === 'done' && slice.review !== undefined);
  if (done.length === 0) throw noGreenReview(requireActive(run).id, purpose);
  throw new Error(`No green review lists these observations: ${[...chosen].join(', ')}. Done slices checked: ${done.map(slice => `${slice.id} (${slice.review?.id})`).join(', ')}.`);
}

/**
 * What factory_carry takes: observation ids from a green review (the active slice's, else the one done slice's that
 * lists them), a free-text note, or both, and where they go: a pending slice id, or "end" to wait on the run for the
 * next follow-up slice.
 */
export type CarryRequest = { note?: string | undefined; observations?: string[] | undefined; to: string };

/**
 * The target of `request.to` (a pending slice, or undefined for "end"), the observations chosen from the green review
 * that lists them (the active slice's first, else one done slice's), and the note. Throws for a request with neither,
 * for a slice without a green review, for ids no review lists or several done slices list, for ids the ledger already
 * holds, and for a target that is neither "end" nor a pending slice. Does not change the run.
 */
export function planCarry(ws: Workspace, run: Run, request: CarryRequest) {
  const note = request.note?.trim() ? request.note : undefined;
  const chosen = new Set(z.array(z.string().min(1)).parse(request.observations ?? []));
  if (note === undefined && chosen.size === 0) throw new Error('factory_carry needs observation ids, a note, or both.');
  const green = resolveObservations(ws, run, chosen, 'carry observations or a note');
  requireUnplaced(run, green.review.id, green.observations);
  if (request.to === 'end') return { note, ...green, target: undefined };
  const target = run.slices.find(candidate => candidate.id === request.to);
  if (target === undefined) throw new Error(`No slice ${request.to}. Slices: ${run.slices.map(candidate => candidate.id).join(', ')}.`);
  if (target.status !== 'pending') throw new Error(`Slice ${target.id} is ${target.status}; factory_carry takes a pending slice.`);
  return { note, ...green, target };
}

/**
 * Carries the chosen observations and the note from the green review that lists them into the ticket of a pending
 * slice, whose implementer builds them and whose reviewers check them, or, for "end", onto the run's waiting queue
 * for the next follow-up slice. The slice keeps its green review.
 */
export function carryObservations(ws: Workspace, run: Run, request: CarryRequest) {
  const planned = planCarry(ws, run, request);
  const { note, observations, review, slice, target } = planned;
  const items = [...(note === undefined ? [] : [redact(note)]), ...observations.map(finding => renderFinding(finding, run.decisions, '####'))];
  const section = `### From green review ${review.id} of slice ${slice.id} "${slice.title}"\n\n${items.join('\n\n')}`;
  placeObservations(run, review, slice, observations, 'carried', target?.id ?? 'end');
  if (target === undefined) run.waiting.push(section);
  else {
    target.carried.push(section);
    writeTicket(ws, run, target);
  }
  addEvent(run, 'carry', `${review.id} to ${target === undefined ? 'the end of the run' : `slice ${target.id}`}: ${[...(note === undefined ? [] : ['note']), ...observations.map(finding => finding.id)].join(', ')}`, slice);
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
  const note = request.note?.trim() ? request.note : undefined;
  const chosen = new Set(z.array(z.string().min(1)).parse(request.observations ?? []));
  if (note === undefined && chosen.size === 0) throw new Error('factory_defer needs observation ids, a note, or both.');
  const { observations, review, slice } = resolveObservations(ws, run, chosen, 'defer observations or a note');
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
 * The bug the user found and the observations the user chose to fix, with the green review they come from. The active
 * slice wins when its green review lists the ids; ids only a done slice's review lists are refused (factory_complete_slice
 * already ran). Throws for a request with neither bug nor ids, for a slice without a green review, and for an id no
 * review lists. Does not change the run.
 */
export function planFix(ws: Workspace, run: Run, request: FixRequest) {
  const bug = request.bug?.trim() ? request.bug : undefined;
  const chosen = new Set(z.array(z.string().min(1)).parse(request.observations ?? []));
  if (bug === undefined && chosen.size === 0) throw new Error('factory_fix needs a bug, observation ids, or both.');
  const found = resolveObservations(ws, run, chosen, 'fix observations or a bug');
  if (found.slice.status === 'done') {
    throw new Error(
      `Slice ${found.slice.id} is done (green review ${found.review.id}); factory_complete_slice already ran. Ask the user: factory_reopen fixes these in slice ${found.slice.id}, factory_follow_up builds them in a new slice on top of the stack.`,
    );
  }
  requireUnplaced(run, found.review.id, found.observations);
  return { bug, ...found };
}

/**
 * Sends the active slice from its green review back to the fix loop for the bug the user found and the observations
 * the user chose to fix in this slice. A round with a bug counts against the round limit; an observation-only round
 * does not, and never stalls. The slice earns checks and a new review before it completes.
 */
export function fixObservations(ws: Workspace, run: Run, request: FixRequest, reason: string) {
  const { bug, observations, review, slice } = planFix(ws, run, request);
  const ids = observations.map(finding => finding.id);
  addEvent(run, 'fix-observations', `${review.id}: ${[...(bug === undefined ? [] : ['bug']), ...ids].join(', ')}`, slice);
  placeObservations(run, review, slice, observations, 'fixed');
  const why = evidence(reason, 4_000);
  const records: FixRecord[] = [
    ...(bug === undefined
      ? []
      : [
          {
            item: { kind: 'bug' as const, summary: evidenceLine(`Bug found after green review ${review.id}: ${bug}`) },
            section: `## Bug found after green review ${review.id}\n\n${why}\n\n${redact(bug)}`,
          },
        ]),
    ...observations.map(finding => findingRecord(finding, `## Observations from green review ${review.id} the user chose to fix\n\n${why}`, run.decisions)),
  ];
  return requestFix(ws, run, slice, review.sha, records, bug !== undefined);
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
  const found = resolveObservations(ws, run, chosen, 'leave observations');
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
