/**
 * Reads the observation ledger of a state file saved before it was kept. It imports only types from run.ts, which calls it
 * while loading state, so no runtime cycle forms.
 */
import type { ObservationEntry } from './run.ts';

type CarriedSlice = { carried: string[]; id: string; title: string };

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
const NO_KEYS = '(none)';

/** The last line of a carried-in section: the ledger keys it carries, which `carriesKey` reads whatever the header says. No keys (a note) writes `(none)`, so the section is never taken for one from before keys lines. */
export function carriedKeysLine(keys: string[]) {
  return `${KEYS_PREFIX}${keys.length === 0 ? NO_KEYS : keys.map(key => `\`${key}\``).join(', ')}`;
}

/** The keys line of `section`: its last line, when it starts with the prefix. A note's line is `(none)`; `noteText` indents keys-like lines inside note text so they are never last. */
function keysLine(section: string) {
  const line = section.split('\n').at(-1);
  return line?.startsWith(KEYS_PREFIX) === true ? line : undefined;
}

/** A carried note with any line that looks like a keys line indented, so a note is never read as carrying keys. */
export function noteText(note: string) {
  return note.replace(/^Carried keys: /gm, ' Carried keys: ');
}

/** Whether `section` lists `key` in its carried keys line. `undefined` only for a section from an older state file without one; a note returns false. */
export function carriesKey(section: string, key: string) {
  const line = keysLine(section);
  return line === undefined ? undefined : line.slice(KEYS_PREFIX.length).split(', ').includes(`\`${key}\``);
}

/** The ledger keys listed on the carried keys line of `section`; `undefined` for a section without one. */
export function carriedKeys(section: string) {
  const line = keysLine(section);
  if (line === undefined) return undefined;
  const listed = line.slice(KEYS_PREFIX.length);
  return listed === NO_KEYS ? [] : listed.split(', ').map(key => key.slice(1, -1));
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

/**
 * Moves the carried sections each child of a re-slice names (`carried` keys) from the first child to that child, whole.
 * Everything unnamed (sections, notes, sections without keys) stays with the first child. Throws, naming the key, for a
 * key the split slice does not carry, a key named twice, a key in a section without a keys line, or a key in a section
 * that lists several keys or also holds a note (from an older state file; it is not split); the children are built before it is called, so nothing is saved.
 */
export function moveCarried(active: CarriedSlice, inputs: { carried?: string[] | undefined; title: string }[], children: CarriedSlice[]) {
  const [first] = children;
  const named = new Map<string, number>();
  inputs.forEach(input => {
    const at = children.findIndex(child => child.title === input.title);
    for (const key of new Set(input.carried ?? [])) {
      if (named.has(key)) throw new Error(`Carried key ${key} is named by two children; name it under the one child that builds it and call again.`);
      named.set(key, at);
    }
  });
  if (first === undefined || named.size === 0) return;
  const destination = (section: string) => {
    const keys = carriedKeys(section) ?? [];
    return keys.length === 1 ? (named.get(keys[0] ?? '') ?? 0) : 0;
  };
  for (const key of named.keys()) {
    const holder = active.carried.find(section => carriesKey(section, key) === true);
    if (holder !== undefined) {
      if ((carriedKeys(holder)?.length ?? 0) > 1) throw new Error(`Carried key ${key} is in a section that lists several keys (from an older state file), so it cannot move; drop it from \`carried\` and call again, the section stays with the first child.`);
      // The section must be the whole one-line header, then the key's item heading; anything between them (a note) or a title with a newline is refused.
      const review = key.slice(0, Math.max(key.indexOf(':'), 0));
      const heading = `\n\n#### [observation] ${key.slice(key.indexOf(':') + 1)}\n\n- Location: `;
      const [headerLine = ''] = holder.split('\n');
      const wellFormed = headerLine.endsWith('"') && isCarriedSectionOf(headerLine, review) && /^### From (?:green )?review \S+ of slice \S+ ".*"$/.test(headerLine) && holder.startsWith(`${headerLine}${heading}`);
      if (!wellFormed) throw new Error(`Carried key ${key} is in a section that also holds a note or a slice title with a newline (from an older state file), so it cannot move; drop it from \`carried\` and call again, the section stays with the first child.`);
      continue;
    }
    const keyless = active.carried.some(section => carriesKey(section, key) === undefined && isCarriedSectionOf(section, key.slice(0, Math.max(key.indexOf(':'), 0))) && renderedObservation(section, key.slice(key.indexOf(':') + 1)) !== undefined);
    throw new Error(keyless ? `Carried key ${key} is in a section without a Carried keys line, so it cannot move; drop it from \`carried\` and call again, the section stays with the first child.` : `Slice ${active.id} does not carry ${key}.`);
  }
  first.carried = active.carried.filter(section => destination(section) === 0);
  children.forEach((child, at) => {
    if (at > 0) child.carried = active.carried.filter(section => destination(section) === at);
  });
}
