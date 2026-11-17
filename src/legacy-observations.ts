/**
 * Reads the observation ledger of a state file saved before it was kept. It imports only types from run.ts, which calls it
 * while loading state, so no runtime cycle forms.
 */
import type { ObservationEntry } from './run.ts';

type LegacyDeferred = { body: string; id?: string | undefined; key: string; kind: string; review: string; slice: string };

/** The header of a carried-in section made from the observations of review `reviewId` of `slice`; a green review's carries say so. The only place the header is written. */
export function carriedHeader(reviewId: string, slice: { id: string; title: string }, green = true) {
  return `### From ${green ? 'green ' : ''}review ${reviewId} of slice ${slice.id} "${slice.title}"`;
}

/** Whether `section` is a carried-in section made from review `reviewId`, read from its header. Only for sections from before they listed their keys (see `carriedKeysLine`). */
export function isCarriedSectionOf(section: string, reviewId: string) {
  return section.startsWith(`### From green review ${reviewId} of slice `) || section.startsWith(`### From review ${reviewId} of slice `);
}

const KEYS_PREFIX = 'Carried keys: ';

/** The last line of a carried-in section: the ledger keys it carries, which `carriesKey` reads whatever the header says. */
export function carriedKeysLine(keys: string[]) {
  return `${KEYS_PREFIX}${keys.map(key => `\`${key}\``).join(', ')}`;
}

/** Whether `section` lists `key` in its carried keys line. `undefined` for a section without one (from before they were written). */
export function carriesKey(section: string, key: string) {
  const line = section.split('\n').findLast(candidate => candidate.startsWith(KEYS_PREFIX));
  return line === undefined ? undefined : line.includes(`\`${key}\``);
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
export function legacyObservations(carried: string[], deferred: LegacyDeferred[], sections: { text: string; to: string }[]) {
  // LEGACY-STATE(carried-observations): a state file from before the ledger kept carried observations as `review:id` keys and deferred ones as deferred items. Each becomes an entry whose location, title and problem are read from the finding that exactly one carried-in section or the deferred item body rendered. An entry whose text is not found that way, or is found in more than one carried-in section, gets the placeholder location and problem and its id as title, so the state always loads and a repeat is still refused by key. A key both carried and deferred is one entry, carried. Remove once no run saved before the release that ships the ledger is left to resume.
  const entries: ObservationEntry[] = [];
  for (const key of new Set(carried)) {
    const at = key.indexOf(':');
    const review = at < 1 ? key : key.slice(0, at);
    const id = at < 1 || at === key.length - 1 ? key : key.slice(at + 1);
    const matching = sections.filter(candidate => isCarriedSectionOf(candidate.text, review) && renderedObservation(candidate.text, id) !== undefined);
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
