/**
 * The review lifecycle of the active slice: checks, the multi-domain review and its validation, the green review, and
 * completing the slice.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { evidence } from './evidence.ts';
import { git, runShell, type CommandResult } from './exec.ts';
import {
  activeSlice,
  addEvent,
  discardReview,
  dropPass,
  greenCommit,
  outdatedGreenCount,
  type Domain,
  type Finding,
  findingListSchema,
  Invalidated,
  REQUIRED_REVIEW_DOMAINS,
  REVIEW_DOMAINS,
  reviewDir,
  type Run,
  SEVERITIES,
  skippedDomainsSchema,
  type Slice,
  standingChecks,
  type Workspace,
  writeAtomic,
} from './run.ts';
import { head, porcelain, requireClean, requireOnBranch, snapshot } from './repo.ts';
import {
  pauseRun,
  renderTicket,
  requestFix,
  requireActive,
  restartSlice,
  settle,
  UNTRUSTED_NOTE,
  writeTicket,
} from './workflow.ts';

export const REVIEW_REFERENCE_DIR = fileURLToPath(new URL('../skills/software-factory/references/review/', import.meta.url));

/**
 * Records decisions the user confirmed (accepted tradeoffs, out-of-scope work) so every later ticket and review
 * data file carries them. Reviewers check the code against them: they report code that breaks a decision, and do
 * not re-raise a tradeoff the user already accepted. An open review of the active slice froze the older decisions,
 * so it is discarded and `discarded` names it; a green review did not see them either, so the slice goes back to
 * review on its green commit. Either way the slice keeps its checks.
 */
export function recordDecisions(ws: Workspace, run: Run, decisions: string[]) {
  const added = z.array(z.string().min(1)).min(1).parse(decisions);
  run.decisions.push(...added);
  for (const slice of run.slices.filter(candidate => candidate.status !== 'done')) writeTicket(ws, run, slice);
  addEvent(run, 'decision', added.join('; '));
  const active = activeSlice(run);
  if (active === undefined) return { decisions: run.decisions, discarded: undefined };
  const discarded = discardReview(run, active, 'decisions recorded during review');
  if (outdatedGreenCount(run, active) !== undefined) reopenReview(run, active);
  return { decisions: run.decisions, discarded };
}

/** Sends a green slice back to review on its green commit, for decisions newer than the review; its checks, which passed on that commit, stand. */
function reopenReview(run: Run, slice: Slice) {
  slice.phase = 'review';
  slice.green = undefined;
  slice.review = undefined;
  addEvent(run, 'review-invalidated', 'decisions recorded after the green review', slice);
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
async function foreignCommits(ws: Workspace, run: Run, slice: Slice) {
  const runBranches = `${ws.config.branchPrefix}/${run.feature}/*`;
  const own = await git(ws.root, 'rev-list', 'HEAD', '--not', slice.parentBranch);
  const unique = new Set(
    (
      await git(ws.root, 'rev-list', 'HEAD', '--not', slice.parentBranch, `--exclude=${runBranches}`, '--branches', `--exclude=*/${runBranches}`, '--remotes')
    )
      .split('\n')
      .filter(Boolean),
  );
  return own.split('\n').filter(sha => sha !== '' && !unique.has(sha));
}

export async function runChecks(ws: Workspace, run: Run, signal?: AbortSignal) {
  const slice = requireActive(run);
  await requireOnBranch(ws.root, slice);
  await requireClean(ws.root, 'Checks run on committed work only');
  const foreign = await foreignCommits(ws, run, slice);
  if (foreign.length > 0) {
    const listed = await git(ws.root, 'log', '--oneline', '--no-walk', ...foreign.slice(0, 20));
    throw new Error(
      `Slice ${slice.id} holds ${foreign.length} commits from other branches, so its review would include work outside the slice:\n${listed.trim()}\nReset the branch to its own commits on ${slice.parentBranch}. If the slice needs that work, ask the user: a run that builds on another branch starts with factory_start baseRef set to it.`,
    );
  }
  const commits = (await git(ws.root, 'log', '--oneline', `${slice.parentBranch}..HEAD`)).trim();
  if (commits === '') throw new Error(`Slice ${slice.id} has no commits past ${slice.parentBranch}. The implementer must commit the slice work first.`);
  const sha = await head(ws.root);
  // A fix round that ends on the commit its fix file described: the implementer changed nothing.
  const unchanged = slice.phase === 'fix' && slice.fixFromSha === sha;
  // Checks that still stand on this commit are not run again. A new commit no longer matches the checked commit, and
  // a fix round (factory_reopen included) or restartSlice (a restack, or a reopen that sends the active slice back to
  // pending) clears it, so every check runs; a review reopened for newer decisions (reopenReview) or a resume on the
  // same commit keeps its checks.
  const stored = standingChecks(slice, sha);
  if (stored !== undefined) return { commits, unchanged, ...(await passChecks(ws, run, slice, sha, stored, true)) };
  const results: { command: string; result: CommandResult }[] = [];
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
  const dirty = (await porcelain(ws.root)).trim();
  const failed = results.filter(({ result }) => result.exitCode !== 0 || result.timedOut);
  const summary = results.map(({ command, result }) => describeCheck(command, result));
  if (failed.length === 0 && dirty === '') return { commits, unchanged, ...(await passChecks(ws, run, slice, sha, summary, false)) };

  const sections = failed.map(
    ({ command, result }) =>
      `## ${describeCheck(command, result)}\n\n### stdout\n\n\`\`\`\n${evidence(result.stdout)}\n\`\`\`\n\n### stderr\n\n\`\`\`\n${evidence(result.stderr)}\n\`\`\``,
  );
  if (dirty !== '') sections.push(`## Checks changed the working tree\n\nCommit or revert these files:\n\n\`\`\`\n${evidence(dirty, 2_000)}\n\`\`\``);
  addEvent(
    run,
    'checks-fail',
    [...failed.map(({ command }) => command), ...(dirty === '' ? [] : ['working tree changed'])].join('; '),
    slice,
  );
  return { commits, passed: false as const, summary, unchanged, ...requestFix(ws, run, slice, sections.join('\n\n'), sha) };
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

async function changedPaths(root: string, range: string, ...filter: string[]) {
  return (await git(root, 'diff', '--name-only', '-z', ...filter, range)).split('\0').filter(Boolean);
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
  if (!outdated && (slice.phase !== 'review' || slice.checked === undefined)) throw new Error('Checks must pass first: call factory_checks.');
  await requireOnBranch(ws.root, slice);
  await requireClean(ws.root, 'Review needs committed work');
  if (outdated) reopenReview(run, slice);
  const checked = slice.checked;
  if (checked === undefined || (await head(ws.root)) !== checked.sha) {
    dropPass(slice, 'checks');
    throw new Invalidated('HEAD moved after checks passed. Call factory_checks again.');
  }
  const chosen = skippedDomainsSchema.parse(skip);
  const kept = z.array(z.enum(REVIEW_DOMAINS)).parse(keep);
  const skippedNames = chosen.map(entry => entry.domain);
  const required: Domain[] = [...REQUIRED_REVIEW_DOMAINS, ...(slice.seams.length > 0 ? (['testing'] as const) : [])];
  const refused = skippedNames.filter(domain => required.includes(domain));
  if (refused.length > 0) throw new Error(`These domains always review this slice: ${refused.join(', ')}.`);
  if (new Set(skippedNames).size !== skippedNames.length) throw new Error('A skipped domain appears twice.');
  const both = kept.filter(domain => skippedNames.includes(domain));
  if (both.length > 0) throw new Error(`A domain cannot be both skipped and kept: ${both.join(', ')}.`);
  const range = `${slice.parentBranch}...HEAD`;
  const diff = await git(ws.root, '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', range);
  if (diff.trim() === '') throw new Error(`No changes in ${range}; the implementer committed nothing.`);
  const files = await changedPaths(ws.root, range);
  const previous = previousBlocking(ws, run, slice);
  const byPath = (await pathSkips(files, committedContent(ws.root, range, checked.sha))).filter(
    entry => !kept.includes(entry.domain) && !skippedNames.includes(entry.domain),
  );
  const skipped = [...byPath, ...chosen];
  slice.reviews += 1;
  const id = `${slice.id}-r${slice.reviews}`;
  rmSync(reviewDir(ws, run.feature, id), { force: true, recursive: true });
  const dataFile = join(reviewDir(ws, run.feature, id), 'data.md');
  writeAtomic(
    dataFile,
    `## PR METADATA\n\nLocal stacked review, no PR. Branch \`${slice.branch}\` onto \`${slice.parentBranch}\`.\n\n${renderTicket(run, slice, ws.config.sliceTokenBudget)}\n## CHECKS\n\nThe factory ran every configured check on \`${checked.sha}\` and all passed. Do not run them again.\n\n${checked.results.map(result => `- ${result}`).join('\n')}\n\n${previous}## DIFF\n\n${UNTRUSTED_NOTE}\n\n${diff}\n## CHANGED FILES\n\n${files.join('\n')}\n`,
  );
  const lines = changedLines(diff, files);
  slice.review = { decisions: run.decisions.length, id, lines, sha: checked.sha, skipped, snapshot: await snapshot(ws.root), submissions: {} };
  const skippedDetail = skipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ');
  addEvent(run, 'review-start', skipped.length === 0 ? id : `${id} skipped ${skippedDetail}`, slice);
  return {
    dataFile,
    domains: reviewDomains(skipped),
    findingsDir: join(reviewDir(ws, run.feature, id), 'domains'),
    pathSkipped: byPath,
    referenceDir: REVIEW_REFERENCE_DIR,
    reviewId: id,
  };
}

/**
 * The blocking findings of the slice's last recorded review, as a data file section, so this round's reviewers check
 * whether each problem remains and report it under the same id. Walks back past reviews discarded before they were
 * recorded (no review.json). Empty for a first review.
 */
function previousBlocking(ws: Workspace, run: Run, slice: Slice) {
  const recorded = (n: number) => join(reviewDir(ws, run.feature, `${slice.id}-r${n}`), 'review.json');
  let n = slice.reviews;
  while (n > 0 && !existsSync(recorded(n))) n--;
  if (n === 0) return '';
  const id = `${slice.id}-r${n}`;
  const path = recorded(n);
  const { findings } = z.object({ findings: findingListSchema }).parse(JSON.parse(readFileSync(path, 'utf8')));
  const blocking = findings.filter(finding => finding.severity !== 'observation');
  if (blocking.length === 0) return '';
  const items = blocking.map(
    finding => `- \`${finding.id}\` [${finding.severity}] ${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}: ${evidence(finding.title, 500)}`,
  );
  return `## PREVIOUS REVIEW\n\nReview ${id} sent these blocking findings to the implementer, who has since committed a fix. Check whether the code still has each problem in your domain. Report a problem that remains under the same id; leave out one the fix resolved.\n\n${items.join('\n')}\n\n`;
}

/**
 * Each changed path with the new-side line ranges of its hunks, context lines included. A path with no hunks (a
 * binary, mode-only, or deleted file) maps to no ranges, so a finding on it can only be file-level.
 */
export function changedLines(diff: string, files: string[]) {
  const lines: Record<string, [number, number][]> = Object.fromEntries(files.map(file => [file, []]));
  let ranges: [number, number][] | undefined;
  let header = false;
  for (const line of diff.split('\n')) {
    // Content lines start with ' ', '+', '-', or '\', so these prefixes only match headers.
    if (line.startsWith('diff --git ')) {
      header = true;
      ranges = undefined;
    } else if (header && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '');
      const path = (name.startsWith('"') ? (JSON.parse(name) as string) : name).replace(/^b\//, '');
      ranges = name === '/dev/null' ? undefined : (lines[path] ??= []);
    } else if (line.startsWith('@@ ')) {
      header = false;
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const start = Number(match?.[1]);
      const count = match?.[2] === undefined ? 1 : Number(match[2]);
      if (ranges !== undefined && count > 0) ranges.push([start, start + count - 1]);
    }
  }
  return lines;
}

/** The domains a review waits for: every domain it did not skip. */
function reviewDomains(skipped: { domain: Domain }[]) {
  return REVIEW_DOMAINS.filter(domain => !skipped.some(entry => entry.domain === domain));
}

type Review = NonNullable<Slice['review']>;

function requireReview(run: Run, reviewId: string) {
  const slice = activeSlice(run);
  const review = slice?.review;
  if (review?.id !== reviewId) throw new Error(`Review ${reviewId} is not the active review.`);
  if (slice?.phase !== 'review') throw new Error(`Review ${reviewId} is already recorded.`);
  return review;
}

const domainFile = (ws: Workspace, run: Run, reviewId: string, domain: string) =>
  join(reviewDir(ws, run.feature, reviewId), 'domains', `${domain}.json`);
const validationFile = (ws: Workspace, run: Run, reviewId: string) => join(reviewDir(ws, run.feature, reviewId), 'validation.json');
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

/** Reads a review artifact only if it is byte-for-byte what the factory tool wrote. */
function readRecorded(path: string, recorded: { hash: string } | undefined) {
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
 * submitted by one agent, before validation; that agent may replace its submission once (for a late advisor note).
 * The run records the file's hash.
 */
export function submitDomain(ws: Workspace, run: Run, input: { agentId: string; domain: string; findings: unknown; reviewId: string }) {
  const review = requireReview(run, input.reviewId);
  const domain = z.enum(REVIEW_DOMAINS).parse(input.domain);
  if (!reviewDomains(review.skipped).includes(domain)) throw new Error(`Review ${review.id} skipped the ${domain} domain.`);
  if (review.validation !== undefined) throw new Error(`Review ${review.id} is already validated; start a new review.`);
  const previous = review.submissions[domain];
  if (previous !== undefined && previous.agentId !== input.agentId) {
    throw new Error(`The ${domain} findings for ${review.id} were submitted by another agent.`);
  }
  if (previous?.amended === true) throw new Error(`The ${domain} findings for ${review.id} were already amended once.`);
  const findings = findingListSchema.parse(input.findings);
  const ids = new Set<string>();
  for (const finding of findings) {
    if (finding.domain !== domain) throw new Error(`Finding "${finding.id}" must have domain "${domain}".`);
    if (!finding.id.startsWith(`${domain}-`)) throw new Error(`Finding "${finding.id}" must have an id starting "${domain}-".`);
    if (ids.has(finding.id)) throw new Error(`Duplicate finding id "${finding.id}"`);
    ids.add(finding.id);
    requireInDiff(review.lines, finding);
    if (finding.decision !== undefined) {
      if (finding.severity === 'observation') throw new Error(`Finding "${finding.id}" breaks a recorded decision, so it must be critical or high.`);
      if (finding.decision > review.decisions) {
        throw new Error(`Finding "${finding.id}" names decision ${finding.decision}, but the review data lists ${review.decisions} decisions.`);
      }
    }
  }
  const content = `${JSON.stringify(findings, null, 2)}\n`;
  writeAtomic(domainFile(ws, run, review.id, domain), content);
  review.submissions[domain] = { agentId: input.agentId, ...(previous === undefined ? {} : { amended: true }), hash: sha256(content) };
  return findings.length;
}

export function readDomainFindings(ws: Workspace, run: Run, reviewId: string) {
  return recordedFindings(ws, run, requireReview(run, reviewId));
}

/** Every reviewed domain's submitted findings, read only where the file is what the factory tool wrote. */
function recordedFindings(ws: Workspace, run: Run, review: Review) {
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
    .array(z.object({ id: z.string().min(1), reason: z.string().min(1) }))
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
 * Kept findings at the severity the gate uses: downgraded findings count as observations, escalated ones as high and
 * carry the decision the validator cited.
 */
function keptFindings(findings: Finding[], validation: Validation) {
  const downgraded = new Set(validation.downgrade.map(entry => entry.id));
  const escalated = new Map(validation.escalate.map(entry => [entry.id, entry.decision]));
  return findings
    .filter(finding => validation.keep.includes(finding.id) || downgraded.has(finding.id) || escalated.has(finding.id))
    .map(finding => {
      if (downgraded.has(finding.id)) return { ...finding, severity: 'observation' as const };
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
function checkCoverage(findings: Finding[], validation: Validation, decisionCount: number) {
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
  const notBlocking = downgraded.filter(id => byId.get(id)?.severity === 'observation');
  if (notBlocking.length > 0) throw new Error(`Only critical or high findings can be downgraded: ${notBlocking.join(', ')}`);
  const breaksDecision = downgraded.filter(id => byId.get(id)?.decision !== undefined);
  if (breaksDecision.length > 0) {
    throw new Error(`A finding that breaks a recorded decision cannot be downgraded; keep it or drop it: ${breaksDecision.join(', ')}`);
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
  checkCoverage(findings, validation, review.decisions);
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

function renderFinding(finding: Finding, decisions: string[]) {
  const decision = finding.decision === undefined ? '' : `\n- Breaks decision ${finding.decision}: ${decisions[finding.decision - 1] ?? ''}`;
  return `## [${finding.severity}] ${finding.id}\n\n- Location: ${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}\n- Title: ${evidence(finding.title, 500)}\n- Problem: ${evidence(finding.problem, 2_000)}\n- Fix: ${evidence(finding.fix, 2_000)}\n- Fix prompt: ${evidence(finding.fix_prompt, 2_000)}${decision}`;
}

export async function recordReview(ws: Workspace, run: Run) {
  const slice = requireActive(run);
  const review = slice.review;
  if (slice.phase !== 'review' || review === undefined) throw new Error('No review in progress: call factory_review_start.');
  const { findings, missing } = readDomainFindings(ws, run, review.id);
  if (missing.length > 0) throw new Error(`Domains not submitted yet: ${missing.join(', ')}. Spawn their reviewers.`);
  const raw = readRecorded(validationFile(ws, run, review.id), review.validation);
  if (raw === undefined) throw new Error('The validator has not submitted. Spawn factory-review-validator.');
  const validation = validationSchema.parse(raw);
  checkCoverage(findings, validation, review.decisions);
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
  // critical and high both block the slice, so the recorded verdict follows the gate.
  const verdict = blocking.length > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
  writeAtomic(
    join(reviewDir(ws, run.feature, review.id), 'review.json'),
    `${JSON.stringify({ downgraded: validation.downgrade, dropped: validation.dropped, escalated: validation.escalate, findings: kept, verdict }, null, 2)}\n`,
  );
  const detail = `${review.id} kept ${kept.length} (${countBy(kept, 'severity')}) downgraded ${validation.downgrade.length} escalated ${validation.escalate.length} dropped ${validation.dropped.length} by-domain ${countBy(kept, 'domain')}`;

  if (blocking.length === 0) {
    slice.phase = 'ready';
    slice.green = { decisions: review.decisions };
    addEvent(run, 'review-green', detail, slice);
    return { green: true as const, observations: observations.map(finding => renderFinding(finding, run.decisions)) };
  }
  addEvent(run, 'review-blocking', `${detail}; blocking ${blocking.map(finding => finding.id).join(', ')}`, slice);
  return {
    blocking: blocking.length,
    green: false as const,
    ...requestFix(ws, run, slice, `Blocking review findings from ${review.id}:\n\n${blocking.map(finding => renderFinding(finding, run.decisions)).join('\n\n')}`, review.sha),
  };
}

/** What the user chose to fix in the active slice after its green review: observation ids, a free-text bug, or both. */
export type FixRequest = { bug?: string | undefined; observations?: string[] | undefined };

/**
 * The active slice's green review, the observations the user chose from it by finding id, and the bug the user found.
 * Throws for a request with neither, for a slice without a green review, and for an id that is not one of its
 * observations. Does not change the run.
 */
export function planFix(ws: Workspace, run: Run, request: FixRequest) {
  const bug = request.bug?.trim() ? request.bug : undefined;
  const chosen = new Set(z.array(z.string().min(1)).parse(request.observations ?? []));
  if (bug === undefined && chosen.size === 0) throw new Error('factory_fix needs a bug, observation ids, or both.');
  const slice = requireActive(run);
  const review = slice.review;
  if (slice.phase !== 'ready' || greenCommit(slice) === undefined || review === undefined) {
    throw new Error(`Slice ${slice.id} has no green review to fix observations or a bug from.`);
  }
  const raw = readRecorded(validationFile(ws, run, review.id), review.validation);
  if (raw === undefined) throw new Error(`Review ${review.id} has no validation.`);
  const { findings } = recordedFindings(ws, run, review);
  const observations = keptFindings(findings, validationSchema.parse(raw)).filter(finding => finding.severity === 'observation');
  const unknown = [...chosen].filter(id => !observations.some(finding => finding.id === id));
  if (unknown.length > 0) {
    const listed = observations.map(finding => finding.id).join(', ') || 'none';
    throw new Error(`Not observations of green review ${review.id}: ${unknown.join(', ')}. Its observations: ${listed}.`);
  }
  return { bug, observations: observations.filter(finding => chosen.has(finding.id)), review, slice };
}

/**
 * Sends the active slice from its green review back to the fix loop for the bug the user found and the observations
 * the user chose to fix in this slice. The round counts against the round limit; the slice earns checks and a new
 * review before it completes.
 */
export function fixObservations(ws: Workspace, run: Run, request: FixRequest, reason: string) {
  const { bug, observations, review, slice } = planFix(ws, run, request);
  const ids = observations.map(finding => finding.id);
  addEvent(run, 'fix-observations', `${review.id}: ${[...(bug === undefined ? [] : ['bug']), ...ids].join(', ')}`, slice);
  const why = evidence(reason, 4_000);
  const sections = [
    ...(bug === undefined ? [] : [`## Bug found after green review ${review.id}\n\n${why}\n\n${evidence(bug, 4_000)}`]),
    ...(ids.length === 0
      ? []
      : [`## Observations from green review ${review.id} the user chose to fix\n\n${why}\n\n${observations.map(finding => renderFinding(finding, run.decisions)).join('\n\n')}`]),
  ];
  return requestFix(ws, run, slice, sections.join('\n\n'), review.sha);
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
  await requireOnBranch(ws.root, slice);
  await requireClean(ws.root, 'Cannot complete the slice');
  if ((await head(ws.root)) !== green) {
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
  settle(run);
  return slice;
}

function newerDecisions(run: Run, covered: number) {
  const first = covered + 1;
  const last = run.decisions.length;
  return first === last ? `Decision ${first} is` : `Decisions ${first}–${last} are`;
}
