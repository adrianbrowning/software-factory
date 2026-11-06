import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { evidenceHead, evidenceLine, redact } from './evidence.ts';
import { type Finding, findingListSchema, REVIEW_DOMAINS, reviewDir, type Run, runDir, type Workspace, writeAtomic } from './run.ts';
import { configuredTrunk } from './workflow.ts';

/** A slice PR as `gh stack view --json` names it after submit. */
export type SlicePr = { number: number; url?: string | undefined };

const list = (items: string[]) => (items.length === 0 ? 'None' : items.join('\n'));

/**
 * The single PR that lands a landOn run on the trunk: the source issue title, and a Markdown body from run state.
 * `observations` holds the kept observations of each slice's final green review, by slice id; `prs` each slice's PR,
 * by branch. Fails for a slice whose PR has no URL or that has no recorded review. Issue and finding text is redacted.
 */
export function renderHandoff(run: Run, observations: Map<string, Finding[]>, prs: Map<string, SlicePr>) {
  const reviewed = run.slices.map(slice => {
    const url = prs.get(slice.branch)?.url;
    if (url === undefined) throw new Error(`gh stack view --json gave no PR URL for ${slice.branch}.`);
    if (slice.review === undefined) throw new Error(`Slice ${slice.id} has no recorded review.`);
    return { review: slice.review, slice, url };
  });
  const title = redact(run.source.title);
  const label = (slice: Run['slices'][number]) => `${slice.id} ${evidenceLine(slice.title)}`;
  const issue = [
    `- Ref: ${evidenceLine(run.source.ref)}`,
    `- Title: ${title}`,
    ...(run.source.url === undefined ? [] : [`- URL: ${evidenceLine(run.source.url)}`]),
  ];
  const summary = `Lands software-factory run ${run.feature}: ${run.slices.length} ${run.slices.length === 1 ? 'slice' : 'slices'}, each built test-first, checked and reviewed, stacked onto ${run.trunk}: ${run.slices.map(label).join('; ')}.`;
  const changes = reviewed.map(
    ({ slice, url }) => `### ${label(slice)} (${url})\n\n${evidenceHead(slice.whatToBuild, 4_000)}\n\n${slice.acceptance.map(item => `- ${evidenceLine(item, 1_000)}`).join('\n')}`,
  );
  const checks = run.slices.flatMap(slice =>
    (slice.checked?.results.length ?? 0) === 0 ? [`- ${label(slice)}: no results recorded`] : (slice.checked?.results ?? []).map(result => `- ${label(slice)}: ${evidenceLine(result)}`),
  );
  const reviews = reviewed.map(({ review, slice }) => {
    const domains = REVIEW_DOMAINS.filter(domain => !review.skipped.some(entry => entry.domain === domain)).join(', ');
    return `- ${label(slice)}: ${slice.reviews} review ${slice.reviews === 1 ? 'round' : 'rounds'}; domains: ${domains}`;
  });
  const decisions = run.decisions.map((decision, index) => `${index + 1}. ${evidenceLine(decision, 2_000)}`);
  // The retro slice built the repo `apply` findings; every other finding is still open.
  const { applied = [], open = [] } = Object.groupBy(run.retroFindings, finding => (finding.action === 'apply' && finding.target === 'repo' ? 'applied' : 'open'));
  const concerns = [
    ...run.slices.flatMap(slice =>
      (observations.get(slice.id) ?? []).map(
        finding => `- Slice ${slice.id} observation ${evidenceLine(finding.id)}: ${evidenceLine(finding.title)} (${evidenceLine(`${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`)})`,
      ),
    ),
    ...open.map(finding => `- Retro finding not applied (${finding.target}, ${finding.action}, ${finding.severity}): ${evidenceLine(finding.title)}`),
    ...run.events
      .filter(event => event.kind === 'stall' || event.kind === 'budget-exceeded')
      .map(event => `- ${event.slice === undefined ? 'Run' : `Slice ${event.slice}`} ${event.kind}: ${evidenceLine(event.detail)}`),
  ];
  const appliedFindings = applied.map(finding => `- [${finding.severity}] ${evidenceLine(finding.title)}`);
  const body = [
    `## Issue\n\n${issue.join('\n')}`,
    `## Summary\n\n${summary}`,
    `## Changes\n\n${changes.join('\n\n')}`,
    `## Checks\n\n${checks.join('\n')}`,
    `## Reviews\n\n${reviews.join('\n')}`,
    `## Decisions\n\n${list(decisions)}`,
    `## Outstanding concerns\n\n${list(concerns)}`,
    `## Retro findings applied\n\n${list(appliedFindings)}`,
    `## Factory\n\nFeature: ${run.feature}`,
  ].join('\n\n');
  return { body: `${body}\n`, title };
}

const recordedReview = z.object({ findings: findingListSchema });

/** The kept observations of each slice's final green review, by slice id, from its review.json; renderHandoff refuses a slice with no recorded review. */
function finalObservations(ws: Workspace, run: Run) {
  const observations = new Map<string, Finding[]>();
  for (const slice of run.slices) {
    if (slice.review === undefined) continue;
    const recorded = recordedReview.parse(JSON.parse(readFileSync(join(reviewDir(ws, run.feature, slice.review.id), 'review.json'), 'utf8')));
    observations.set(slice.id, recorded.findings.filter(finding => finding.severity === 'observation'));
  }
  return observations;
}

/**
 * Writes the landOn run's single-PR handoff to `<run dir>/pr.md` (the title as its heading, then the body) and returns
 * what the user does next: merge the stack into landOn, then push it and open one PR from it to the configured trunk.
 * Fails, writing nothing, when renderHandoff does. Opens no PR and merges nothing.
 */
export async function writeHandoff(ws: Workspace, run: Run, landOn: string, prs: Map<string, SlicePr>) {
  const { body, title } = renderHandoff(run, finalObservations(ws, run), prs);
  const trunk = await configuredTrunk(ws);
  const path = join(runDir(ws, run.feature), 'pr.md');
  writeAtomic(path, `# ${title}\n\n${body}`);
  return `Next: merge the stack into ${landOn}, then push ${landOn} and open one PR from ${landOn} to ${trunk}.\nPR title: ${title}\nPR body: ${path}`;
}
