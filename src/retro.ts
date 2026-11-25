import { join } from 'node:path';
import { z } from 'zod';
import type { DeferredSink } from './config.ts';
import { retroDraft, retroKey } from './deferred.ts';
import { evidence, evidenceLine } from './evidence.ts';
import { gh } from './exec.ts';
import { addEvent, runDir, type Run, type Slice, type Workspace, writeAtomic } from './run.ts';
import { nextAction, planAppend, pushSlice, settle, waitingNotice } from './workflow.ts';

export const RETRO_CATEGORIES = [
  'navigation',
  'automated-checks',
  'coding-standards',
  'agents-md',
  'tool-economy',
  'no-ops',
  'information-access',
] as const;

const RETRO_SEVERITIES = ['high', 'medium', 'low'] as const;

export const retroFindingSchema = z
  .object({
    action: z.enum(['apply', 'file-issue', 'skip']).describe('apply: repo change in a final slice; file-issue: factory issue'),
    category: z.enum(RETRO_CATEGORIES),
    detail: z.string().min(1),
    severity: z.enum(RETRO_SEVERITIES),
    target: z.enum(['repo', 'factory']).describe('repo: the repository worked on; factory: this plugin'),
    title: z.string().min(1),
  })
  .refine(finding => finding.action !== 'apply' || finding.target === 'repo', 'only repo findings can be applied')
  .refine(finding => finding.action !== 'file-issue' || finding.target === 'factory', 'only factory findings become issues');
export type RetroFinding = z.infer<typeof retroFindingSchema>;
export const retroSchema = z.object({ findings: z.array(retroFindingSchema) });

function requireRetroOpen(run: Run) {
  if (run.waiting.length > 0) {
    const next = nextAction(run);
    throw new Error(next === waitingNotice(run) ? next : `Carried items wait for the end of the run (${run.waiting.length}), and the retro waits for them. ${next}`);
  }
  const finished = run.slices.length > 0 && run.slices.every(slice => slice.status === 'done');
  if (!finished && run.status !== 'stalled') throw new Error('Retro runs when every slice is done or the run is stalled.');
  if (run.retroRecorded) throw new Error('The retro for this run is already recorded.');
}

/** A parsed retro. `ordinal` numbers it among the run's retros, so its deferred findings are keyed once, when it is parsed. */
export type Retro = { apply: RetroFinding[]; file: RetroFinding[]; findings: RetroFinding[]; ordinal: number; slice?: Slice | undefined };

/**
 * Validates the retro, groups its actions, and builds the apply slice, all without changing the run, so the user
 * confirms and issues are filed only for a retro that `recordRetro` can record.
 */
export function parseRetro(ws: Workspace, run: Run, proposed: unknown): Retro {
  requireRetroOpen(run);
  const ordinal = run.events.filter(event => event.kind === 'retro').length + 1;
  const findings = z
    .array(retroFindingSchema)
    .parse(proposed)
    .toSorted((a, b) => RETRO_SEVERITIES.indexOf(a.severity) - RETRO_SEVERITIES.indexOf(b.severity));
  // A headless retro defers every finding: no apply slice, no factory issues.
  if (run.mode === 'headless') return { apply: [], file: [], findings, ordinal, slice: undefined };
  const apply = findings.filter(finding => finding.action === 'apply');
  const slice =
    apply.length === 0
      ? undefined
      : planAppend(ws, run, {
          acceptance: apply.map(finding => finding.title),
          estimateTokens: Math.floor(ws.config.sliceTokenBudget / 4),
          noTestReason: 'Agent-environment changes. A new custom lint rule or script still needs its own test.',
          seams: [],
          title: 'Apply retro improvements',
          whatToBuild: apply.map(finding => `${finding.title}: ${finding.detail}`).join('\n'),
        });
  return { apply, file: findings.filter(finding => finding.action === 'file-issue'), findings, ordinal, slice };
}

/** One draft per finding of a headless retro, in the retro's order. */
export function retroDrafts(run: Run, retro: Retro) {
  return retro.findings.map((finding, index) => retroDraft(run, retro.ordinal, index + 1, finding));
}

/** The issue body a factory finding is filed with. Redacted: retro details come from a possibly private repository. */
export function retroIssueBody(finding: RetroFinding) {
  return `${evidence(finding.detail, 4_000)}\n\nCategory: ${finding.category}. Severity: ${finding.severity}. Filed by a software-factory retro.`;
}

export type FiledIssues = { error?: string | undefined; urls: Record<string, string> };

/** Files each factory finding in order and stops at the first failure, keeping the URLs already filed. */
export async function fileFactoryIssues(ws: Workspace, findings: RetroFinding[]): Promise<FiledIssues> {
  const urls: Record<string, string> = {};
  for (const finding of findings) {
    try {
      urls[finding.title] = (await gh(ws.root, 'issue', 'create', '-R', ws.config.factoryRepo, '--title', retroTitle(finding.title), '--body', retroIssueBody(finding))).trim();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), urls };
    }
  }
  return { urls };
}

/** One retro finding title for the retro dialogs and the filed GitHub issue title: redacted, on one line, clipped at 200 characters (GitHub rejects titles over 256). */
export function retroTitle(title: string) {
  return evidenceLine(title, 200);
}

/** The body of the headless retro gate: where the findings go, then one redacted one-line title per finding. */
export function headlessRetroGateBody(deferred: DeferredSink | undefined, retro: Pick<Retro, 'findings'>) {
  const where = deferred === undefined ? 'nowhere: no deferred sink is configured' : deferred.kind === 'github' ? 'GitHub issues on this repository' : `the sink file ${deferred.path}`;
  return `${retro.findings.length} findings go to ${where}:\n${retro.findings.map(finding => `- ${retroTitle(finding.title)}`).join('\n')}`;
}

/**
 * Records the confirmed retro: writes retro.md (with the URL of each filed issue, or why it was not filed), adds
 * the apply findings as a final slice, and settles the run.
 */
export function recordRetro(ws: Workspace, run: Run, retro: Retro, filed: FiledIssues = { urls: {} }) {
  requireRetroOpen(run);
  if (retro.slice !== undefined && retro.slice.parentBranch !== (run.slices.at(-1)?.branch ?? run.baseSha ?? run.baseRef)) {
    throw new Error('The slices changed since the retro was parsed. Call factory_retro again.');
  }
  const status = (finding: RetroFinding) => {
    if (run.mode === 'headless') {
      const item = run.deferred.find(candidate => candidate.key === retroKey(retro.ordinal, retro.findings.indexOf(finding) + 1));
      return item === undefined ? '\nNot deferred: no deferred sink is configured.\n' : `\nDeferred: ${item.location}\n`;
    }
    if (finding.action !== 'file-issue') return '';
    const url = filed.urls[finding.title];
    return url === undefined ? `\nNot filed${filed.error === undefined ? '' : `: ${filed.error}`}\n` : `\nFiled: ${url}\n`;
  };
  const section = (target: RetroFinding['target'], heading: string) => {
    const items = retro.findings.filter(finding => finding.target === target);
    if (items.length === 0) return `## ${heading}\n\nNone.\n`;
    return `## ${heading}\n\n${items.map(finding => `### [${finding.severity}] ${finding.title} (${finding.category}, ${finding.action})\n\n${finding.detail}\n${status(finding)}`).join('\n')}`;
  };
  writeAtomic(
    join(runDir(ws, run.feature), 'retro.md'),
    `# Retro: ${run.source.title}\n\n${section('repo', 'Target repository')}\n${section('factory', 'Software factory')}`,
  );
  run.retroRecorded = true;
  const repoCount = retro.findings.filter(finding => finding.target === 'repo').length;
  addEvent(run, 'retro', `${retro.findings.length} findings: repo=${repoCount} factory=${retro.findings.length - repoCount}`);
  const slice = retro.slice === undefined ? undefined : pushSlice(ws, run, retro.slice);
  return slice ?? settle(ws, run);
}
