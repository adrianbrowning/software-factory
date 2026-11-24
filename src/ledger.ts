/**
 * The run's observation ledger: every observation the user handled, carried, deferred, fixed or left, with the text of
 * its finding. One check refuses an observation the ledger holds, whichever tool placed it, and the review data file
 * lists the entries so a reviewer and the validator can tell a repeat from a new observation.
 */
import { itemKey } from './deferred.ts';
import { evidenceLine, redact } from './evidence.ts';
import { carriesKey, isCarriedSectionOf, renderedObservation } from './legacy-observations.ts';
import { PLACEMENTS } from './run.ts';
import type { Finding, ObservationEntry, Run, Slice } from './run.ts';

/** The entries of `slice.unplaced` that `id` names: an observation id, or `<review>:<id>` for one. More than one is ambiguous between reviews. */
export function findUnplaced(slice: Pick<Slice, 'unplaced'>, id: string) {
  return slice.unplaced.filter(entry => entry.finding.id === id || itemKey(entry.review, entry.finding.id) === id);
}

/** Where a finding points, without its symbol: `<path>:<line>`, or `<path>` when it names no line. Identity for comparing findings. */
export function findingPlace(finding: Finding) {
  return `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`;
}

/** Where a finding points, for display: `<path>:<line>`; a finding with a symbol shows `<symbol> (<that place>)`, the symbol redacted, on one line and clipped. */
export function findingLocation(finding: Finding) {
  const place = findingPlace(finding);
  return finding.symbol === undefined ? place : `${evidenceLine(finding.symbol, 200)} (${place})`;
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

/** Adds one ledger entry per observation of `review`, kept in `slice`, and takes each off the slice's unplaced list, with the finding's location, title and problem. `to` is where a carried one went when it was carried, written once: later moves of the carried text (a reslice, a follow-up) do not rewrite it, so it is for factory_status only; the review data file reads where the text sits. */
export function placeObservations(run: Run, review: { id: string }, slice: Slice, observations: Finding[], placement: ObservationEntry['placement'], to?: string) {
  const key = (id: string) => itemKey(review.id, id);
  slice.unplaced = slice.unplaced.filter(entry => !observations.some(finding => key(finding.id) === itemKey(entry.review, entry.finding.id)));
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

/** Whether the carried-in sections of `slice` carry `entry`: a section whose carried keys line lists its key, whatever its header says. A section from before they had one is read by its header and rendered observation. Read from where the text sits, so a renumbered or follow-up slice needs no rewrite. */
function isCarriedTo(entry: ObservationEntry, slice: Pick<Slice, 'carried'>) {
  return slice.carried.some(section => carriesKey(section, entry.key) ?? (isCarriedSectionOf(section, entry.review) && renderedObservation(section, entry.id) !== undefined));
}

/** The mark after the placement of an entry in the list of a review data file, `(carried; carried to this slice: check it)`, for work carried to the slice under review, which that slice builds and its reviewers check. */
export const CARRIED_HERE = 'carried to this slice: check it';

/**
 * The ledger as a list for the data file of the review of `slice`, one entry per item with its key, placement, location,
 * title and problem, each text on one line and cut at 500 and 2000 characters, then the slice's unplaced observations
 * marked `(unplaced)`; `None.` when there are neither. An entry carried to `slice` is marked `CARRIED_HERE`: a finding that it is unbuilt or wrong there is kept, not dropped as `same as <key>`.
 */
export function renderKnownObservations(run: Run, slice: Pick<Slice, 'carried' | 'unplaced'>) {
  const lines = run.observations.map(entry => `- \`${entry.key}\` (${entry.placement === 'carried' && isCarriedTo(entry, slice) ? `${entry.placement}; ${CARRIED_HERE}` : entry.placement}): ${entry.location} - ${evidenceLine(entry.title, 500)}\n  Problem: ${evidenceLine(entry.problem, 2_000)}`);
  for (const { finding, review } of slice.unplaced) {
    const text = ledgerText(finding);
    lines.push(`- \`${itemKey(review, finding.id)}\` (unplaced): ${text.location} - ${evidenceLine(text.title, 500)}\n  Problem: ${evidenceLine(text.problem, 2_000)}`);
  }
  return lines.length === 0 ? 'None.' : lines.join('\n');
}
