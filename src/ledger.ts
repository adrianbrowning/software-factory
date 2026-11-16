/**
 * The run's observation ledger: every observation the user handled, carried, deferred, fixed or left, with the text of
 * its finding. One check refuses an observation the ledger holds, whichever tool placed it, and the review data file
 * lists the entries so a reviewer and the validator can tell a repeat from a new observation.
 */
import { itemKey } from './deferred.ts';
import { evidenceLine, redact } from './evidence.ts';
import { PLACEMENTS } from './run.ts';
import type { Finding, ObservationEntry, Run, Slice } from './run.ts';

/** Where a finding points: `path:line`, or `path` when it names no line. */
export function findingLocation(finding: Finding) {
  return `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`;
}

/** What a ledger entry keeps of its finding: where it points, and its title and problem in full, redacted. */
export function ledgerText(finding: Finding) {
  return { location: findingLocation(finding), problem: redact(finding.problem), title: redact(finding.title) };
}

/** Throws for an observation the ledger already holds, naming each placement: `Observations already carried: a, b. Observations already left: c.` */
export function requireUnplaced(run: Run, reviewId: string, observations: { id: string }[]) {
  const lines = PLACEMENTS.flatMap(placement => {
    const held = observations.filter(finding => run.observations.some(entry => entry.key === itemKey(reviewId, finding.id) && entry.placement === placement));
    return held.length === 0 ? [] : [`Observations already ${placement}: ${held.map(finding => finding.id).join(', ')}.`];
  });
  if (lines.length > 0) throw new Error(lines.join(' '));
}

/** Adds one ledger entry per observation of `review`, kept in `slice`, with the finding's location, title and problem. `to` is where a carried one went. */
export function placeObservations(run: Run, review: { id: string }, slice: Slice, observations: Finding[], placement: ObservationEntry['placement'], to?: string) {
  for (const finding of observations) {
    run.observations.push({
      id: finding.id,
      key: itemKey(review.id, finding.id),
      placement,
      review: review.id,
      slice: slice.id,
      ...ledgerText(finding),
      ...(to === undefined ? {} : { to }),
    });
  }
}

/** The mark after the placement of an entry in the list of a review data file, `(carried; carried to this slice: check it)`, for work carried to the slice under review, which that slice builds and its reviewers check. */
export const CARRIED_HERE = 'carried to this slice: check it';

/**
 * The ledger as a list for the data file of the review of `slice`, one entry per item with its key, placement, location,
 * title and problem, each text on one line and cut at 500 and 2000 characters; `None.` for an empty ledger. An entry
 * carried to `slice` is marked `CARRIED_HERE`: a finding that it is unbuilt or wrong there is kept, not dropped as `same as <key>`.
 */
export function renderKnownObservations(run: Run, slice: Pick<Slice, 'id'>) {
  if (run.observations.length === 0) return 'None.';
  return run.observations.map(entry => `- \`${entry.key}\` (${entry.placement === 'carried' && entry.to === slice.id ? `${entry.placement}; ${CARRIED_HERE}` : entry.placement}): ${entry.location} - ${evidenceLine(entry.title, 500)}\n  Problem: ${evidenceLine(entry.problem, 2_000)}`).join('\n');
}
