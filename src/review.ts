/**
 * The review lifecycle of the active slice: checks, the multi-domain review and its validation, the green review, and
 * completing the slice.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { evidence, evidenceLine, redact } from './evidence.ts';
import { deferItems, draftOf, isRecordSlice, itemKey } from './deferred.ts';
import { CARRIED_HERE, findingLocation, renderKnownObservations } from './ledger.ts';
import { git, runShell, type CommandResult } from './exec.ts';
import {
  activeSlice,
  addEvent,
  builtBy,
  clearFullGreen,
  clearGreen,
  discardReview,
  dropPass,
  greenCommit,
  outdatedGreenCount,
  isAutonomous,
  OBSERVATION_CATEGORIES,
  type Decision,
  type Domain,
  type Finding,
  findingListSchema,
  type FixItem,
  type FixVerdict,
  fixVerdictSchema,
  Invalidated,
  REQUIRED_REVIEW_DOMAINS,
  REVIEW_DOMAINS,
  reviewDir,
  reviewDomains,
  reviewPaths,
  type Run,
  SEVERITIES,
  skippedDomainsSchema,
  type Slice,
  requireActive,
  standingChecks,
  type Workspace,
  writeAtomic,
} from './run.ts';
import { renderFinding } from './finding-text.ts';
import { fixObservations } from './observations.ts';
import { collectObservations, placeDefaults } from './place.ts';
import { changedLines, changedPaths, targetedReview } from './targeted.ts';
import { reportListsCommit, storedBehaviors, storedReport } from './report.ts';
import { head, porcelain, requireOnBranchClean, snapshot } from './repo.ts';
import {
  needsFullReview,
  type FixRecord,
  pauseRun,
  renderTicket,
  requestFix,
  restartSlice,
  settle,
  UNTRUSTED_NOTE,
  writeTicket,
} from './workflow.ts';

/** One decision for factory_decide: its text, or its text and the id of the pending or active slice that builds it. */
export const decisionInputSchema = z.union([
  z.string().min(1),
  z.object({
    slice: z.string().regex(/^\d{2}$/).describe('Id of the pending or active slice that builds this decision, for example "03"'),
    text: z.string().min(1),
  }),
]);

/**
 * The decisions as text, each with the slice that builds it, if it names one. Throws for an empty list and for a slice
 * that is unknown or done. Does not change the run.
 */
export function planDecisions(run: Run, decisions: unknown) {
  return z.array(decisionInputSchema).min(1).parse(decisions).map(decision => {
    if (typeof decision === 'string') return { owner: undefined, text: decision };
    const owner = run.slices.find(slice => slice.id === decision.slice);
    if (owner === undefined) throw new Error(`No slice ${decision.slice}. Slices: ${run.slices.map(slice => slice.id).join(', ') || 'none'}.`);
    if (owner.status === 'done') throw new Error(`Slice ${owner.id} is done; a decision names a pending or active slice to build it.`);
    return { owner, text: decision.text };
  });
}

/**
 * Records decisions for the run (accepted tradeoffs, out-of-scope work) so every later ticket and review
 * data file carries them. A user's decision has author `user`; a headless run records its own as `autonomous`.
 * Reviewers check the code against them: they report code that breaks a decision, and do not re-raise a tradeoff
 * the user accepted. An autonomous decision is checked, not a waiver. A decision that names a slice belongs to it: slices before it
 * mark the decision as built later. An open review of the active slice froze the older decisions,
 * so it is discarded and `discarded` names it; a green review did not see them either, so the slice goes back to
 * review on its green commit. Either way the slice keeps its checks.
 */
export function recordDecisions(ws: Workspace, run: Run, decisions: unknown) {
  const added = planDecisions(run, decisions);
  for (const { owner, text } of added) {
    run.decisions.push({ author: run.mode === 'headless' ? 'autonomous' : 'user', text });
    owner?.ownsDecisions.push(run.decisions.length);
  }
  for (const slice of run.slices.filter(candidate => candidate.status !== 'done')) writeTicket(ws, run, slice);
  addEvent(run, 'decision', added.map(({ owner, text }) => (owner === undefined ? text : `${text} (${builtBy(owner)})`)).join('; '));
  const active = activeSlice(run);
  if (active === undefined) return { decisions: run.decisions, discarded: undefined };
  const discarded = discardReview(run, active, 'decisions recorded during review');
  if (outdatedGreenCount(run, active) !== undefined) reopenReview(run, active);
  return { decisions: run.decisions, discarded };
}

/** Sends a green slice back to review on its green commit for `reason` (default: decisions newer than the review; startReview also uses it for a full review after a targeted green); its checks, which passed on that commit, stand. */
function reopenReview(run: Run, slice: Slice, reason = 'decisions recorded after the green review') {
  slice.phase = 'review';
  clearGreen(slice);
  addEvent(run, 'review-invalidated', reason, slice);
}

/** The shell's own diagnostic for a command it cannot find (bash and dash wording). */
const COMMAND_NOT_FOUND = /^[\w./-]*sh(?:: line \d+)?: (?:\d+: )?(\S+): (?:command )?not found$/m;

function describeCheck(command: string, result: CommandResult) {
  if (result.timedOut) return `${command}: timed out`;
  return `${command}: ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`} in ${result.durationMs}ms`;
}

/**
 * Commits on the slice branch past its parent that a branch or remote outside this run also holds: work pulled in
 * from elsewhere (a merge, rebase, or fast-forward onto another stack) instead of written for this slice.
 */
async function foreignCommits(ws: Workspace, run: Run, slice: Slice, own: string[]) {
  const runBranches = `${ws.config.branchPrefix}/${run.feature}/*`;
  const unique = new Set(
    (
      await git(ws.root, 'rev-list', 'HEAD', '--not', slice.parentBranch, `--exclude=${runBranches}`, '--branches', `--exclude=*/${runBranches}`, '--remotes')
    )
      .split('\n')
      .filter(Boolean),
  );
  return own.filter(sha => !unique.has(sha));
}

/** The slice's commits past its parent, newest first: each full sha with its `--oneline` line (short sha and subject). */
async function ownCommits(ws: Workspace, slice: Slice) {
  const log = await git(ws.root, 'log', '--no-show-signature', '--no-color', '--format=%H %h %s', `${slice.parentBranch}..HEAD`);
  return log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha = '', ...oneline] = line.split(' ');
      return { oneline: oneline.join(' '), sha };
    });
}

export async function runChecks(ws: Workspace, run: Run, signal?: AbortSignal) {
  const slice = requireActive(run);
  const sha = await requireOnBranchClean(ws.root, slice, 'Checks run on committed work only');
  // Read before the refusals, so a stop report submitted before any commit still reaches the orchestrator.
  const report = storedReport(ws, run, slice);
  const own = await ownCommits(ws, slice);
  const foreign = await foreignCommits(ws, run, slice, own.map(commit => commit.sha));
  if (foreign.length > 0) {
    const listed = await git(ws.root, 'log', '--oneline', '--no-walk', ...foreign.slice(0, 20));
    throw new Error(
      `Slice ${slice.id} holds ${foreign.length} commits from other branches, so its review would include work outside the slice:\n${listed.trim()}\nReset the branch to its own commits on ${slice.parentBranch}. If the slice needs that work, ask the user: a run that builds on another branch starts with factory_start baseRef set to it.\n${report}`,
    );
  }
  const commits = own.map(commit => commit.oneline).join('\n');
  if (own.length === 0) throw new Error(`Slice ${slice.id} has no commits past ${slice.parentBranch}. The implementer must commit the slice work first.\n${report}`);
  // A fix round's commits (past the fix file's commit) must all be in the stored report, so the orchestrator reads a report that matches the work.
  if (slice.phase === 'fix' && slice.fixFromSha !== undefined) {
    const roundShas = new Set((await git(ws.root, 'rev-list', `${slice.fixFromSha}..HEAD`)).split('\n').filter(Boolean));
    const unlisted = own.filter(commit => roundShas.has(commit.sha) && !reportListsCommit(ws, run, slice, commit.sha));
    if (unlisted.length > 0) {
      throw new Error(
        `Slice ${slice.id} has ${unlisted.length} commits from this fix round that its implementer report does not list:\n${unlisted.map(commit => commit.oneline).join('\n')}\nMessage the implementer (agent://<id>) to resubmit its report with factory_implementer_report, listing every commit, then call factory_checks again. This is not a fix round.\n${report}`,
      );
    }
  }
  // `sha` is HEAD from the guard above; the log and rev-list reads in between do not move it.
  // A fix round that ends on the commit its fix file described: the implementer changed nothing.
  const unchanged = slice.phase === 'fix' && slice.fixFromSha === sha;
  // Checks that still stand on this commit are not run again. A new commit no longer matches the checked commit, and
  // a fix round (factory_reopen included) or restartSlice (a restack, or a reopen that sends the active slice back to
  // pending) clears it, so every check runs; a review reopened for newer decisions (reopenReview) or a resume on the
  // same commit keeps its checks.
  const stored = standingChecks(slice, sha);
  if (stored !== undefined) return { commits, report, unchanged, ...(await passChecks(ws, run, slice, sha, stored, true)) };
  const results: { command: string; first?: CommandResult; result: CommandResult }[] = [];
  const checkPath = [...ws.config.checkPath, process.env.PATH ?? ''].join(delimiter);
  const env = { ...process.env, PATH: checkPath };
  for (const command of run.checks) {
    signal?.throwIfAborted();
    results.push({ command, result: await runShell(command, ws.root, ws.config.checkTimeoutMs, signal, env) });
  }
  signal?.throwIfAborted();
  // A shell that cannot find a command exits 127 and prints `sh: <cmd>: command not found` (dash: `sh: 1: <cmd>: not
  // found`). A wrapper such as a package manager can print the shell's line and exit with another code. Either way a
  // command is missing from the environment (PATH, or an uninstalled dependency), which a code fix cannot change.
  const missing = results.filter(({ result }) => !result.timedOut && (result.exitCode === 127 || COMMAND_NOT_FOUND.test(result.stderr)));
  if (missing.length > 0) {
    const listed = missing.map(({ command, result }) => `- ${command}:\n${evidence(result.stderr, 500)}`).join('\n');
    const first = missing[0];
    const tool = first?.result.stderr.match(COMMAND_NOT_FOUND)?.[1] ?? first?.command.split(/\s+/)[0] ?? '<tool>';
    const wrapped = missing.some(({ result }) => result.exitCode !== 127);
    const dependency = wrapped
      ? ` When the missing command is a project dependency (a binary that package scripts call), install the dependencies instead (for example \`pnpm install\`); if the dependency is not declared, ask the user.`
      : '';
    throw new Error(
      `Checks could not find a command:\n${listed}\nPATH used: ${checkPath}\nThis is an environment error, not a code fault. When the command is a tool installed on the user's machine, add the directory that holds it (find it with \`command -v ${tool}\` in the user's terminal) to "checkPath" in .omp/factory.json.${dependency} Then call factory_checks again.`,
    );
  }
  // Each failed check (not a timeout: a rerun could cost another full timeout) runs once more, as a whole command.
  for (const entry of results) {
    if (entry.result.exitCode === 0 || entry.result.timedOut) continue;
    signal?.throwIfAborted();
    entry.first = entry.result;
    entry.result = await runShell(entry.command, ws.root, ws.config.checkTimeoutMs, signal, env);
  }
  signal?.throwIfAborted();
  const dirty = (await porcelain(ws.root)).trim();
  const failed = results.filter(({ result }) => result.exitCode !== 0 || result.timedOut);
  const describe = ({ command, first, result }: { command: string; first?: CommandResult; result: CommandResult }) => {
    if (first === undefined) return describeCheck(command, result);
    if (result.exitCode === 0 && !result.timedOut) return `${command}: passed on rerun, flaky (first failed (exit ${first.exitCode}) in ${first.durationMs}ms)`;
    return `${describeCheck(command, result)} on rerun (first failed (exit ${first.exitCode}) in ${first.durationMs}ms)`;
  };
  const summary = results.map(describe);
  if (failed.length === 0 && dirty === '') return { commits, report, unchanged, ...(await passChecks(ws, run, slice, sha, summary, false)) };

  const records: FixRecord[] = failed.map(entry => {
    const { result } = entry;
    const described = describe(entry);
    const section = `## ${described}\n\n### stdout\n\n\`\`\`\n${evidence(result.stdout)}\n\`\`\`\n\n### stderr\n\n\`\`\`\n${evidence(result.stderr)}\n\`\`\``;
    return { item: { kind: 'check', summary: described }, section };
  });
  if (dirty !== '') {
    records.push({
      item: { kind: 'tree', summary: 'Checks changed the working tree' },
      section: `## Checks changed the working tree\n\nCommit or revert these files:\n\n\`\`\`\n${evidence(dirty, 2_000)}\n\`\`\``,
    });
  }
  addEvent(
    run,
    'checks-fail',
    [...failed.map(({ command }) => command), ...(dirty === '' ? [] : ['working tree changed'])].join('; '),
    slice,
  );
  return { commits, passed: false as const, report, summary, unchanged, ...requestFix(ws, run, slice, sha, records) };
}

/** Moves the slice to review with check `results` passed on `sha`. `reused` marks stored results that stand, when no check ran. */
async function passChecks(ws: Workspace, run: Run, slice: Slice, sha: string, results: string[], reused: boolean) {
  dropPass(slice, 'review');
  slice.checked = { results, sha };
  addEvent(run, 'checks-pass', `${reused ? `reused from ${sha}: ` : ''}${results.join('; ')}`, slice);
  // The orchestrator picks the review domains from these changed files and the path skips startReview applies.
  const range = `${slice.parentBranch}...HEAD`;
  const changed = (await git(ws.root, 'diff', '--stat', range)).trimEnd();
  const pathSkipped = await pathSkips(await changedPaths(ws.root, range), committedContent(ws.root, range, sha));
  return { changed, passed: true as const, pathSkipped, reused, sha, summary: results };
}

/**
 * Domains a diff gives nothing to review, decided from its changed paths (and, for `contentMatches`, the changed
 * file's content at the reviewed commit). Each rule only fires when no changed file could hold that domain's subject.
 */
const PATH_SKIPS: { contentMatches?: { content: RegExp; paths: RegExp }; domain: Domain; matches: RegExp; reason: string }[] = [
  {
    // react-ts also reviews TypeScript; plain JavaScript needs it only when the file uses React.
    contentMatches: {
      content: /(\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)['"]react(?:-dom)?(?:\/[^'"]*)?['"]/,
      paths: /\.[cm]?js$/,
    },
    domain: 'react-ts',
    matches: /\.([cm]?ts|[jt]sx)$/,
    reason: 'no TypeScript, JSX, or React file changed',
  },
  {
    domain: 'test-validity',
    matches: /(^|\/)(__tests__|tests?|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/,
    reason: 'no test file changed',
  },
  {
    domain: 'devops',
    matches:
      /(^|\/)(\.github|\.gitlab|\.circleci|\.buildkite|helm|k8s|kubernetes|terraform|deploy|infra)\/|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|Jenkinsfile|Makefile|Procfile|\.gitlab-ci\.yml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.npmrc|\.nvmrc|\.node-version|tsconfig[^/]*\.json|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|requirements[^/]*\.txt|Gemfile(\.lock)?)$|(^|\/)[^/]*\.(tf|tfvars)$|(^|\/)(vite|vitest|webpack|rollup|esbuild|jest|babel|turbo|nx)\.config\.[^/]+$|(^|\/)(turbo|nx)\.json$/,
    reason: 'no CI, build, dependency, or deploy file changed',
  },
];

/** `contentOf` returns a changed file's content at the reviewed commit, or undefined for a deleted file. */
export async function pathSkips(files: string[], contentOf: (file: string) => Promise<string | undefined>) {
  const skips: { domain: Domain; reason: string }[] = [];
  for (const { contentMatches, domain, matches, reason } of PATH_SKIPS) {
    if (files.some(file => matches.test(file))) continue;
    if (contentMatches !== undefined) {
      const candidates = files.filter(file => contentMatches.paths.test(file));
      const contents = await Promise.all(candidates.map(contentOf));
      if (contents.some(content => content !== undefined && contentMatches.content.test(content))) continue;
    }
    skips.push({ domain, reason: `${reason} (factory path rule)` });
  }
  return skips;
}

/** Reads a changed file at `sha`; a file the range deletes has no content. */
function committedContent(root: string, range: string, sha: string) {
  let present: Promise<Set<string>> | undefined;
  return async (file: string) => {
    present ??= changedPaths(root, range, '--diff-filter=d').then(files => new Set(files));
    return (await present).has(file) ? git(root, 'cat-file', 'blob', `${sha}:${file}`) : undefined;
  };
}

/**
 * Opens a review of the slice diff. Domains the changed paths rule out are skipped by the factory unless `keep`
 * names them; `skip` leaves out further domains the diff gives nothing to review, each with a reason. The required
 * domains always run.
 */
export async function startReview(ws: Workspace, run: Run, skip: unknown = [], keep: unknown = []) {
  const slice = requireActive(run);
  // factory_decide reopens a green review that newer decisions outdate; only a state file written before it did is
  // still ready here.
  const outdated = outdatedGreenCount(run, slice) !== undefined;
  // A targeted green review allows a full review of the same commit; its checks stand.
  const fullAfterTargeted = !outdated && slice.phase === 'ready' && slice.green?.targeted === true;
  if (!outdated && !fullAfterTargeted && (slice.phase !== 'review' || slice.checked === undefined)) throw new Error('Checks must pass first: call factory_checks.');
  const guarded = await requireOnBranchClean(ws.root, slice, 'Review needs committed work');
  if (outdated) reopenReview(run, slice);
  else if (fullAfterTargeted) reopenReview(run, slice, 'full review after the targeted green review');
  const targeting = fullAfterTargeted ? undefined : slice.targeting;
  const checked = slice.checked;
  if (checked === undefined || guarded !== checked.sha) {
    dropPass(slice, 'checks');
    throw new Invalidated('HEAD moved after checks passed. Call factory_checks again.');
  }
  // The orchestrator's skip and keep lists apply only to a full review: the factory picks the domains of a targeted one.
  const chosen = targeting === undefined ? skippedDomainsSchema.parse(skip) : [];
  const kept = targeting === undefined ? z.array(z.enum(REVIEW_DOMAINS)).parse(keep) : [];
  const skippedNames = chosen.map(entry => entry.domain);
  const record = isRecordSlice(slice);
  // A Record slice's light review is exactly bug, scope and comments: its seams (a resliced child may carry some) do not bring testing back, and none of the three can be skipped.
  const required: Domain[] = record ? [...REQUIRED_REVIEW_DOMAINS, 'comments'] : [...REQUIRED_REVIEW_DOMAINS, ...(slice.seams.length > 0 ? (['testing'] as const) : [])];
  const refused = skippedNames.filter(domain => required.includes(domain));
  if (refused.length > 0) throw new Error(`These domains always review this slice: ${refused.join(', ')}.`);
  if (new Set(skippedNames).size !== skippedNames.length) throw new Error('A skipped domain appears twice.');
  const both = kept.filter(domain => skippedNames.includes(domain));
  if (both.length > 0) throw new Error(`A domain cannot be both skipped and kept: ${both.join(', ')}.`);
  const range = `${slice.parentBranch}...HEAD`;
  const diff = await git(ws.root, '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', range);
  if (diff.trim() === '') throw new Error(`No changes in ${range}; the implementer committed nothing.`);
  const files = await changedPaths(ws.root, range);
  const fixItems = slice.fixItems.map(
    item => `- \`${item.id}\` (${item.path}, round ${item.round}): ${item.summary}`,
  );
  const listed =
    fixItems.length === 0
      ? 'None.'
      : `The fix rounds since the last recorded review asked the implementer to fix these items, and the implementer has since committed. The scope reviewer gives each item a verdict in fixItems of factory_review_submit: fixed, not-a-defect, waived, or open. Check each item against the diff and the code, not the implementer's claims: not-a-defect needs evidence from the diff or code, waived needs a recorded decision, and an item left open blocks the slice and carries into the next round. Every other domain checks whether the code still has each problem in its domain, and reports one that remains as a finding under the same id.\n\n${UNTRUSTED_NOTE}\n\n${fixItems.join('\n')}`;
  // Light review: a targeted review runs only the blocking domains plus the required ones; a Record deferred items slice runs exactly bug, scope and comments.
  const light =
    targeting !== undefined
      ? REVIEW_DOMAINS.filter(domain => !required.includes(domain) && !targeting.domains.includes(domain)).map(domain => ({ domain, reason: `Targeted review: ${domain} did not block review ${targeting.from}` }))
      : record
        ? REVIEW_DOMAINS.filter(domain => !required.includes(domain)).map(domain => ({ domain, reason: 'Record deferred items slice: light review (scope and comments)' }))
        : [];
  const lightNames = light.map(entry => entry.domain);
  const byPath = (targeting !== undefined ? [] : await pathSkips(files, committedContent(ws.root, range, checked.sha))).filter(
    entry => !kept.includes(entry.domain) && !skippedNames.includes(entry.domain) && !lightNames.includes(entry.domain),
  );
  const skipped = [...byPath, ...chosen.filter(entry => !lightNames.includes(entry.domain)), ...light];
  const { section: targetedSection, targeted } = targeting === undefined ? { section: '', targeted: undefined } : await targetedReview(ws, targeting, checked.sha);
  slice.reviews += 1;
  const id = `${slice.id}-r${slice.reviews}`;
  rmSync(reviewDir(ws, run.feature, id), { force: true, recursive: true });
  const dataFile = join(reviewDir(ws, run.feature, id), 'data.md');
  writeAtomic(
    dataFile,
    `## PR METADATA\n\nLocal stacked review, no PR. Branch \`${slice.branch}\` onto \`${slice.parentBranch}\`.\n\n${renderTicket(run, slice, ws.config.sliceTokenBudget)}\n${renderLaterSlices(run, slice)}\n\n## CHECKS\n\nThe factory ran every configured check on \`${checked.sha}\` and all passed. Do not run them again.\n\n${checked.results.map(result => `- ${result}`).join('\n')}\n\n## KNOWN OBSERVATIONS\n\nObservations this run has already placed (carried, deferred, fixed or left), and observations of this slice's earlier reviews that are not placed yet, marked \`(unplaced)\`. A finding that matches an entry by location and problem, under any id, is not new: the validator drops it with the reason \`same as <key>\`. An entry marked \`${CARRIED_HERE}\` is work this slice builds: a finding that it is unbuilt or wrong in this slice is not a repeat. ${UNTRUSTED_NOTE}\n\n${renderKnownObservations(run, slice)}\n\n${targetedSection}## FIX ITEMS\n\n${listed}\n\n${renderBehaviors(ws, run, slice)}\n\n## DIFF\n\n${UNTRUSTED_NOTE}\n\n${diff}\n## CHANGED FILES\n\n${files.join('\n')}\n`,
  );
  const lines = changedLines(diff, files);
  slice.review = { decisions: run.decisions.length, id, lines, sha: checked.sha, skipped, snapshot: await snapshot(ws.root), submissions: {}, targeted };
  const skippedDetail = skipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ');
  addEvent(run, 'review-start', skipped.length === 0 ? id : `${id} skipped ${skippedDetail}`, slice);
  return { ...reviewPaths(ws, run, id), domains: reviewDomains(skipped), pathSkipped: byPath, reviewId: id };
}

/** The IMPLEMENTER BEHAVIORS section: only the Behaviors of the latest stored report, as untrusted claims; its commits, fix items and open items stay out. */
function renderBehaviors(ws: Workspace, run: Run, slice: Slice) {
  const behaviors = storedBehaviors(ws, run, slice);
  const body =
    behaviors === undefined
      ? 'No implementer report was stored for this slice.'
      : `Untrusted implementer claims: the Behaviors of the implementer's latest report, each test, the behavior it claims to prove, and whether the implementer says it saw the test fail first. After a fix round this lists only that round's behaviors. ${UNTRUSTED_NOTE}\n\n${behaviors.length === 0 ? 'None.' : behaviors.map(line => `- ${line}`).join('\n')}`;
  return `## IMPLEMENTER BEHAVIORS\n\n${body}`;
}

/** The slices stacked after `slice` that are not done, so reviewers can tell work the plan gives a later slice from a gap in this one. */
function renderLaterSlices(run: Run, slice: Slice) {
  const later = run.slices.slice(run.slices.indexOf(slice) + 1).filter(item => item.status !== 'done');
  if (later.length === 0) return '## LATER SLICES\n\nNone. No pending slice follows this one.';
  const listed = later.map(
    item => `### ${item.id}: ${item.title}\n\n**What to build:** ${item.whatToBuild}\n\n${item.acceptance.map(line => `- ${line}`).join('\n')}`,
  );
  return `## LATER SLICES\n\nLater slices of the plan build this work. Work a later slice lists is not a finding against this slice; this slice's own acceptance criteria, seams, and decisions still count in full, and code here that contradicts a later slice's plan is still a finding.\n\n${listed.join('\n\n')}`;
}

export type Review = NonNullable<Slice['review']>;

function requireReview(run: Run, reviewId: string) {
  const slice = activeSlice(run);
  const review = slice?.review;
  if (review?.id !== reviewId) throw new Error(`Review ${reviewId} is not the active review.`);
  if (slice?.phase !== 'review') throw new Error(`Review ${reviewId} is already recorded.`);
  return review;
}

const domainFile = (ws: Workspace, run: Run, reviewId: string, domain: string) =>
  join(reviewDir(ws, run.feature, reviewId), 'domains', `${domain}.json`);
export const validationFile = (ws: Workspace, run: Run, reviewId: string) => join(reviewDir(ws, run.feature, reviewId), 'validation.json');
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

/** Reads a review artifact only if it is byte-for-byte what the factory tool wrote. */
export function readRecorded(path: string, recorded: { hash: string } | undefined) {
  if (recorded === undefined) return undefined;
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (sha256(content) !== recorded.hash) throw new Error(`${path} changed after it was submitted. Start a new review.`);
  return JSON.parse(content) as unknown;
}

/** Throws unless the finding names a changed path and, when it gives a line, a new-side line inside one of its hunks. */
function requireInDiff(lines: Record<string, [number, number][]>, finding: Finding) {
  const ranges = lines[finding.path];
  if (ranges === undefined) {
    throw new Error(`Finding "${finding.id}" names ${finding.path}, which the diff does not change. Attach it to the changed file and line that cause the problem.`);
  }
  const { line } = finding;
  if (line === undefined || ranges.some(([start, end]) => line >= start && line <= end)) return;
  const shown = ranges.length === 0 ? 'none (file-level findings only: omit line)' : ranges.map(([start, end]) => `${start}-${end}`).join(', ');
  throw new Error(`Finding "${finding.id}" names line ${line} of ${finding.path}, outside the diff. Its new-side hunk lines: ${shown}.`);
}

/**
 * Stores one domain reviewer's findings as its own file, so parallel reviewers never share a write. Each domain is
 * submitted by one agent, before validation; that agent may replace its submission any number of times until then,
 * so it can always remove a stale finding. The run records the latest file's hash. The scope domain also gives a
 * verdict for every fix item the review lists (see checkFixVerdicts), which the run keeps.
 */
export function submitDomain(
  ws: Workspace,
  run: Run,
  input: { agentId: string; domain: string; findings: unknown; fixItems?: unknown; reviewId: string },
) {
  const review = requireReview(run, input.reviewId);
  const domain = z.enum(REVIEW_DOMAINS).parse(input.domain);
  if (!reviewDomains(review.skipped).includes(domain)) throw new Error(`Review ${review.id} skipped the ${domain} domain.`);
  if (review.validation !== undefined) throw new Error(`Review ${review.id} is already validated; start a new review.`);
  const previous = review.submissions[domain];
  if (previous !== undefined && previous.agentId !== input.agentId) {
    throw new Error(`The ${domain} findings for ${review.id} were submitted by another agent.`);
  }
  const findings = findingListSchema.parse(input.findings);
  const ids = new Set<string>();
  for (const finding of findings) {
    if (finding.domain !== domain) throw new Error(`Finding "${finding.id}" must have domain "${domain}".`);
    if (!finding.id.startsWith(`${domain}-`)) throw new Error(`Finding "${finding.id}" must have an id starting "${domain}-".`);
    if (ids.has(finding.id)) throw new Error(`Duplicate finding id "${finding.id}"`);
    ids.add(finding.id);
    requireInDiff(review.lines, finding);
    if (finding.severity === 'observation' && finding.category === undefined) {
      throw new Error(`Finding "${finding.id}" is an observation without a category. Give it one of: ${OBSERVATION_CATEGORIES.join(', ')}.`);
    }
    if (finding.decision !== undefined) {
      if (finding.severity === 'observation') throw new Error(`Finding "${finding.id}" breaks a recorded decision, so it must be critical or high.`);
      if (finding.decision > review.decisions) {
        throw new Error(`Finding "${finding.id}" names decision ${finding.decision}, but the review data lists ${review.decisions} decisions.`);
      }
    }
  }
  let verdicts: FixVerdict[] | undefined;
  if (domain === 'scope') {
    if (input.fixItems === undefined) throw new Error('The scope domain gives fixItems: a verdict for each FIX ITEMS id, [] when the review data lists none.');
    verdicts = z.array(fixVerdictSchema).parse(input.fixItems);
    checkFixVerdicts(requireActive(run).fixItems, verdicts, review.decisions, run.decisions);
  } else if (input.fixItems !== undefined) {
    throw new Error('Only the scope domain gives fix item verdicts; leave out fixItems.');
  }
  const content = `${JSON.stringify(findings, null, 2)}\n`;
  writeAtomic(domainFile(ws, run, review.id, domain), content);
  review.submissions[domain] = { agentId: input.agentId, hash: sha256(content) };
  if (verdicts !== undefined) review.fixVerdicts = verdicts;
  return findings.length;
}

/**
 * Throws unless `verdicts` give exactly one verdict for each listed fix item, and each waived item names one of the
 * review's `decisionCount` decisions, which must not be autonomous (an autonomous decision is checked, not a waiver). fixVerdictSchema already holds that a waived item, and only a waived item, names one.
 */
function checkFixVerdicts(items: FixItem[], verdicts: FixVerdict[], decisionCount: number, decisions: Decision[]) {
  const listed = new Set(items.map(item => item.id));
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    if (seen.has(verdict.id)) throw new Error(`Fix item "${verdict.id}" has more than one verdict.`);
    seen.add(verdict.id);
  }
  const unknown = [...seen].filter(id => !listed.has(id));
  if (unknown.length > 0) throw new Error(`Unknown fix item ids: ${unknown.join(', ')}. Give verdicts only for the ids the FIX ITEMS section lists.`);
  const missing = [...listed].filter(id => !seen.has(id));
  if (missing.length > 0) throw new Error(`Give a verdict for every fix item. Missing: ${missing.join(', ')}`);
  for (const verdict of verdicts) {
    if (verdict.status === 'waived' && verdict.decision > decisionCount) {
      throw new Error(`Fix item "${verdict.id}" names decision ${verdict.decision}, but the review data lists ${decisionCount} decisions.`);
    }
    if (verdict.status === 'waived' && isAutonomous(decisions, verdict.decision)) {
      throw new Error(`Fix item "${verdict.id}" names decision ${verdict.decision}, which was recorded autonomously. An autonomous decision is not a waiver; mark the item open or fixed.`);
    }
  }
}

export function readDomainFindings(ws: Workspace, run: Run, reviewId: string) {
  return recordedFindings(ws, run, requireReview(run, reviewId));
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
      z.object({
        decision: z.number().int().positive().describe('Number of the recorded decision the code breaks'),
        id: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .default([])
    .describe('observation findings that show the code breaks a recorded user decision; kept as high'),
  keep: z.array(z.string().min(1)).describe('Ids of findings the diff substantiates, one per distinct problem'),
});
type Validation = z.infer<typeof validationSchema>;

/**
 * Kept findings at the severity the gate uses: downgraded findings count as observations (with the category the
 * validator gave one that had none), escalated ones as high and carry the decision the validator cited.
 */
export function keptFindings(findings: Finding[], validation: Validation) {
  const downgraded = new Map(validation.downgrade.map(entry => [entry.id, entry.category]));
  const escalated = new Map(validation.escalate.map(entry => [entry.id, entry.decision]));
  return findings
    .filter(finding => validation.keep.includes(finding.id) || downgraded.has(finding.id) || escalated.has(finding.id))
    .map(finding => {
      if (downgraded.has(finding.id)) return { ...finding, category: finding.category ?? downgraded.get(finding.id), severity: 'observation' as const };
      const decision = escalated.get(finding.id);
      if (decision !== undefined) return { ...finding, decision, severity: 'high' as const };
      return finding;
    });
}

/**
 * Throws unless the validation keeps, downgrades, escalates, or drops every submitted finding exactly once, and nothing
 * else. Only a `critical` or `high` finding can be downgraded, and only to `observation`. Only an `observation` can be
 * escalated, to `high`, and only by naming one of the `decisionCount` recorded decisions. A duplicate may only be
 * dropped in favour of a kept, downgraded, or escalated finding of the same or higher severity (original severity,
 * except that an escalated finding counts as high).
 */
function checkCoverage(findings: Finding[], validation: Validation, decisionCount: number, decisions: Decision[], fixLines?: Record<string, [number, number][]>) {
  const downgraded = validation.downgrade.map(entry => entry.id);
  const escalated = validation.escalate.map(entry => entry.id);
  const retained = [...validation.keep, ...downgraded, ...escalated];
  const decided = [...retained, ...validation.dropped.map(entry => entry.id)];
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const unknown = decided.filter(id => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown finding ids: ${unknown.join(', ')}`);
  if (new Set(decided).size !== decided.length) throw new Error('A finding id appears twice across keep, downgrade, escalate, and dropped.');
  const undecided = [...byId.keys()].filter(id => !decided.includes(id));
  if (undecided.length > 0) throw new Error(`Keep, downgrade, escalate, or drop every finding. Undecided: ${undecided.join(', ')}`);
  if (fixLines !== undefined) {
    // A targeted review keeps observations only on the lines the fix changed; a downgraded finding becomes one.
    const outside = [...validation.keep, ...downgraded].filter(id => {
      const finding = byId.get(id);
      if (finding === undefined || (finding.severity !== 'observation' && !downgraded.includes(id))) return false;
      const { line } = finding;
      const ranges = Object.hasOwn(fixLines, finding.path) ? fixLines[finding.path] : undefined;
      if (line === undefined) return ranges === undefined || ranges.length > 0;
      return !(ranges ?? []).some(([start, end]) => line >= start && line <= end);
    });
    if (outside.length > 0) throw new Error(`Observations outside the fix diff are dropped in a targeted review (blocking findings stay): ${outside.join(', ')}`);
  }
  const uncategorised = validation.downgrade.filter(entry => entry.category === undefined && byId.get(entry.id)?.category === undefined).map(entry => entry.id);
  if (uncategorised.length > 0) {
    throw new Error(`A downgraded finding becomes an observation, which needs a category: set \`category\` on the downgrade entry of ${uncategorised.join(', ')}.`);
  }
  const notBlocking = downgraded.filter(id => byId.get(id)?.severity === 'observation');
  if (notBlocking.length > 0) throw new Error(`Only critical or high findings can be downgraded: ${notBlocking.join(', ')}`);
  const breaksDecision = downgraded.filter(id => byId.get(id)?.decision !== undefined);
  if (breaksDecision.length > 0) {
    throw new Error(`A finding that breaks a recorded decision cannot be downgraded; keep it or drop it: ${breaksDecision.join(', ')}`);
  }
  const usesAutonomous = [...downgraded, ...validation.dropped.map(entry => entry.id)].filter(
    id => byId.get(id)?.severity !== 'observation' && isAutonomous(decisions, byId.get(id)?.decision),
  );
  if (usesAutonomous.length > 0) {
    throw new Error(`A blocking finding that breaks an autonomous decision cannot be dropped or downgraded; keep it: ${usesAutonomous.join(', ')}`);
  }
  const alreadyBlocking = escalated.filter(id => byId.get(id)?.severity !== 'observation');
  if (alreadyBlocking.length > 0) throw new Error(`Only observation findings can be escalated; keep these instead: ${alreadyBlocking.join(', ')}`);
  for (const entry of validation.escalate) {
    if (entry.decision > decisionCount) {
      throw new Error(`"${entry.id}" names decision ${entry.decision}, but the review data lists ${decisionCount} decisions.`);
    }
  }
  const rank = (finding: Finding) => SEVERITIES.indexOf(escalated.includes(finding.id) ? 'high' : finding.severity);
  for (const entry of validation.dropped) {
    if (entry.duplicateOf === undefined) continue;
    const kept = byId.get(entry.duplicateOf);
    if (kept === undefined || !retained.includes(entry.duplicateOf)) {
      throw new Error(`"${entry.id}" is a duplicate of "${entry.duplicateOf}", which is not a kept finding.`);
    }
    const dropped = byId.get(entry.id);
    if (dropped !== undefined && rank(kept) > rank(dropped)) {
      throw new Error(`Keep the most severe of the duplicates: "${entry.id}" is ${dropped.severity}, "${kept.id}" is ${kept.severity}.`);
    }
  }
}

/**
 * The validator only selects: every raw finding is kept, downgraded to an observation, escalated to high for a broken
 * decision, or dropped with a reason. It adds no finding and rewrites no text. The same validator may replace its
 * validation once (to correct its verdict) until the review is recorded.
 */
export function submitValidation(
  ws: Workspace,
  run: Run,
  input: { agentId: string; downgrade?: unknown; dropped: unknown; escalate?: unknown; keep: unknown; reviewId: string },
) {
  const review = requireReview(run, input.reviewId);
  const previous = review.validation;
  if (previous !== undefined && previous.agentId !== input.agentId) throw new Error(`Review ${review.id} was validated by another agent.`);
  if (previous?.amended === true) throw new Error(`The validation for ${review.id} was already corrected once.`);
  const { findings, missing } = readDomainFindings(ws, run, input.reviewId);
  if (missing.length > 0) throw new Error(`Domains not submitted yet: ${missing.join(', ')}`);
  const validation = validationSchema.parse({ downgrade: input.downgrade, dropped: input.dropped, escalate: input.escalate, keep: input.keep });
  checkCoverage(findings, validation, review.decisions, run.decisions, review.targeted?.lines);
  const content = `${JSON.stringify(validation, null, 2)}\n`;
  writeAtomic(validationFile(ws, run, input.reviewId), content);
  review.validation = { agentId: input.agentId, ...(previous === undefined ? {} : { amended: true }), hash: sha256(content) };
  return {
    downgraded: validation.downgrade.length,
    dropped: validation.dropped.length,
    escalated: validation.escalate.length,
    kept: validation.keep.length,
    replaced: previous !== undefined,
  };
}

function countBy(findings: Finding[], key: 'domain' | 'severity') {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding[key]] = (counts[finding[key]] ?? 0) + 1;
  return Object.entries(counts)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
}

/**
 * What `recordReview` decided: `green` (with the observations to place), `accepted-unresolved` (a headless slice with no
 * fix rounds left, counted as green with its open items on record), or `fix` (a fix file written for the blocking
 * findings and open fix items, `stalled` when the round limit is used up).
 */
export type RecordedReview =
  | { final: boolean; kind: 'green'; observations: string[] }
  | { kind: 'accepted-unresolved'; unresolved: string[] }
  | { blocking: number; fixPath: string; kind: 'fix'; open: number; stalled: boolean };

/** The targeting a fix round after `review` leaves for the next review: the domains that need another look. */
export function targetingAfter(review: { id: string; sha: string }, domains: readonly Domain[]) {
  return { base: review.sha, domains: [...new Set(domains)], from: review.id };
}

/** Marks the slice's review green over `decisions`; `unresolved` are the items it is accepted with, if any. */
function markGreen(slice: Slice, decisions: number, { full = false, targeted = false, unresolved }: { full?: boolean; targeted?: boolean; unresolved?: string[] }) {
  slice.phase = 'ready';
  slice.targeting = undefined;
  if (full) slice.fullGreen = true;
  slice.green = { decisions, ...(targeted ? { targeted: true } : {}) };
  slice.unresolved = unresolved;
}

export async function recordReview(ws: Workspace, run: Run): Promise<RecordedReview> {
  const slice = requireActive(run);
  const review = slice.review;
  if (slice.phase !== 'review' || review === undefined) throw new Error('No review in progress: call factory_review_start.');
  const { findings, missing } = readDomainFindings(ws, run, review.id);
  if (missing.length > 0) throw new Error(`Domains not submitted yet: ${missing.join(', ')}. Spawn their reviewers.`);
  const raw = readRecorded(validationFile(ws, run, review.id), review.validation);
  if (raw === undefined) throw new Error('The validator has not submitted. Spawn factory-review-validator.');
  const validation = validationSchema.parse(raw);
  checkCoverage(findings, validation, review.decisions, run.decisions, review.targeted?.lines);
  if ((await snapshot(ws.root)) !== review.snapshot) {
    dropPass(slice, 'checks');
    addEvent(run, 'review-invalidated', `${review.id}: repository changed during review`, slice);
    throw new Invalidated('The repository changed during review. Restore the reviewed state, then call factory_checks.');
  }
  // LEGACY-STATE(decision-before-reset): factory_decide discards an open review, so only a state file written before
  // it did can reach this with newer decisions; remove with the matching branches in completeSlice and nextAction.
  if (run.decisions.length > review.decisions) {
    discardReview(run, slice, 'decisions recorded during review');
    throw new Invalidated(`${newerDecisions(run, review.decisions)} newer than review ${review.id}, so its reviewers did not check the code against them. Call factory_review_start for a new review.`);
  }

  const kept = keptFindings(findings, validation);
  const blocking = kept.filter(finding => finding.severity !== 'observation');
  const observations = kept.filter(finding => finding.severity === 'observation');
  collectObservations(run, slice, review.id, observations);
  const verdicts = review.fixVerdicts ?? [];
  const verdictOf = new Map(verdicts.map(entry => [entry.id, entry]));
  // An item without a closing verdict stays open, so no item passes unchecked; a blocking finding under its id already carries it.
  const open = slice.fixItems.filter(item => !blocking.some(finding => finding.id === item.id) && (verdictOf.get(item.id)?.status ?? 'open') === 'open');
  // critical and high findings and open fix items all block the slice, so the recorded verdict follows the gate.
  const verdict = blocking.length > 0 || open.length > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
  writeAtomic(
    join(reviewDir(ws, run.feature, review.id), 'review.json'),
    `${JSON.stringify({ downgraded: validation.downgrade, dropped: validation.dropped, escalated: validation.escalate, findings: kept, fixItems: verdicts, verdict }, null, 2)}\n`,
  );
  const detail = `${review.id} kept ${kept.length} (${countBy(kept, 'severity')}) downgraded ${validation.downgrade.length} escalated ${validation.escalate.length} dropped ${validation.dropped.length} by-domain ${countBy(kept, 'domain')}`;
  // The recorded review checked every fix item gathered before it; the open ones go into the next fix file.
  const gathered = slice.fixItems;
  slice.fixItems = [];

  if (verdict === 'APPROVED') {
    const full = review.targeted === undefined;
    markGreen(slice, review.decisions, full ? { full } : { targeted: true });
    addEvent(run, 'review-green', `${full ? '' : 'targeted '}${detail}`, slice);
    return { final: !needsFullReview(slice), kind: 'green', observations: observations.map(finding => renderFinding(finding, run.decisions)) };
  }
  clearFullGreen(slice);
  slice.targeting = targetingAfter(review, [...blocking.map(finding => finding.domain), ...(open.length > 0 ? (['scope'] as const) : [])]);
  const blockingIds = [...blocking.map(finding => finding.id), ...open.map(item => `${item.id} (open fix item)`)];
  const blockingDetail = `${detail}; blocking ${blockingIds.join(', ')}`;
  const records: FixRecord[] = [
    ...blocking.map(finding => findingRecord(finding, `## Blocking review findings from ${review.id}`, run.decisions)),
    ...open.map(item => ({ group: `## Open fix items from ${review.id}`, item: { id: item.id, summary: item.summary }, section: renderOpenItem(item, verdictOf.get(item.id)) })),
  ];
  if (run.mode === 'headless' && slice.fixRounds >= slice.roundLimit) {
    // A headless slice has a fixed fix budget and no stall dialog: what is still open goes on record as unresolved, and that stands in for green.
    const itemId = ({ item }: FixRecord) => ('id' in item ? item.id : undefined);
    const unresolved = records.map((record, index) => `${index < blocking.length ? 'blocking finding' : 'open fix item'} ${itemId(record) === undefined ? '' : `${itemId(record)}: `}${record.item.summary}`);
    // The open items go to the deferred sink before the slice counts as accepted. A failed issue keeps the ones already filed, and the retry files the rest.
    // With no sink configured they stay on record in slice.unresolved and the event below.
    // A Record deferred items slice's own findings are not deferred: they would need another Record slice, and so on.
    const failure = await deferItems(
      ws,
      run,
      (isRecordSlice(slice) ? [] : records).map((record, index) => {
        const id = itemId(record);
        return draftOf(run, slice, review.id, { detail: record.section, id, key: itemKey(review.id, id ?? `unresolved:${index + 1}`), kind: 'unresolved', title: record.item.summary });
      }),
    );
    if (failure !== undefined) {
      slice.fixItems = gathered;
      throw new Invalidated(`The deferred sink failed, so review ${review.id} is not accepted unresolved: ${failure.message}. The items already filed stay recorded; call factory_review_record again.`);
    }
    // Added only now that the deferred sink succeeded, so a retry after a failed sink does not log it twice.
    addEvent(run, 'review-blocking', blockingDetail, slice);
    // An accepted-unresolved targeted review still needs a full review before completion.
    markGreen(slice, review.decisions, { targeted: review.targeted !== undefined, unresolved });
    const sunk = ws.config.deferred === undefined ? 'no deferred sink configured' : isRecordSlice(slice) ? 'not deferred: a Record deferred items slice' : `sent to the ${ws.config.deferred.kind} sink`;
    addEvent(run, 'accepted-unresolved', `${review.id} after ${slice.fixRounds} fix rounds (${sunk}); open: ${unresolved.join('; ')}`, slice);
    return { kind: 'accepted-unresolved', unresolved };
  }
  // No deferred sink step on this path, so nothing can fail between the review and this event: it is added once.
  addEvent(run, 'review-blocking', blockingDetail, slice);
  return { blocking: blocking.length, kind: 'fix', open: open.length, ...requestFix(ws, run, slice, review.sha, records) };
}

/** A fix item the scope reviewer left open, with where it was asked for and the reviewer's reason. */
function renderOpenItem(item: FixItem, verdict: FixVerdict | undefined) {
  return `### \`${item.id}\`\n\n- Asked in: ${item.path} (round ${item.round})\n- Item: ${redact(item.summary)}\n- Scope reviewer: ${verdict === undefined ? 'no verdict' : evidence(verdict.reason, 2_000)}`;
}

/** A finding as a fix record in `group`: its id and summary `[severity] path:line: title` as the fix item. */
export function findingRecord(finding: Finding, group: string, decisions: Decision[]): FixRecord {
  const summary = `[${finding.severity}] ${findingLocation(finding)}: ${evidenceLine(finding.title, 500)}`;
  return { group, item: { id: finding.id, summary }, section: renderFinding(finding, decisions, '###') };
}

/**
 * Moves every later slice branch onto the reopened slice's fixed tip, bottom up: each child goes from its parent's old
 * tip onto the parent's new tip, so it keeps only its own commits. Every old tip is snapshotted into a backup ref
 * before the first rebase. A child already on its parent's new tip (rebased by hand) stays as it is. A failed rebase
 * puts every branch back at its old tip, pauses the run, and throws. Each later slice that moved, or was not done,
 * goes back to pending.
 */
async function restack(ws: Workspace, run: Run, reopened: Slice, doneSha: string) {
  const later: { old: string; slice: Slice }[] = [];
  // nextSlice creates each branch from its parent, so the existing branches are the bottom of the later slices.
  for (const slice of run.slices.slice(run.slices.indexOf(reopened) + 1)) {
    const old = (await git(ws.root, 'branch', '--list', '--format=%(objectname)', slice.branch)).trim();
    if (old === '') break;
    later.push({ old, slice });
  }
  const backup = (slice: Slice) => `refs/factory/${run.feature}/backup/${slice.id}`;
  for (const { old, slice } of later) await git(ws.root, 'update-ref', backup(slice), old);
  const moved: { old: string; slice: Slice; tip: string }[] = [];
  let parentOld = doneSha;
  let parentNew = await head(ws.root);
  for (const child of later) {
    const onParent = await git(ws.root, 'merge-base', '--is-ancestor', parentNew, child.old).then(
      () => true,
      () => false,
    );
    if (!onParent) {
      try {
        await git(ws.root, 'rebase', '--onto', parentNew, parentOld, child.slice.branch);
      } catch (error) {
        await git(ws.root, 'rebase', '--abort').catch(() => {});
        // No restacked branch may be checked out while its ref is reset.
        await git(ws.root, 'switch', reopened.branch);
        // Compare-and-swap: reset a branch only while it is still at the tip the restack gave it. A branch that moved,
        // or a reset that failed, keeps every backup ref so the user can recover the old tips.
        const stuck: string[] = [];
        for (const { old, slice, tip } of moved) {
          await git(ws.root, 'update-ref', `refs/heads/${slice.branch}`, old, tip).catch(() => stuck.push(slice.branch));
        }
        const current = (await git(ws.root, 'rev-parse', `refs/heads/${child.slice.branch}`)).trim();
        if (current !== child.old) stuck.push(child.slice.branch);
        if (stuck.length === 0) for (const { slice } of later) await git(ws.root, 'update-ref', '-d', backup(slice));
        const reason = `restacking ${child.slice.branch} onto ${child.slice.parentBranch} failed`;
        if (run.status === 'running') pauseRun(run, reason);
        addEvent(run, 'restack-conflict', stuck.length === 0 ? reason : `${reason}; not reset: ${stuck.join(', ')}`, child.slice);
        const state =
          stuck.length === 0
            ? 'Every later slice branch is back at its old tip'
            : `These branches could not be reset to their old tips: ${stuck.join(', ')}. The old tips are kept in ${later.map(({ slice }) => backup(slice)).join(', ')}`;
        throw new Invalidated(
          `Restacking ${child.slice.branch} onto the fixed ${child.slice.parentBranch} failed:\n${evidence(error instanceof Error ? error.message : String(error), 2_000)}\n${state}, and the run is paused. The user must resolve the conflict: rebase each later slice branch onto the one below it by hand, bottom up (git rebase --onto <parent> <old parent tip> <branch>), then /factory resume ${run.feature}. Completing slice ${reopened.id} again keeps the branches that are already on their parent.`,
        );
      }
      moved.push({ ...child, tip: (await git(ws.root, 'rev-parse', `refs/heads/${child.slice.branch}`)).trim() });
    }
    parentOld = child.old;
    parentNew = (await git(ws.root, 'rev-parse', `refs/heads/${child.slice.branch}`)).trim();
  }
  await git(ws.root, 'switch', reopened.branch);
  for (const { slice } of later) await git(ws.root, 'update-ref', '-d', backup(slice));
  for (const { slice } of later) {
    const tip = (await git(ws.root, 'rev-parse', `refs/heads/${slice.branch}`)).trim();
    if (slice.status !== 'done' || tip !== greenCommit(slice)) await restartSlice(ws, run, slice);
  }
  if (moved.length > 0) addEvent(run, 'restack', `${moved.map(({ slice }) => slice.branch).join(', ')} onto ${reopened.branch}`, reopened);
}

export async function completeSlice(ws: Workspace, run: Run) {
  const slice = requireActive(run);
  const green = greenCommit(slice);
  if (slice.phase !== 'ready' || green === undefined) throw new Error('The slice has no green review yet.');
  if (slice.unresolved !== undefined && run.mode !== 'headless') {
    throw new Error(`Slice ${slice.id} was accepted unresolved by a headless run, and only a headless run completes it. Open: ${slice.unresolved.join('; ')}`);
  }
  if (needsFullReview(slice)) {
    throw new Error(`The last green review of slice ${slice.id} was targeted. Call factory_review_start for a full review of the same commit, then factory_complete_slice.`);
  }
  const sha = await requireOnBranchClean(ws.root, slice, 'Cannot complete the slice');
  if (sha !== green) {
    dropPass(slice, 'checks');
    throw new Invalidated('HEAD moved after the green review. Call factory_checks again.');
  }
  // LEGACY-STATE(decision-before-reset): factory_decide reopens such a slice at once, so only a state file written
  // before it did reaches this; remove with the matching branches in recordReview and nextAction.
  const covered = outdatedGreenCount(run, slice);
  if (covered !== undefined) {
    reopenReview(run, slice);
    throw new Invalidated(`${newerDecisions(run, covered)} newer than the green review, so its reviewers did not check the code against them. Call factory_review_start for a new review.`);
  }
  const { fixes, placed: placedHere } = await placeDefaults(ws, run);
  if (fixes.length > 0) {
    const before = { observations: structuredClone(run.observations), slice: structuredClone(slice) };
    try {
      fixObservations(ws, run, { observations: fixes }, 'Default placement of the observations after the slice\'s final review.');
    } catch (error) {
      if (!placedHere || error instanceof Invalidated) throw error;
      // Keep what the defaults already placed (an issue may be filed), undo the partly started fix round so a retry starts it.
      run.observations = before.observations;
      Object.assign(slice, before.slice);
      throw new Invalidated(`Starting the fix round of slice ${slice.id} failed after its default observations were placed: ${error instanceof Error ? error.message : String(error)}. Call factory_complete_slice again.`);
    }
    return slice;
  }
  if (slice.unplaced.length > 0) {
    throw new Error(`Slice ${slice.id} has unplaced observations: ${slice.unplaced.map(entry => entry.finding.id).join(', ')}. Place them with factory_place (placements [] takes every default), then call factory_complete_slice. A headless run places them by default in factory_complete_slice.`);
  }
  try {
    if (slice.doneSha !== undefined) {
      await restack(ws, run, slice, slice.doneSha);
      slice.doneSha = undefined;
    }
    slice.status = 'done';
    writeTicket(ws, run, slice);
    if (slice.peakContextTokens > ws.config.sliceTokenBudget || slice.compactions > 0) {
      addEvent(run, 'budget-exceeded', `peak ${slice.peakContextTokens} tokens, ${slice.compactions} compactions`, slice);
    }
    addEvent(run, 'slice-done', `${slice.fixRounds} fix rounds, ${slice.reviews} reviews`, slice);
    settle(ws, run);
  } catch (error) {
    // Only observations the headless defaults placed in this call are saved instead of rolled back. Otherwise the state rolls back.
    if (!placedHere || error instanceof Invalidated) throw error;
    slice.status = 'active';
    throw new Invalidated(`Completing slice ${slice.id} failed after its default observations were placed: ${error instanceof Error ? error.message : String(error)}. Call factory_complete_slice again.`);
  }
  return slice;
}

function newerDecisions(run: Run, covered: number) {
  const first = covered + 1;
  const last = run.decisions.length;
  return first === last ? `Decision ${first} is` : `Decisions ${first}–${last} are`;
}
