/**
 * The run's observation ledger: every observation the user handled, carried, deferred, fixed or left, with the text of
 * its finding. One check refuses an observation the ledger holds, whichever tool placed it, and the review data file
 * lists the entries so a reviewer and the validator can tell a repeat from a new observation.
 */
import { itemKey } from './deferred.ts';
import { evidenceLine, redact } from './evidence.ts';
import type { DeferredItem, Finding, ObservationEntry, Run, Slice } from './run.ts';

/** Where a handled observation went. */
export const PLACEMENTS = ['carried', 'deferred', 'fixed', 'left'] as const;

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

/** What a rendered finding (`renderFinding`) says of itself: its location, title and problem. Undefined when `section` holds no such observation. */
export function renderedObservation(section: string, id: string) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const found = new RegExp(`\\[observation\\] ${escaped}\\n\\n- Location: ([^\\n]*)\\n- Title: ([\\s\\S]*?)\\n- Problem: ([\\s\\S]*?)\\n- Fix: `).exec(section);
  return found === null ? undefined : { location: found[1] ?? '', problem: found[3] ?? '', title: found[2] ?? '' };
}

/** What an entry migrated from a state file holds when no single rendered finding is found for it. */
const LEGACY_LOCATION = 'unknown';
const LEGACY_PROBLEM = 'Recorded before the run kept the text of handled observations.';

/**
 * The ledger of a state file from before it was kept: an entry for each carried key and each deferred observation item.
 * `sections` are the carried-in sections of the tickets and the end queue, each with where it waits.
 */
export function legacyObservations(carried: string[], deferred: DeferredItem[], sections: { text: string; to: string }[]) {
  // LEGACY-STATE(carried-observations): a state file from before the ledger kept carried observations as `review:id` keys and deferred ones as deferred items. Each becomes an entry whose location, title and problem are read from the finding that exactly one carried-in section or the deferred item body rendered. An entry whose text is not found that way, or is found in more than one carried-in section, gets the placeholder location and problem and its id as title, so the state always loads and a repeat is still refused by key. A key both carried and deferred is one entry, carried. Remove once no run saved before the release that ships the ledger is left to resume.
  const entries: ObservationEntry[] = [];
  for (const key of new Set(carried)) {
    const at = key.indexOf(':');
    const review = at < 1 ? key : key.slice(0, at);
    const id = at < 1 || at === key.length - 1 ? key : key.slice(at + 1);
    const matching = sections.filter(candidate => candidate.text.startsWith(`### From green review ${review} of slice `) && renderedObservation(candidate.text, id) !== undefined);
    const [section, ...others] = matching;
    const rendered = section === undefined || others.length > 0 ? undefined : renderedObservation(section.text, id);
    const base = { id, key, placement: 'carried' as const, review, slice: review.split('-')[0] ?? review };
    entries.push(rendered === undefined || section === undefined ? { ...base, location: LEGACY_LOCATION, problem: LEGACY_PROBLEM, title: id } : { ...base, to: section.to, ...rendered });
  }
  for (const item of deferred.filter(candidate => candidate.kind === 'observation' && candidate.id !== undefined && !entries.some(entry => entry.key === candidate.key))) {
    const id = item.id ?? item.key;
    const base = { id, key: item.key, placement: 'deferred' as const, review: item.review, slice: item.slice };
    entries.push({ ...base, ...(renderedObservation(item.body, id) ?? { location: LEGACY_LOCATION, problem: LEGACY_PROBLEM, title: id }) });
  }
  return entries;
}
