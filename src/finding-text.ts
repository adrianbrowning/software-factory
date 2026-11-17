/** How a finding reads in a data file, a fix file, a carried-in ticket section and a deferred item. */
import { evidence, redact } from './evidence.ts';
import { itemKey } from './deferred.ts';
import { findingLocation } from './ledger.ts';
import { carriedHeader, carriedKeysLine } from './legacy-observations.ts';
import type { Decision, Finding, Run, Slice } from './run.ts';

/** A finding as a markdown section under a `heading` of the given level (`##` by default). */
export function renderFinding(finding: Finding, decisions: Decision[], heading = '##') {
  const decision = finding.decision === undefined ? '' : `\n- Breaks decision ${finding.decision}: ${redact(decisions[finding.decision - 1]?.text ?? '')}`;
  return `${heading} [${finding.severity}] ${finding.id}\n\n- Location: ${findingLocation(finding)}\n- Title: ${evidence(finding.title, 500)}\n- Problem: ${evidence(finding.problem, 2_000)}\n- Fix: ${evidence(finding.fix, 2_000)}\n- Fix prompt: ${evidence(finding.fix_prompt, 2_000)}${decision}`;
}

/** The carried-in section for `observations` of `review` (green unless it is a red review's) and an optional note: header, items, and the ledger keys it carries, which the receiving slice's data file reads. */
export function carriedSection(run: Run, review: { id: string }, slice: Pick<Slice, 'id' | 'title'>, observations: Finding[], note?: string, green = true) {
  const items = [...(note === undefined ? [] : [redact(note)]), ...observations.map(finding => renderFinding(finding, run.decisions, '####'))];
  return `${carriedHeader(review.id, slice, green)}\n\n${items.join('\n\n')}\n\n${carriedKeysLine(observations.map(finding => itemKey(review.id, finding.id)))}`;
}
