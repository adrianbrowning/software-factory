/*
 * The gh / gh-stack CLI contract submit relies on (observed against the real CLI):
 * - `gh stack checkout <branch>` for a branch in no stack exits 2 with stderr `no local or remote stack found for "<branch>"`;
 *   a 401 exits 4 with `failed to list stacks: HTTP 401`.
 * - `gh stack view --json` prints {trunk, currentBranch, branches: [{name, head, base, isCurrent, isMerged, isQueued,
 *   needsRebase, pr?: {number, url, state}}]}: branches bottom first, trunk not in branches, `pr` left out for a branch
 *   with no PR.
 * - `gh api` fills `{owner}/{repo}` in the endpoint from the current repo.
 * - `gh pr edit` fails with a Projects (classic) deprecation error, so PR titles and bodies go through `gh api -X PATCH`.
 */
import { z } from 'zod';
import { redact } from './evidence.ts';
import { gh, git } from './exec.ts';
import { head, requireClean } from './repo.ts';
import { addEvent, greenCommit, type Run, type Slice, type Workspace } from './run.ts';
import { RELATED_MAX } from './source.ts';

/** The part of `gh stack view --json` submit reads: the stack's branches, bottom (closest to trunk) first, with each branch's PR when it has one. */
const stackView = z.object({ branches: z.array(z.object({ name: z.string(), pr: z.object({ number: z.number(), url: z.string().optional() }).optional() })) });

export type SubmitPlan =
  | { kind: 'init' }
  | { kind: 'refuse'; outside: string[]; unordered: string[]; base?: string }
  | { kind: 'refuse-base'; reason: string }
  | { kind: 'add'; missing: string[]; onto?: string };

/**
 * The base branch of a run started with `--base`. Without `stack` the base stack was not read (slice 01 is already
 * stacked, a re-submit). With `stack`, slice 01 is in no stack and the base stack was read: null means the base branch is in no gh stack.
 */
export type SubmitBase = { branch: string } | { branch: string; stack: string[] | null };

/**
 * Decides what submit does with the gh stack that holds slice 01: `stacked` is that stack's branches (bottom first), or
 * undefined when slice 01 is in no stack. A stack must hold a prefix of the run's `branches`, in run order; submit then
 * adds the branches it lacks (possibly none).
 * A run with a `base` branch never adopts a new stack: when slice 01 is in no stack, the base must be the top of its
 * own stack and the run's branches are added on top of it. When slice 01 is stacked, the branches below it must hold no
 * run branch and end with the base branch.
 */
export function planSubmit(stacked: string[] | undefined, branches: string[], base?: SubmitBase): SubmitPlan {
  if (stacked === undefined) {
    if (base === undefined) return { kind: 'init' };
    if (!('stack' in base)) throw new Error(`Cannot plan the submit: slice 01 is in no stack but the stack of the base branch ${base.branch} was not read`);
    if (base.stack === null) return { kind: 'refuse-base', reason: `the base branch ${base.branch} is in no gh stack, so the run cannot be stacked on it` };
    if (base.stack.at(-1) !== base.branch) {
      return { kind: 'refuse-base', reason: `the base branch ${base.branch} is not the top of its gh stack (${base.stack.join(', ')}); the run can only be stacked on the top branch` };
    }
    return { kind: 'add', missing: branches, onto: base.branch };
  }
  if (base === undefined) return checkRunStack(stacked, branches) ?? { kind: 'add', missing: branches.slice(stacked.length) };
  // With a base branch the run's part starts at slice 01; an absent slice 01 is never treated as index 0.
  const from = stacked.indexOf(branches[0] ?? '');
  if (from < 0) return { kind: 'refuse', outside: stacked.filter(name => !branches.includes(name)), unordered: stacked.filter(name => branches.includes(name)), base: base.branch };
  const below = stacked.slice(0, from);
  const own = stacked.slice(from);
  const rest = checkRunStack(own, branches);
  const belowRun = below.filter(name => branches.includes(name));
  const baseBelow = below.at(-1) !== base.branch ? base.branch : undefined;
  if (rest !== undefined || belowRun.length > 0 || baseBelow !== undefined) {
    return {
      kind: 'refuse',
      outside: rest?.outside ?? [],
      unordered: [...belowRun, ...(rest?.unordered ?? [])],
      ...(baseBelow === undefined ? {} : { base: baseBelow }),
    };
  }
  return { kind: 'add', missing: branches.slice(own.length) };
}

/** Refuses a stack holding a non-run branch or run branches out of run order; undefined when the stack is a prefix of the run. */
function checkRunStack(stacked: string[], branches: string[]): { kind: 'refuse'; outside: string[]; unordered: string[] } | undefined {
  const outside = stacked.filter(name => !branches.includes(name));
  const unordered = stacked.filter((name, index) => branches.includes(name) && branches[index] !== name);
  return outside.length > 0 || unordered.length > 0 ? { kind: 'refuse', outside, unordered } : undefined;
}

/**
 * Checks out `branch` with gh stack and returns its stack's branches, or undefined when it is in no stack. Only
 * gh-stack's "no stack" checkout failure means that; any other failure, and a failed or malformed view, propagates.
 */
async function readStack(root: string, branch: string) {
  try {
    await gh(root, 'stack', 'checkout', branch);
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('no local or remote stack found for')) return undefined;
    throw error;
  }
  return (await viewStack(root)).map(item => item.name);
}

/** Runs `gh stack view --json` and parses it: the one place the stack view is read. */
async function viewStack(root: string) {
  return stackView.parse(JSON.parse(await gh(root, 'stack', 'view', '--json'))).branches;
}

/**
 * What a submit did. `failure` is set when the stack and its PRs reached GitHub (the `submit` event is on the run) but a
 * step after the push failed: writing the PR titles and bodies, or the switch back of a stopped stack.
 */
export type Submission = { output: string; failure?: Error };

/**
 * Submits the reviewed stack. On a first submit it adopts every slice branch into one gh-stack stack and opens draft
 * PRs; on a re-submit, when slice 01 is already stacked, it adds only the slice branches that stack lacks.
 * A run with `baseBranch` (started with `--base`) adopts nothing: its first submit adds the slice branches with
 * `gh stack add` on top of the gh stack whose top is the base branch, and it refuses a base branch that is in no stack
 * or not the top of its stack. Its re-submit accepts the stack whose branches below slice 01 end with the base branch.
 * Only the run's own PRs get titles and bodies; the PRs of the branches below are left as they are.
 * A run with `landOn` instead fast-forwards that local branch to the top slice; no PRs are opened. Never merges.
 * The user-invoked `/factory submit` command calls this, and so does a headless run's own submission (`submitHeadless`);
 * with `stop`, a paused headless run submits only the done slices below the stopped one. `progress` names each step
 * before it starts, so the user sees what the submit is waiting on. Fails before the push by throwing; a failure after
 * it comes back in the result, so the caller saves the `submit` event with the run.
 */
export async function submitStack(ws: Workspace, run: Run, progress: (step: string) => void = () => {}, stop?: Stop): Promise<Submission> {
  if (stop === undefined ? run.status !== 'done' : run.status !== 'paused') throw new Error(`Run "${run.feature}" is ${run.status}; its stack is not ready.`);
  // A stopped stack submits only the done slices below the stopped one.
  const slices = stop === undefined ? run.slices : doneBelow(run, stop.slice);
  const branches = slices.map(slice => slice.branch);
  const [bottom] = branches;
  if (bottom === undefined) throw new Error(`Run "${run.feature}" has no slices to submit.`);
  if (stop !== undefined && run.landOn !== undefined) throw new Error(`Run "${run.feature}" lands on ${run.landOn}: a stopped stack opens no PRs.`);
  progress('checking the working tree and the slice branches');
  await requireClean(ws.root, 'Cannot submit the stack');
  const unreviewed: string[] = [];
  for (const slice of slices) {
    const tip = (await git(ws.root, 'rev-parse', `refs/heads/${slice.branch}`)).trim();
    if (tip !== greenCommit(slice)) unreviewed.push(slice.branch);
  }
  if (unreviewed.length > 0) {
    throw new Error(
      `These branches moved after their green review and were not submitted: ${unreviewed.join(', ')}. To keep the new commits, ask the orchestrator to re-gate them: factory_reopen on that slice gives them checks and a full review. Otherwise reset each branch to its reviewed commit.`,
    );
  }
  if (run.landOn !== undefined) {
    progress(`fast-forwarding ${run.landOn} to the top slice`);
    return { output: await landStack(ws, run, run.landOn) };
  }
  progress(`reading the gh stack that holds ${bottom}`);
  // `gh stack checkout` and the gh stack steps after it move HEAD. A refusal or any failure before `gh stack submit`
  // finishes switches back to where submit started, so a refused submit changes nothing. After it, a PR title failure
  // and a successful submit stay where gh stack leaves it, except a submit for a stopped run (`stop`), which switches
  // back on every exit.
  const start = await git(ws.root, 'symbolic-ref', '-q', '--short', 'HEAD').then(
    name => [name.trim()],
    async () => ['--detach', await head(ws.root)],
  );
  let output: string;
  const added: string[] = [];
  let path = '';
  try {
    const stacked = await readStack(ws.root, bottom);
    let base: SubmitBase | undefined;
    if (run.baseBranch !== undefined) {
      base = { branch: run.baseBranch };
      if (stacked === undefined) base = { branch: run.baseBranch, stack: (await readStack(ws.root, run.baseBranch)) ?? null };
    }
    const plan = planSubmit(stacked, branches, base);
    if (plan.kind === 'init') {
      progress(`adopting ${branches.length} branches into a gh stack onto ${run.trunk}`);
      await gh(ws.root, 'stack', 'init', '--base', run.trunk, ...branches);
      path = `adopted ${branches.length} branches onto ${run.trunk} and submitted`;
    } else if (plan.kind === 'refuse-base') {
      throw new Error(`Cannot stack run "${run.feature}" on its base branch: ${plan.reason}. Nothing was submitted; fix the stack with gh stack, then submit again.`);
    } else if (plan.kind === 'refuse') {
      const problems = [
        plan.base === undefined ? '' : `the branches below ${bottom} do not end with the base branch ${plan.base}`,
        plan.outside.length > 0 ? `branches outside the run: ${plan.outside.join(', ')}` : '',
        plan.unordered.length > 0 ? `run branches out of run order: ${plan.unordered.join(', ')}` : '',
      ].filter(Boolean);
      throw new Error(`The gh stack holding ${bottom} has ${problems.join('; ')}. Nothing was submitted; fix the stack with gh stack, then submit again.`);
    } else {
      const { missing, onto } = plan;
      const target = onto === undefined ? 'to the existing gh stack' : `onto the gh stack whose top is ${onto}`;
      progress(missing.length === 0
        ? `the gh stack already holds all ${branches.length} slice branches`
        : `adding ${missing.length} ${missing.length === 1 ? 'branch' : 'branches'} ${target}: ${missing.join(', ')}`);
      // `gh stack checkout` left the bottom slice (or, onto a base branch, the base branch) checked out; move to the top so a submit always ends on the top slice, even when no branch is added.
      await gh(ws.root, 'stack', 'top');
      for (const branch of missing) {
        await gh(ws.root, 'stack', 'add', branch);
        added.push(branch);
      }
      path = missing.length === 0
        ? 're-submitted the existing gh stack'
        : `added ${missing.join(', ')} ${target} and submitted`;
    }
    progress(`pushing ${slices.length} branches and opening or updating draft PRs (gh stack submit; this can take a few minutes)`);
    output = await gh(ws.root, 'stack', 'submit', '--auto');
  } catch (caught) {
    const error = added.length === 0
      ? caught
      : new Error(
          `${caught instanceof Error ? caught.message : String(caught)}\nAlready added to the gh stack: ${added.join(', ')}; run /factory submit again to add the rest and submit.`,
          { cause: caught },
        );
    const switchFailure = await switchBack(ws.root, start);
    if (switchFailure !== undefined) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${switchFailure.message}`, { cause: error });
    throw error;
  }
  addEvent(run, 'submit', `${path}; draft PRs opened or updated`);
  let urls: string[] = [];
  let failed: Error | undefined;
  // The stack and its PRs are now on GitHub; a title failure leaves the checkout where gh stack put it, except for a
  // stopped stack, which goes back to where the run is (the stopped slice) on every exit.
  try {
    urls = await setPrTexts(ws.root, run, slices, stop, progress);
  } catch (caught) {
    failed = new Error(
      `The stack and its PRs were submitted, but not all PR titles were set: ${caught instanceof Error ? caught.message : String(caught)}\nRunning /factory submit again sets them.`,
      { cause: caught },
    );
  } finally {
    if (stop !== undefined) {
      const switchFailure = await switchBack(ws.root, start);
      if (switchFailure !== undefined) {
        failed = new Error(`${failed?.message ?? 'The stack and its PRs were submitted'}\n${switchFailure.message}`, { cause: failed ?? switchFailure.cause });
      }
    }
  }
  const text = `${output.trim()}\nPull requests:\n${urls.map(url => `- ${url}`).join('\n')}`.trim();
  return failed === undefined ? { output: text } : { failure: failed, output: text };
}

/** Switches the checkout back to `start` (the `git switch` arguments). Returns the error to report when that fails, or undefined. */
async function switchBack(root: string, start: string[]) {
  try {
    await git(root, 'switch', '-q', ...start);
    return undefined;
  } catch (switchError) {
    return new Error(`Switching back to ${start.at(-1)} also failed: ${switchError instanceof Error ? switchError.message : String(switchError)}`, { cause: switchError });
  }
}

/** The unbroken run of done slices from the bottom up to (not including) `stopped`; throws when `stopped` is not a slice of the run. */
export function doneBelow(run: Run, stopped: Slice) {
  const index = run.slices.findIndex(slice => slice.id === stopped.id);
  if (index < 0) throw new Error(`Slice ${stopped.id} is not a slice of run "${run.feature}".`);
  const below: Slice[] = [];
  for (const slice of run.slices.slice(0, index)) {
    if (slice.status !== 'done') break;
    below.push(slice);
  }
  return below;
}

/** The slice a headless run stopped at, and why; the PR bodies of the done slices below it say so. */
export type Stop = { reason: string; slice: Slice };

const BODY_LIMIT = 60_000;
const MARKER = '… (truncated)';
// Per-field clips. The body is redacted per field, before the clip, so a clip never cuts a credential in half and leaves
// a prefix redact no longer recognizes; the whole body is redacted once more at the end as a guarantee.
const ITEM_CLIP = 1_000;
/** The most each Related line's URL and title take (the line count is capped by RELATED_MAX): at most about 9,000 characters in all, so the closing sections always fit. */
const RELATED_CLIP = 200;
const ID_CLIP = 100;
const TITLE_CLIP = 500;
const REASON_CLIP = 2_000;
const SUMMARY_CLIP = 15_000;
/** The most a bullet list (acceptance, checks, decisions, unresolved findings) may take. */
const LIST_CAP = 6_900;
const DEFERRED_TITLE_CLIP = 120;
/** The most of one sink location (a file path or an issue URL) a deferred line shows, so one item cannot outgrow the budget. */
const LOCATION_CLIP = 500;
/** The most of the sink locations the "…and N more" line names. */
const SINK_CLIP = 500;
const ISSUES_SINK = 'the issues are listed in the run state';

/** `text` cut to at most `max` characters, ending with a visible marker when it was cut. */
function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - MARKER.length)}${MARKER}`;
}

/** An issue-authored title with GitHub closing keywords (`Fixes #42`, `closed <issue URL>`) broken by a zero-width space before the reference, so merging the PR closes nothing. */
function neutralize(title: string) {
  return title.replace(/\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(\b[:\s]*)(?=#|https?:\/\/|[\w.-]+\/[\w.-]+#)/gi, '$1$2\u200b');
}

type DeferredLine = { location: string; title: string };

const locationOf = (item: DeferredLine) => clip(redact(item.location), LOCATION_CLIP);

/** The "…and N more" line that ends the deferred items when not even their locations fit; `from` items are already listed. */
function moreLine(deferred: DeferredLine[], from: number) {
  const locations = [...new Set(deferred.slice(from).map(locationOf))];
  const sink = locations.every(location => /^https?:\/\//.test(location)) ? ISSUES_SINK : clip(locations.join(', '), SINK_CLIP);
  return `…and ${deferred.length - from} more deferred items: ${sink} (truncated)`;
}

/**
 * The lines of the Deferred items section, at most `budget` characters with their newlines. Each item is a `title:
 * location` line; when those do not fit, a leading run keeps its title and the rest are location-only lines; when not
 * even the location-only lines fit, as many as fit are followed by one count line that names the sink (clipped, or
 * left out, when the budget is smaller than that line).
 */
export function fitDeferred(deferred: DeferredLine[], budget: number) {
  const size = (line: string) => line.length + 1;
  const full = deferred.map(item => `- ${clip(redact(item.title), DEFERRED_TITLE_CLIP)}: ${locationOf(item)}`);
  const bare = deferred.map(item => `- ${locationOf(item)}`);
  // Tier 1: full lines for a leading run, location-only lines for the rest, as many full lines as the budget allows.
  let used = bare.reduce((sum, line) => sum + size(line), 0);
  let fullCount = 0;
  if (used <= budget) {
    while (fullCount < full.length && used - size(bare[fullCount]!) + size(full[fullCount]!) <= budget) {
      used += size(full[fullCount]!) - size(bare[fullCount]!);
      fullCount++;
    }
    return [...full.slice(0, fullCount), ...bare.slice(fullCount)];
  }
  // Tier 2: keep the location-only lines that fit beside the longest count line the section can end with.
  const reserve = size(moreLine(deferred.map(item => ({ ...item, location: 'x'.repeat(SINK_CLIP) })), 0));
  let kept = 0;
  let sum = 0;
  while (kept < bare.length && sum + size(bare[kept]!) + reserve <= budget) sum += size(bare[kept++]!);
  const more = moreLine(deferred, kept);
  // A budget smaller than the count line itself (the section is all that is left of the body) gets it clipped, or nothing.
  if (kept === 0 && size(more) > budget) return budget > MARKER.length ? [clip(more, budget - 1)] : [];
  return [...bare.slice(0, kept), more];
}

/**
 * The PR body of `slice`, written from run state: the issue link, the slice summary and acceptance criteria, the checks
 * it passed, its review rounds, the run's autonomous decisions and gate choices, its accepted-unresolved findings, and
 * its deferred items with their sink locations (the retro's items go on the top submitted slice). A stopped stack says
 * where and why it stopped.
 */
export function prBody(run: Run, slice: Slice, submitted: Slice[], stop?: Stop) {
  const list = (items: string[]) => {
    if (items.length === 0) return 'None.';
    const lines: string[] = [];
    let used = 0;
    for (const item of items) {
      const line = `- ${clip(redact(item), ITEM_CLIP)}`;
      if (used + line.length + 1 > LIST_CAP) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length < items.length) lines.push(`…and ${items.length - lines.length} more (truncated)`);
    return lines.join('\n');
  };
  const issue = run.source.url ?? `${run.source.kind} ${run.source.ref}`;
  const top = submitted.at(-1) === slice;
  const deferred = run.deferred.filter(item => item.slice === slice.id || (top && item.slice === 'retro'));
  const autonomous = [
    ...run.decisions.filter(decision => decision.author === 'autonomous').map(decision => decision.text),
    ...run.events.filter(event => event.kind === 'autonomous').map(event => event.detail),
  ];
  const sections = [
    [
      `Issue: ${clip(redact(issue), ITEM_CLIP)} (${clip(neutralize(redact(run.source.title)), ITEM_CLIP)})`,
      ...(run.source.related ?? []).slice(0, RELATED_MAX).map(item => `Related: ${clip(redact(item.url ?? `${run.source.kind} ${item.ref}`), RELATED_CLIP)} (${clip(neutralize(redact(item.title)), RELATED_CLIP)})`),
      ...((run.source.related?.length ?? 0) > RELATED_MAX ? [`…and ${(run.source.related?.length ?? 0) - RELATED_MAX} more related issues (truncated)`] : []),
    ].join('\n'),
    ...(stop === undefined ? [] : [`**The stack stopped at slice ${clip(redact(stop.slice.id), ID_CLIP)} "${clip(redact(stop.slice.title), TITLE_CLIP)}", which is not submitted:** ${clip(redact(stop.reason), REASON_CLIP)}`]),
    `## Slice ${clip(redact(slice.id), ID_CLIP)}: ${clip(redact(slice.title), TITLE_CLIP)}\n\n${clip(redact(slice.whatToBuild), SUMMARY_CLIP)}\n\nAcceptance:\n${list(slice.acceptance)}`,
    `## Checks run\n\n${list(slice.checked?.results ?? run.checks)}`,
    `## Review rounds\n\n${slice.reviews} ${slice.reviews === 1 ? 'review' : 'reviews'}, ${slice.fixRounds} fix ${slice.fixRounds === 1 ? 'round' : 'rounds'}.`,
    `## Autonomous decisions\n\n${list(autonomous)}`,
    `## Accepted unresolved\n\n${list(slice.unresolved ?? [])}`,
  ];
  const head = '## Deferred items\n\n';
  const budget = BODY_LIMIT - sections.join('\n\n').length - 2 - head.length;
  const shown = fitDeferred(deferred, budget);
  sections.push(`${head}${shown.length === 0 ? 'None.' : shown.join('\n')}`);
  return clip(redact(sections.join('\n\n')), BODY_LIMIT);
}

/**
 * Sets every submitted slice PR's title to `<feature>: NN <slice title>` and its body from run state, overwriting any other title and body. Returns the PR URLs. Uses the REST API, not
 * `gh pr edit`, which fails on repositories with Projects (classic). Fails, setting no title, when a slice has no PR.
 */
async function setPrTexts(root: string, run: Run, slices: Slice[], stop: Stop | undefined, progress: (step: string) => void) {
  progress('setting the slice PR titles and bodies');
  const view = await viewStack(root);
  const byName = new Map(view.map(item => [item.name, item.pr]));
  const pairs = slices.map(slice => ({ slice, pr: byName.get(slice.branch) }));
  const missing = pairs.filter(pair => pair.pr === undefined).map(pair => pair.slice.branch);
  if (missing.length > 0) throw new Error(`gh stack submit left these slice branches with no PR: ${missing.join(', ')}.`);
  const withPr = pairs.flatMap(({ slice, pr }) => (pr === undefined ? [] : [{ slice, pr }]));
  const urls: string[] = [];
  for (const { slice, pr } of withPr) {
    const endpoint = `repos/{owner}/{repo}/pulls/${pr.number}`;
    await gh(root, 'api', '-X', 'PATCH', endpoint, '-f', `title=${run.feature}: ${slice.id} ${slice.title}`, '-f', `body=${prBody(run, slice, slices, stop)}`);
    if (pr.url !== undefined) urls.push(pr.url);
  }
  return urls;
}

/**
 * Fast-forwards `landOn` to the top slice's green commit with a compare-and-swap ref update: no checkout, no merge
 * commit, and a branch that moved since the ancestry check is left alone.
 */
async function landStack(ws: Workspace, run: Run, landOn: string) {
  const top = run.slices.at(-1);
  const green = top === undefined ? undefined : greenCommit(top);
  if (top === undefined || green === undefined) throw new Error(`Run "${run.feature}" has no reviewed slice to land.`);
  const ref = `refs/heads/${landOn}`;
  // Any worktree (this one or a linked one) with the branch checked out would be left behind by the ref update.
  const worktree = (await git(ws.root, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .map(block => block.split('\n'))
    .find(lines => lines.includes(`branch ${ref}`));
  if (worktree !== undefined) {
    const path = worktree[0]?.replace(/^worktree /, '');
    throw new Error(`${landOn} is checked out in ${path}, and moving it would leave that working tree behind. Switch it to another branch, then run /factory submit again.`);
  }
  let old: string;
  try {
    old = (await git(ws.root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim();
    await git(ws.root, 'merge-base', '--is-ancestor', old, green);
  } catch {
    throw new Error(`${landOn} is gone or moved off the stack's base, so it cannot fast-forward to ${top.branch}. Nothing changed.`);
  }
  await git(ws.root, 'update-ref', '-m', `factory: land ${run.feature}`, ref, green, old);
  const landed = `${landOn} fast-forwarded to ${top.branch} (${green.slice(0, 12)})`;
  addEvent(run, 'submit', landed);
  return `${landed}. No PRs were opened.\n`;
}
