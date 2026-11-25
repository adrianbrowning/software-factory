/** How a finding reads in a data file, a fix file, a carried-in ticket section and a deferred item. */
import { evidence, evidenceLine, redact } from './evidence.ts';
import { itemKey } from './deferred.ts';
import { findingLocation, findingTitle } from './ledger.ts';
import { carriedHeader, carriedKeysLine, noteText } from './legacy-observations.ts';
import type { Decision, Finding, Run, Slice } from './run.ts';

/**
 * A finding as a markdown section under a `heading` of the given level (`##` by default). `filed` is for a deferred item: the symbol
 * comes first and the path:line is marked as the location at filing time, since the line moves as the code changes.
 */
export function renderFinding(finding: Finding, decisions: Decision[], heading = '##', filed = false) {
  const decision = finding.decision === undefined ? '' : `\n- Breaks decision ${finding.decision}: ${redact(decisions[finding.decision - 1]?.text ?? '')}`;
  const criterion = finding.criterion === undefined ? '' : `\n- Does not meet criterion: ${redact(finding.criterion)}`;
  return `${heading} [${finding.severity}] ${finding.id}\n\n${filed ? filedLocation(finding) : `- Location: ${findingLocation(finding)}`}\n- Title: ${findingTitle(finding.title)}\n- Problem: ${evidence(finding.problem, 2_000)}\n- Fix: ${evidence(finding.fix, 2_000)}\n- Fix prompt: ${evidence(finding.fix_prompt, 2_000)}${decision}${criterion}`;
}

function filedLocation(finding: Finding) {
  const symbol = finding.symbol === undefined ? '' : `- Symbol: ${evidenceLine(finding.symbol, 200)}\n`;
  return `${symbol}- Location at filing time: ${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`;
}

/** The note text the carry dialog shows and the carried-in ticket section stores. */
export function storedNote(note: string) {
  return noteText(redact(note));
}

/** The carried-in sections for `observations` of `review` (green unless it is a red review's) and an optional note: one section per observation (header, the rendered item, and a keys line with its one ledger key, which the receiving slice's data file reads) and the note as its own section without keys. */
export function carriedSections(run: Run, review: { id: string }, slice: Pick<Slice, 'id' | 'title'>, observations: Finding[], note?: string, green = true) {
  const header = carriedHeader(review.id, slice, green);
  return [
    ...(note === undefined ? [] : [`${header}\n\n${storedNote(note)}\n\n${carriedKeysLine([])}`]),
    ...observations.map(finding => `${header}\n\n${renderFinding(finding, run.decisions, '####')}\n\n${carriedKeysLine([itemKey(review.id, finding.id)])}`),
  ];
}
