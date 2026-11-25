/** What a recorded review leaves on disk and in the run: its artifacts, the validation schema, and the kept findings. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { evidenceLine } from './evidence.ts';
import { renderFinding } from './finding-text.ts';
import { findingLocation } from './ledger.ts';
import { type Decision, type Domain, type Finding, findingListSchema, OBSERVATION_CATEGORIES, reviewDir, reviewDomains, type Run, type Slice, type Workspace } from './run.ts';
import type { FixRecord } from './workflow.ts';

export type Review = NonNullable<Slice['review']>;

export const domainFile = (ws: Workspace, run: Run, reviewId: string, domain: string) =>
  join(reviewDir(ws, run.feature, reviewId), 'domains', `${domain}.json`);

export const validationFile = (ws: Workspace, run: Run, reviewId: string) => join(reviewDir(ws, run.feature, reviewId), 'validation.json');

export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

/** Reads a review artifact only if it is byte-for-byte what the factory tool wrote. */
export function readRecorded(path: string, recorded: { hash: string } | undefined) {
  if (recorded === undefined) return undefined;
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (sha256(content) !== recorded.hash) throw new Error(`${path} changed after it was submitted. Start a new review.`);
  return JSON.parse(content) as unknown;
}

/** Every reviewed domain's submitted findings, read only where the file is what the factory tool wrote. */
export function recordedFindings(ws: Workspace, run: Run, review: Review) {
  const findings: Finding[] = [];
  const missing: string[] = [];
  for (const domain of reviewDomains(review.skipped)) {
    const raw = readRecorded(domainFile(ws, run, review.id, domain), review.submissions[domain]);
    if (raw === undefined) missing.push(domain);
    else findings.push(...findingListSchema.parse(raw));
  }
  return { findings, missing };
}

const escalateBase = { id: z.string().min(1), reason: z.string().min(1) };
const decisionField = z.number().int().positive().describe('Number of the recorded decision the code breaks; give exactly one of `decision` or `criterion`');
const criterionField = z.string().min(1).describe('The quoted acceptance criterion the code does not meet, read literally; give exactly one of `decision` or `criterion`');
export const escalateDescription = 'observation findings that show the code breaks a recorded user decision (`decision`) or does not meet an acceptance criterion as written (`criterion`); kept as high';

/**
 * An escalate entry as the factory_review_validate tool advertises it: `decision` and `criterion` both optional, with no
 * anyOf or `not`, so the tool argument check lets a neither-or-both entry through and `validationSchema.parse` refuses it with the finding id.
 */
export const escalateInputSchema = z.strictObject({ ...escalateBase, criterion: criterionField.optional(), decision: decisionField.optional() });

export const validationSchema = z.object({
  dropped: z
    .array(
      z.object({
        duplicateOf: z
          .string()
          .min(1)
          .optional()
          .describe('Kept finding id this one repeats; the kept one must be at least as severe'),
        id: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .describe('Findings removed, each with a reason'),
  downgrade: z
    .array(
      z.object({
        category: z
          .enum(OBSERVATION_CATEGORIES)
          .optional()
          .describe('Required when the reviewer gave the finding no category: what the observation is about (correctness, missing-test, misleading-doc, naming, structure or style); it sets where the observation goes by default'),
        id: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .default([])
    .describe('critical/high findings the diff supports but that fail the correctness-or-requirements bar; kept as observations'),
  escalate: z
    .array(
      z.union(
        [
          z.strictObject({
            criterion: z.never().optional(),
            decision: decisionField,
            ...escalateBase,
          }),
          z.strictObject({
            decision: z.never().optional(),
            criterion: criterionField,
            ...escalateBase,
          }),
        ],
        {
          error: issue => {
            const id = typeof issue.input === 'object' && issue.input !== null && 'id' in issue.input ? String(issue.input.id) : '?';
            return `"${id}": an escalate entry gives exactly one of \`decision\` (a recorded decision number) or \`criterion\` (the quoted acceptance criterion).`;
          },
        },
      ),
    )
    .default([])
    .describe(escalateDescription),
  keep: z.array(z.string().min(1)).describe('Ids of findings the diff substantiates, one per distinct problem'),
});

export type Validation = z.infer<typeof validationSchema>;

/**
 * Kept findings at the severity the gate uses: downgraded findings count as observations (with the category the
 * validator gave one that had none), escalated ones as high and, when the validator cited a decision or an unmet criterion, carry it.
 */
export function keptFindings(findings: Finding[], validation: Validation) {
  const downgraded = new Map(validation.downgrade.map(entry => [entry.id, entry.category]));
  const escalated = new Map(validation.escalate.map(entry => [entry.id, entry]));
  return findings
    .filter(finding => validation.keep.includes(finding.id) || downgraded.has(finding.id) || escalated.has(finding.id))
    .map(finding => {
      if (downgraded.has(finding.id)) return { ...finding, category: finding.category ?? downgraded.get(finding.id), severity: 'observation' as const };
      const entry = escalated.get(finding.id);
      if (entry !== undefined) return { ...finding, ...(entry.criterion === undefined ? { decision: entry.decision } : { criterion: entry.criterion }), severity: 'high' as const };
      return finding;
    });
}

/** The targeting a fix round after `review` leaves for the next review: the domains that need another look. */
export function targetingAfter(review: { id: string; sha: string }, domains: readonly Domain[]) {
  return { base: review.sha, domains: [...new Set(domains)], from: review.id };
}

/** A finding as a fix record in `group`: its id and summary `[severity] <location>: title` as the fix item, and its location-free `title`. */
export function findingRecord(finding: Finding, group: string, decisions: Decision[]): FixRecord & { title: string } {
  const title = `[${finding.severity}] ${evidenceLine(finding.title, 500)}`;
  const summary = `[${finding.severity}] ${findingLocation(finding)}: ${evidenceLine(finding.title, 500)}`;
  return { group, item: { id: finding.id, summary }, section: renderFinding(finding, decisions, '###'), title };
}
