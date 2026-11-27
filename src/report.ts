import { existsSync, readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { itemKey } from './deferred.ts';
import { findUnplaced, placeObservations } from './ledger.ts';
import { git } from './exec.ts';
import { ownCommits, sliceBranchExists } from './repo.ts';
import { TEST_PATH } from './test-paths.ts';
import { changedPaths } from './targeted.ts';
import { findingRecord } from './review-record.ts';
import { carriedKeys } from './legacy-observations.ts';
import { observedTypecheck } from './typecheck.ts';
import { activeSlice, addEvent, reportPath, reviewIsOpen, requireActive, type Run, type Slice, type Workspace, writeAtomic } from './run.ts';

// Guards only items sent through the factory_implementer_report tool: each item is one line (no \r, \n, U+2028, U+2029 or U+0085),
// so it cannot add lines that read as factory output in the factory_checks reply. A reports/<slice>.md written directly is not checked.
const reportItem = z.string().min(1).regex(/^[^\r\n\u2028\u2029\u0085]+$/, 'one line per item');

const checkLine = z.string().regex(/^[^\r\n\u2028\u2029\u0085]+ → exit \d+$/, 'expected `<command> → exit <code>`, for example `pnpm run typecheck → exit 0`');

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
  behaviors: z.array(behaviorSchema).describe('Each test, the behavior it proves, and whether you saw it fail first; an empty list is accepted in fix mode, for a slice without test seams, or when Open names a stop report (NEEDS SEAM, SLICE TOO BIG, MISSING DEPENDENCY); a build-mode report for a slice with seams is refused with an empty list'),
  commits: z.array(reportItem).describe('Each commit you made, as `<short sha> <subject>`; empty when you made none'),
  checks: z.array(checkLine).describe('One `<command> → exit <code>` line per check command you ran (its last run, with the exit code you read), for example `pnpm run typecheck → exit 0`; empty when you ran none. The factory shows these lines and does not verify them'),
  fixItems: z
    .array(reportItem)
    .optional()
    .describe('Required in fix mode with at least one item: each id from the fix file\'s "## Fix items", exactly as listed, with `fixed in <sha>`, `already fixed`, or `not a defect: <why>`. A line may also name an observation of the slice that is still unplaced (its id, or `<review>:<id>` when two reviews kept the same id, at the start of the line) with `fixed in <sha>` for a commit of the slice: the factory then records that observation as fixed, adds it to this round\'s fix items, and the next review\'s scope reviewer gives it a verdict; after a green review it is recorded as fixed but added to no fix item, since no review follows. In build mode, optional and accepted only on a slice with carried keys, each line `<carried key> fixed in <sha>` for a commit of the slice; otherwise leave it out'),
  open: z.array(reportItem).describe('Anything unfinished, any stop report (NEEDS SEAM, SLICE TOO BIG, MISSING DEPENDENCY), and any question about a change to a shared helper outside the ticket (code that callers outside the ticket use) that you left out of the commit; empty when nothing is open'),
});
export type ImplementerReport = z.infer<typeof implementerReportSchema>;

function renderBehavior({ test, behavior, red }: z.infer<typeof behaviorSchema>) {
  return `${test} → ${behavior} (seen red: ${red === undefined ? 'no' : `yes — ${red}`})`;
}

function renderReport(report: ImplementerReport, fixMode: boolean, observed: string[]) {
  const section = (title: string, items: string[]) => [`${title}:`, ...(items.length === 0 ? ['- none'] : items.map(item => `- ${item}`))];
  return [
    'Implementer report:',
    ...section('Commits', report.commits),
    ...(report.fixItems === undefined ? [] : section(fixMode ? 'Fix file items' : 'Carried items', report.fixItems)),
    ...section('Checks', report.checks),
    ...(observed.length === 0 ? [] : section('Factory-observed typecheck', observed)),
    ...section('Behaviors', report.behaviors.map(renderBehavior)),
    ...section('Open', report.open),
  ].join('\n');
}

/** The lowercase hex prefix (7 to 40 characters) a commits item starts with, or undefined. */
function commitPrefix(item: string) {
  return /^[0-9a-f]{7,40}/i.exec(item)?.[0].toLowerCase();
}

/** `<id> fixed in <sha>` at the start of a fixItems line: the id plain or in backticks, an optional colon after it. */
const FIXED_LINE = /^(`?)([^\s`]+?):?\1:?\s+fixed in ([0-9a-f]{7,40})\b/i;

/**
 * The entry a fixItems line claims as fixed: the line matches FIXED_LINE, its sha prefix starts one of the slice's own
 * commits, and its id names exactly one entry of `unplaced`. Undefined for any other line.
 */
function recordableFixedClaim(unplaced: Slice['unplaced'], line: string, own: { sha: string }[]) {
  const match = FIXED_LINE.exec(line);
  const prefix = match?.[3]?.toLowerCase();
  if (match === null || prefix === undefined || !own.some(commit => commit.sha.startsWith(prefix))) return undefined;
  const found = findUnplaced({ unplaced }, match[2] ?? '');
  const entry = found.length === 1 ? found[0] : undefined;
  return entry === undefined ? undefined : { entry, sha: match[3] };
}

/**
 * Records each observation unplaced on the slice that a fixItems line names with `fixed in <sha>` (a commit of the slice) as
 * placed `fixed`, and adds it as a fix item of the current round so the next review's scope reviewer gives it a verdict.
 * After a green review (slice phase 'ready') it is recorded as fixed but added to no fix item, since no review follows.
 * Other lines, unknown or ambiguous ids and other shas change nothing. Returns the ids recorded.
 */
function recordFixedObservations(run: Run, slice: Slice, fixItems: string[], own: { sha: string }[]) {
  const recorded: string[] = [];
  // Ids resolve against the list as the report found it, so an earlier line cannot make a later bare id unambiguous.
  const initial = [...slice.unplaced];
  const placed = new Set<string>();
  for (const line of fixItems) {
    const claim = recordableFixedClaim(initial, line, own);
    if (claim === undefined) continue;
    const { entry } = claim;
    const key = itemKey(entry.review, entry.finding.id);
    if (placed.has(key)) continue;
    placed.add(key);
    placeObservations(run, { id: entry.review }, slice, [entry.finding], 'fixed');
    addEvent(run, 'fixed-by-implementer', `${entry.review}: ${entry.finding.id} fixed in ${claim.sha}`, slice);
    if (slice.fixPath !== undefined && slice.phase !== 'ready') {
      const { item } = findingRecord(entry.finding, '', run.decisions);
      // Two reviews can keep the same id: the later one is listed as `<review>:<id>`, so each gets its own verdict.
      const id = slice.fixItems.some(existing => existing.id === entry.finding.id) ? key : entry.finding.id;
      slice.fixItems.push({ id, path: slice.fixPath, round: slice.fixFiles, summary: item.summary });
    }
    recorded.push(key);
  }
  return recorded;
}

const STOP_REPORT = /NEEDS SEAM|SLICE TOO BIG|MISSING DEPENDENCY/;

/** Counts a test file by the shared TEST_PATH rule, which the review's test-validity path skip also uses. */
async function refuseUntestedSeamedSlice(ws: Workspace, slice: Slice, report: ImplementerReport, fixMode: boolean) {
  if (fixMode || slice.seams.length === 0 || report.open.some(item => STOP_REPORT.test(item))) return;
  const prefix = `Nothing stored. Slice ${slice.id} has test seams (${slice.seams.join('; ')}) but`;
  const advice = slice.noTestReason !== undefined
    ? 'List the test that pins the code (an existing one is fine) in behaviors with seenRed false, or report NEEDS SEAM in Open.'
    : 'Commit a red-first test through one of these seams and report it in behaviors, or report NEEDS SEAM in Open.';
  if (report.behaviors.length === 0) throw new Error(`${prefix} the report lists no behavior. ${advice}`);
  if (slice.noTestReason !== undefined) return;
  const changed = await changedPaths(ws.root, `${slice.parentBranch}...refs/heads/${slice.branch}`);
  if (!changed.some(file => TEST_PATH.test(file))) {
    throw new Error(`${prefix} its commits past ${slice.parentBranch} change no test file. ${advice}`);
  }
  if (!report.behaviors.some(entry => entry.seenRed)) {
    throw new Error(
      `${prefix} no behavior was seen red. To see a test red honestly: revert the production change for that test, run the test, watch it fail, restore the change, then report the failing run as seenRed true with a one-line red.`,
    );
  }
}

/**
 * Stores the implementer's report for the active slice in the run dir; a later call replaces it. The stored report gets a
 * factory-written `Factory-observed typecheck:` section after Checks (one line per typecheck command of the run's checks,
 * from the runs the factory saw in this implementer session, see ./typecheck.ts); no section when no check is a typecheck
 * command. A missing run never refuses the report. The result's `observed` holds the section lines and the commands with no run.
 */
export async function submitImplementerReport(ws: Workspace, run: Run, report: ImplementerReport) {
  const slice = requireActive(run);
  const fixMode = slice.fixFromSha !== undefined;
  if (fixMode && (report.fixItems === undefined || report.fixItems.length === 0)) {
    throw new Error(
      `Slice ${slice.id} is in fix mode: list every fix file item in fixItems, each with \`fixed in <sha>\`, \`already fixed\`, or \`not a defect: <why>\`.`,
    );
  }
  const own = await ownCommits(ws, slice);
  if (!fixMode && report.fixItems !== undefined) {
    const keys = slice.carried.flatMap(section => carriedKeys(section) ?? []);
    if (keys.length === 0) throw new Error(`Slice ${slice.id} is not in fix mode: leave fixItems out of the report.`);
    const bad = report.fixItems.filter(line => {
      const match = FIXED_LINE.exec(line);
      if (match === null || !keys.includes(match[2]!)) return true;
      const sha = match[3]!.toLowerCase();
      return !own.some(commit => commit.sha.startsWith(sha));
    });
    if (bad.length > 0) {
      throw new Error(
        `Nothing stored. In build mode fixItems takes only \`<carried key> fixed in <sha>\` lines, with a key the slice carries and the sha of a commit on slice ${slice.id} past ${slice.parentBranch}. These lines do not:\n${bad.join('\n')}\nThe slice's carried keys:\n${keys.join('\n')}`,
      );
    }
  }

  const rejected = report.commits.filter(item => {
    const prefix = commitPrefix(item);
    return prefix === undefined || !own.some(commit => commit.sha.startsWith(prefix));
  });
  if (rejected.length > 0) {
    throw new Error(
      `Nothing stored. These commits items do not start with the sha of a commit on slice ${slice.id} past ${slice.parentBranch}:\n${rejected.join('\n')}\nThe slice's commits:\n${own.map(commit => commit.oneline).join('\n') || '(none)'}\nList each as \`<short sha> <subject>\`.`,
    );
  }
  await refuseUntestedSeamedSlice(ws, slice, report, fixMode);
  const path = reportPath(ws, run.feature, slice);
  const replaced = existsSync(path);
  const observed = observedTypecheck(run.checks, slice.typecheckRuns);
  writeAtomic(path, `${renderReport(report, fixMode, observed.lines)}\n`);
  // An open review's data file already lists the fix items its scope reviewer must judge; adding more would leave it unable to give them.
  const reviewOpen = reviewIsOpen(slice);
  const fixed = fixMode && report.fixItems !== undefined && !reviewOpen ? recordFixedObservations(run, slice, report.fixItems, own) : [];
  const skippedForOpenReview = fixMode && reviewOpen && report.fixItems?.some(line => recordableFixedClaim(slice.unplaced, line, own) !== undefined) === true;

  return { fixed, observed, path, replaced, skippedForOpenReview, afterGreen: slice.phase === 'ready' };
}

/** The slice's latest stored implementer report, or a line saying none was submitted; both name the report file. */
export function storedReport(ws: Workspace, run: Run, slice: Slice) {
  const path = reportPath(ws, run.feature, slice);
  if (!existsSync(path)) return `No implementer report was submitted for slice ${slice.id} (factory_implementer_report). Once it is, read it at ${path}`;
  return `${readFileSync(path, 'utf8').trimEnd()}\nReport file: ${path}`;
}

/** The items under `<title>:` in the slice's stored report (lines starting '- ', up to the first other line, '- none' dropped); undefined when no report is stored. */
function reportSection(ws: Workspace, run: Run, slice: Slice, title: string) {
  const path = reportPath(ws, run.feature, slice);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.indexOf(`${title}:`);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    if (line !== '- none') items.push(line.slice(2));
  }
  return items;
}

/** The Behaviors lines of the slice's stored implementer report (one `<test> → <behavior> (seen red: ...)` line each), or undefined when no report is stored. */
export function storedBehaviors(ws: Workspace, run: Run, slice: Slice) {
  return reportSection(ws, run, slice, 'Behaviors');
}

/** Whether the stored report's Commits section lists `sha`: an item starting with a hex prefix of it, at least 7 characters. */
export function reportListsCommit(ws: Workspace, run: Run, slice: Slice, sha: string) {
  return (reportSection(ws, run, slice, 'Commits') ?? []).some(item => {
    const prefix = commitPrefix(item);
    return prefix !== undefined && sha.startsWith(prefix);
  });
}

/** Whether the stored report has at least one Commits item and every Commits item starts with a hex prefix (at least 7 characters) of one of `shas`. */
export function reportNamesOnly(ws: Workspace, run: Run, slice: Slice, shas: string[]) {
  const items = reportSection(ws, run, slice, 'Commits') ?? [];
  return items.length > 0 && items.every(item => {
    const prefix = commitPrefix(item);
    return prefix !== undefined && shas.some(sha => sha.startsWith(prefix));
  });
}

/** Whether the stored report lists every sha in `shas` (at least one) in Commits and names no stop report in Open. */
export function reportCoversCommits(ws: Workspace, run: Run, slice: Slice, shas: string[]) {
  const stopped = (reportSection(ws, run, slice, 'Open') ?? []).some(item => STOP_REPORT.test(item));
  return shas.length > 0 && !stopped && shas.every(sha => reportListsCommit(ws, run, slice, sha));
}

/**
 * Moves a slice at `implement`, or in `fix` with `fixFromSha` set, to `checks` and records a resume event when its
 * branch has commits (all own commits at `implement`; the own commits of `fixFromSha..HEAD` in `fix`) that the stored
 * report lists in full with no stop report in Open. Commits from before a fix round need not be listed.
 */
export async function moveReportedToChecks(ws: Workspace, run: Run, slice: Slice) {
  const fix = slice.phase === 'fix' && slice.fixFromSha !== undefined;
  if ((slice.phase !== 'implement' && !fix) || !(await sliceBranchExists(ws, slice))) return;
  const roundShas = fix ? new Set((await git(ws.root, 'rev-list', `${slice.fixFromSha}..refs/heads/${slice.branch}`)).split('\n').filter(Boolean)) : undefined;
  const commits = (await ownCommits(ws, slice)).filter(commit => roundShas?.has(commit.sha) ?? true);
  if (!reportCoversCommits(ws, run, slice, commits.map(commit => commit.sha))) return;
  slice.phase = 'checks';
  addEvent(run, 'resume', `slice ${slice.id} ${fix ? 'fix round ' : ''}already committed and reported ${commits.map(commit => commit.sha.slice(0, 7)).join(', ')}: moved to checks`, slice);
}

/**
 * A report belongs to one implementer session: a newly spawned implementer (a fix round, or a respawn after a stop
 * report) starts without the stored report of the one before, and without the typecheck runs the factory saw before. A follow-up turn of the same session keeps it.
 */
export function startImplementerSession(ws: Workspace, run: Run) {
  const slice = activeSlice(run);
  if (slice === undefined) return;
  clearReport(ws, run.feature, slice);
  slice.typecheckRuns = undefined;
}

/** Removes the stored implementer report of a slice, so no later checks reply shows it. */
export function clearReport(ws: Workspace, feature: string, slice: Pick<Slice, 'id'>) {
  rmSync(reportPath(ws, feature, slice), { force: true });
}

/**
 * Rewrites the shas of the slice's stored report after a rebase: each Commits item's leading hex prefix and each Fix file
 * items line's `fixed in <sha>` that names an old commit becomes the prefix of its paired new commit, of the same length;
 * every other byte stays. Removes the report and returns false when a Commits item names no old commit. True when the
 * report was rewritten or none is stored.
 */
export function remapReportShas(ws: Workspace, run: Run, slice: Slice, pairs: { old: string; new: string }[]) {
  const path = reportPath(ws, run.feature, slice);
  if (!existsSync(path)) return true;
  const swap = (hex: string) => {
    const old = hex.toLowerCase();
    const pair = pairs.find(candidate => candidate.old.startsWith(old));
    return pair?.new.slice(0, hex.length);
  };
  let section = '';
  let failed = false;
  const lines = readFileSync(path, 'utf8').split('\n').map(line => {
    if (!line.startsWith('- ')) {
      section = line;
      return line;
    }
    if (section === 'Commits:' && line !== '- none') {
      const hex = commitPrefix(line.slice(2));
      const next = hex === undefined ? undefined : swap(hex);
      if (hex === undefined || next === undefined) {
        failed = true;
        return line;
      }
      return `- ${next}${line.slice(2 + hex.length)}`;
    }
    if (section === 'Fix file items:' || section === 'Carried items:') return line.replace(/(\bfixed in )([0-9a-f]{7,40})\b/i, (all, lead: string, hex: string) => `${lead}${swap(hex) ?? hex}`);
    return line;
  });
  if (failed) {
    clearReport(ws, run.feature, slice);
    return false;
  }
  writeAtomic(path, lines.join('\n'));
  return true;
}
