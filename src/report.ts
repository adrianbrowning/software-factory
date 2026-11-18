import { existsSync, readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { activeSlice, reportPath, requireActive, type Run, type Slice, type Workspace, writeAtomic } from './run.ts';

// One line each, so an item cannot add lines that read as factory output in the factory_checks reply.
const reportItem = z.string().min(1).regex(/^[^\r\n]+$/, 'one line per item');

const behaviorSchema = z
  .object({
    test: reportItem.describe('The test name'),
    behavior: reportItem.describe('The behavior the test proves'),
    seenRed: z.boolean().describe('Whether you watched this test fail before its code existed; false when you never saw it fail'),
    red: reportItem.optional().describe('One line: the failing run you observed. Required when seenRed is true; omit when seenRed is false'),
  })
  .superRefine((entry, ctx) => {
    if (entry.seenRed && entry.red === undefined) ctx.addIssue({ code: 'custom', message: 'red is required when seenRed is true', path: ['red'] });
    if (!entry.seenRed && entry.red !== undefined) ctx.addIssue({ code: 'custom', message: 'omit red when seenRed is false', path: ['red'] });
  });

/** The implementer's final report. The factory keeps it, so a follow-up turn (an advisor note) cannot lose it. */
export const implementerReportSchema = z.object({
  behaviors: z.array(behaviorSchema).describe('Each test, the behavior it proves, and whether you saw it fail first; empty when you wrote no test'),
  commits: z.array(reportItem).describe('Each commit you made, as `<short sha> <subject>`; empty when you made none'),
  fixItems: z
    .array(reportItem)
    .optional()
    .describe('Fix mode only: each id from the fix file\'s "## Fix items", exactly as listed, with `fixed in <sha>`, `already fixed`, or `not a defect: <why>`'),
  open: z.array(reportItem).describe('Anything unfinished, and any stop report (NEEDS SEAM, SLICE TOO BIG, MISSING DEPENDENCY); empty when nothing is open'),
});
export type ImplementerReport = z.infer<typeof implementerReportSchema>;

function renderBehavior({ test, behavior, red }: z.infer<typeof behaviorSchema>) {
  return `${test} → ${behavior} (seen red: ${red === undefined ? 'no' : `yes — ${red}`})`;
}

function renderReport(report: ImplementerReport) {
  const section = (title: string, items: string[]) => [`${title}:`, ...(items.length === 0 ? ['- none'] : items.map(item => `- ${item}`))];
  return [
    'Implementer report:',
    ...section('Commits', report.commits),
    ...(report.fixItems === undefined ? [] : section('Fix file items', report.fixItems)),
    ...section('Behaviors', report.behaviors.map(renderBehavior)),
    ...section('Open', report.open),
  ].join('\n');
}

/** Stores the implementer's report for the active slice in the run dir; a later call replaces it. */
export function submitImplementerReport(ws: Workspace, run: Run, report: ImplementerReport) {
  const slice = requireActive(run);
  if (slice.phase === 'fix' && report.fixItems === undefined) {
    throw new Error(
      `Slice ${slice.id} is in fix mode: list every fix file item in fixItems, each with \`fixed in <sha>\`, \`already fixed\`, or \`not a defect: <why>\`.`,
    );
  }
  const path = reportPath(ws, run.feature, slice);
  const replaced = existsSync(path);
  writeAtomic(path, `${renderReport(report)}\n`);
  return { path, replaced };
}

/** The slice's latest stored implementer report, or a line saying none was submitted; both name the report file. */
export function storedReport(ws: Workspace, run: Run, slice: Slice) {
  const path = reportPath(ws, run.feature, slice);
  if (!existsSync(path)) return `No implementer report was submitted for slice ${slice.id} (factory_implementer_report). Once it is, read it at ${path}`;
  return `${readFileSync(path, 'utf8').trimEnd()}\nReport file: ${path}`;
}

/** Whether the stored report's Commits section lists `sha`: an item starting with a hex prefix of it, at least 7 characters. */
export function reportListsCommit(ws: Workspace, run: Run, slice: Slice, sha: string) {
  const path = reportPath(ws, run.feature, slice);
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.indexOf('Commits:');
  if (start < 0) return false;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    const prefix = /^[0-9a-f]{7,40}/i.exec(line.slice(2))?.[0].toLowerCase();
    if (prefix !== undefined && sha.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * A report belongs to one implementer session: a newly spawned implementer (a fix round, or a respawn after a stop
 * report) starts without the stored report of the one before. A follow-up turn of the same session keeps it.
 */
export function startImplementerSession(ws: Workspace, run: Run) {
  const slice = activeSlice(run);
  if (slice !== undefined) rmSync(reportPath(ws, run.feature, slice), { force: true });
}
