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

/** The last line of a carried-in section: the ledger keys it carries, which `carriesKey` reads whatever the header says. */
export function carriedKeysLine(keys: string[]) {
  return `${KEYS_PREFIX}${keys.map(key => `\`${key}\``).join(', ')}`;
}

/** Whether `section` lists `key` in its carried keys line. `undefined` for a section without one (from before they were written). */
export function carriesKey(section: string, key: string) {
  const line = section.split('\n').findLast(candidate => candidate.startsWith(KEYS_PREFIX));
  return line === undefined ? undefined : line.slice(KEYS_PREFIX.length).split(', ').includes(`\`${key}\``);
}

/** The ledger keys listed on the carried keys line of `section`; `undefined` for a section without one. */
export function carriedKeys(section: string) {
  const line = section.split('\n').findLast(candidate => candidate.startsWith(KEYS_PREFIX));
  return line === undefined ? undefined : line.slice(KEYS_PREFIX.length).split(', ').map(key => key.slice(1, -1));
}

/** A carried-in section taken apart: its header line, its items (a note, and each rendered finding with the id its heading names), and its keys. `undefined` for a section without a carried keys line. */
export function splitCarried(section: string) {
  const keys = carriedKeys(section);
  if (keys === undefined) return undefined;
  const lines = section.split('\n');
  const header = lines[0] ?? '';
  const body = lines.slice(1, lines.findLastIndex(line => line.startsWith(KEYS_PREFIX))).join('\n').trim();
  // A finding's text may hold a heading-shaped line of its own, so a candidate boundary counts only when its id is the next key's: any other chunk continues the item (or note) before it.
  const items: { id: string | undefined; text: string }[] = [];
  let next = 0;
  // A continuation chunk headed with the id of one of the keys cannot be told from the real finding of that key: the section is ambiguous.
  let ambiguous = false;
  const keyIds = keys.map(key => key.slice(key.indexOf(':') + 1));
  for (const chunk of body === '' ? [] : body.split(/\n\n(?=#### \[[^\]\n]+\] [^\n]+\n\n- Location: )/)) {
    const id = /^#### \[[^\]\n]+\] ([^\n]+)/.exec(chunk)?.[1];
    const expected = keys[next];
    const last = items.at(-1);
    if (id !== undefined && expected !== undefined && id === expected.slice(expected.indexOf(':') + 1)) {
      items.push({ id, text: chunk });
      next += 1;
    } else if (last === undefined) items.push({ id: undefined, text: chunk });
    else {
      last.text += `\n\n${chunk}`;
      if (id !== undefined && keyIds.includes(id)) ambiguous = true;
    }
  }
  return { ambiguous: ambiguous || next !== keys.length, header, items, keys };
}

/** A carried-in section from the parts `splitCarried` returns, holding only `items` and `keys`. */
export function joinCarried(header: string, items: string[], keys: string[]) {
  return `${header}\n\n${items.join('\n\n')}\n\n${carriedKeysLine(keys)}`;
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
 * Moves the carried items each child of a re-slice names (`carried` keys) from the first child to that child, whole: its
 * rendered text under the header of its review and a keys line naming only its keys. Everything unnamed (items, notes,
 * sections without keys) stays with the first child. Throws, naming the key, for a key the split slice does not carry,
 * a key named twice, or a key in a section without a keys line; the children are built before it is called, so nothing is saved.
 */
export function moveCarried(active: CarriedSlice, inputs: { carried?: string[] | undefined; title: string }[], children: CarriedSlice[]) {
  const [first] = children;
  const named = new Map<string, number>();
  inputs.forEach(input => {
    const at = children.findIndex(child => child.title === input.title);
    for (const key of input.carried ?? []) {
      if (named.has(key)) throw new Error(`Carried key ${key} is named by two children; give it to the one child that builds it.`);
      named.set(key, at);
    }
  });
  if (first === undefined || named.size === 0) return;
  const sections = active.carried.map(section => ({ parts: splitCarried(section), section }));
  const carriedKeys = new Set(sections.flatMap(({ parts }) => parts?.keys ?? []));
  for (const key of named.keys()) {
    if (carriedKeys.has(key)) continue;
    const keyless = active.carried.some(section => carriesKey(section, key) === undefined && isCarriedSectionOf(section, key.slice(0, Math.max(key.indexOf(':'), 0))) && renderedObservation(section, key.slice(key.indexOf(':') + 1)) !== undefined);
    throw new Error(keyless ? `Carried key ${key} is in a section without a Carried keys line, so it cannot move; it stays with the first child.` : `Slice ${active.id} does not carry ${key}.`);
  }
  for (const { parts } of sections) {
    const unsafe = parts?.ambiguous === true ? parts.keys.find(key => named.has(key)) : undefined;
    if (unsafe !== undefined) throw new Error(`Carried key ${unsafe} is ambiguous: its section holds text that looks like another finding's heading, so it cannot be moved safely.`);
  }
  const received = children.map((): string[] => []);
  first.carried = sections.flatMap(({ parts, section }) => {
    if (parts === undefined) return [section];
    const kept = { items: [] as string[], keys: [] as string[] };
    parts.items.forEach(item => {
      const key = parts.keys.find(candidate => item.id !== undefined && candidate.slice(candidate.indexOf(':') + 1) === item.id);
      const to = key === undefined ? 0 : (named.get(key) ?? 0);
      if (to === 0 || key === undefined) kept.items.push(item.text);
      else received[to]?.push(joinCarried(parts.header, [item.text], [key]));
    });
    kept.keys = parts.keys.filter(key => (named.get(key) ?? 0) === 0);
    return kept.items.length === 0 ? [] : [joinCarried(parts.header, kept.items, kept.keys)];
  });
  children.forEach((child, at) => {
    if (at > 0) child.carried = received[at] ?? [];
  });
}
