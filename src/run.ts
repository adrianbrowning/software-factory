import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { type FactoryConfig, MODEL_ROLES, modelsSchema } from './config.ts';

/** The cc-pr-review domains. Each has a vendored reference under skills/software-factory/references/review/. */
export const REVIEW_DOMAINS = [
  'security',
  'performance',
  'react-ts',
  'testing',
  'test-validity',
  'devops',
  'holistic',
  'thermo',
  'bug',
  'scope',
  'comments',
] as const;
export type Domain = (typeof REVIEW_DOMAINS)[number];

/**
 * Domains that hold the correctness and requirements bar: a review never skips them, and never skips `testing` for a
 * slice with test seams. Any other domain can be skipped with a reason.
 */
export const REQUIRED_REVIEW_DOMAINS = ['bug', 'scope'] as const satisfies readonly Domain[];

const text = z.string().min(1);

export const SEVERITIES = ['critical', 'high', 'observation'] as const;
export const SOURCE_KINDS = ['github', 'jira', 'file', 'text'] as const;

/** One finding in the cc-pr-review-ci review.json shape. */
export const findingSchema = z.object({
  decision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of the recorded user decision the code breaks; such a finding is critical or high'),
  domain: z.enum(REVIEW_DOMAINS).describe('Your review domain'),
  fix: text.describe('How to fix it'),
  fix_prompt: text.describe('Plain-text prompt an implementer can act on directly'),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Stable id: {domain}-{kebab-case-title}, no line numbers'),
  line: z.number().int().positive().optional().describe('New-file line inside one of the diff hunks for this path; omit for file-level findings'),
  path: text.describe('Repo-relative path from the CHANGED FILES list'),
  problem: text.describe('What is wrong and why it matters'),
  severity: z.enum(SEVERITIES),
  title: text,
});
export type Finding = z.infer<typeof findingSchema>;
export const findingListSchema = z.array(findingSchema);

export const FIX_STATUSES = ['fixed', 'not-a-defect', 'waived', 'open'] as const;

const verdictReason = text.describe(
  'Why: for fixed, where the diff fixes it; for not-a-defect, the evidence from the diff or code (a claim such as unreachable needs it); for waived, how the decision covers it; for open, what still fails',
);
const verdictId = text.describe('Fix item id, exactly as the FIX ITEMS section lists it');

/**
 * The scope reviewer's verdict on one fix item the review data file lists. A waived item names the recorded decision
 * that waives it; no other status names one.
 */
export const fixVerdictSchema = z.discriminatedUnion('status', [
  z.strictObject({
    decision: z.number().int().positive().describe('Number of the recorded user decision that waives the item'),
    id: verdictId,
    reason: verdictReason,
    status: z.literal('waived'),
  }),
  z.strictObject({ id: verdictId, reason: verdictReason, status: z.enum(FIX_STATUSES).exclude(['waived']) }),
]);
export type FixVerdict = z.infer<typeof fixVerdictSchema>;

export const sourceSchema = z.object({
  body: z.string().describe('Full issue text, including relevant comments'),
  kind: z.enum(SOURCE_KINDS),
  ref: text.describe('Issue reference as the user gave it'),
  title: text,
  url: z.string().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const sliceInputSchema = z.object({
  acceptance: z.array(text).min(1).describe('Checkable acceptance criteria'),
  blockedBy: z.array(text).describe('Titles of slices that must finish first'),
  estimateTokens: z.number().int().positive().describe('Estimated implementer context tokens for the whole slice'),
  /** Why the slice has no test seams (docs or config only). Plan validation requires it when `seams` is empty. */
  noTestReason: text.optional().describe('Only when seams is empty: why the slice has nothing to test'),
  /** Numbers of recorded decisions this slice builds; a slice before it marks them as built later (renderDecisions). */
  ownsDecisions: z
    .array(z.number().int().positive())
    .optional()
    .describe('Numbers of decisions recorded before the plan that this slice builds; each decision has at most one owning slice'),
  /** Public interfaces the tests go through, agreed with the user at plan approval (tdd skill). */
  seams: z.array(text).describe('Public interfaces the tests go through (tdd skill seams)'),
  title: text,
  whatToBuild: text.describe('End-to-end behavior from the user perspective, not a layer list'),
});
export type SliceInput = z.infer<typeof sliceInputSchema>;
/** A slice from factory_reslice: split children claim no decisions; the split slice's decisions move to its last child. */
export const resliceItemSchema = sliceInputSchema.omit({ ownsDecisions: true });

const phaseSchema = z.enum(['checks', 'fix', 'implement', 'ready', 'review']);

/** SHA-1 or SHA-256 object name. */
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/**
 * Who wrote a review artifact and the sha256 of what the tool wrote, so a later edit is detected. `amended` marks a
 * validator that has used its one correction.
 */
const submissionSchema = z.object({ agentId: text, amended: z.boolean().optional(), hash: text });

const skippedDomainSchema = z.object({ domain: z.enum(REVIEW_DOMAINS), reason: text.describe('Why the diff needs no review in this domain') });
export const skippedDomainsSchema = z.array(skippedDomainSchema);

const reviewSchema = z.object({
  /** How many recorded decisions the review data file listed; findings may cite only these. */
  decisions: z.number().int().nonnegative().default(0),
  /** The scope reviewer's latest verdict per fix item; recording the review treats a missing or open verdict as open. */
  fixVerdicts: z.array(fixVerdictSchema).optional(),
  id: text,
  /** Changed paths and the new-side line ranges of their hunks; a finding must point inside them. */
  lines: z.record(text, z.array(z.tuple([z.number().int().positive(), z.number().int().positive()]))).default({}),
  sha,
  snapshot: text,
  /** Domains the orchestrator left out for this diff; every other domain must submit. */
  skipped: skippedDomainsSchema.default([]),
  submissions: z.partialRecord(z.enum(REVIEW_DOMAINS), submissionSchema),
  validation: submissionSchema.optional(),
});

/**
 * One thing a fix round asked the implementer to fix: a review finding by its id, or a factory-assigned id for a bug
 * (`bug-f<N>`), a reopen reason (`reopen-f<N>`), a failed check (`check-f<N>-<k>`), or a working tree the checks
 * changed (`tree-f<N>`). `path` and `round` name the fix file that asked for it.
 */
const fixItemSchema = z.object({ id: text, path: text, round: z.number().int().positive(), summary: text });
export type FixItem = z.infer<typeof fixItemSchema>;

const sliceSchema = sliceInputSchema.extend({
  branch: text,
  /** Work carried in from earlier slices' green reviews (factory_carry), as ticket sections; renderTicket lists them. */
  carried: z.array(text).default([]),
  /**
   * The checks the slice passed: the commit, and the result of each of the run's checks, in order. A done slice read
   * from an older state file may hold no results (see legacySlice); a legacy pass is trusted to match the run's
   * checks, which a run never changes once kept.
   */
  checked: z.object({ results: z.array(text), sha }).optional(),
  compactions: z.number().int().nonnegative(),
  /** Branch tip when a done slice was reopened; completing it restacks every later slice from this commit. */
  doneSha: sha.optional(),
  fixPath: text.optional(),
  /** Commit the current fix file describes; checks on the same commit mean the fix round changed nothing. */
  fixFromSha: sha.optional(),
  /** Fix items from every fix round since the slice's last recorded review; recording a review clears them, and its fix file asks again for the blocking findings and open items. */
  fixItems: z.array(fixItemSchema).default([]),
  fixRounds: z.number().int().nonnegative(),
  /**
   * The green review of the checked commit (`checked.sha`, see `greenCommit`): how many recorded decisions it covered,
   * so a newer decision needs a new review. A green review from a state file that predates the count has none.
   */
  green: z.object({ decisions: z.number().int().nonnegative().optional() }).optional(),
  id: z.string().regex(/^\d{2}$/),
  /** Decision numbers (1-based) the slice builds; a state file from before ownership owns none. */
  ownsDecisions: z.array(z.number().int().positive()).default([]),
  parentBranch: text,
  peakContextTokens: z.number().int().nonnegative(),
  phase: phaseSchema,
  review: reviewSchema.optional(),
  reviews: z.number().int().nonnegative(),
  roundLimit: z.number().int().positive(),
  /** Set while the slice waits for the user to decide on an exhausted fix budget. */
  stalled: z.boolean(),
  status: z.enum(['active', 'done', 'pending']),
});
export type Slice = z.infer<typeof sliceSchema>;

/** The owner label of a decision, shared by the decision event, the factory_decide dialog and the ticket mark. */
export function builtBy(slice: Slice, start: 'built' | 'Built' = 'built') {
  return `${start} by slice ${slice.id} (${slice.title})`;
}

/**
 * A slice as a state file from before `checked` and `green` holds it: a pass as checkedSha and checkResults, a green
 * review as greenSha and greenDecisions. Read by `legacySlice`.
 */
const legacySliceSchema = sliceSchema.extend({
  checkedSha: sha.optional(),
  checkResults: z.array(text).optional(),
  greenDecisions: z.number().int().nonnegative().optional(),
  greenSha: sha.optional(),
});

/** The slice in today's shape, from a state file that may predate `checked` and `green`, in a run with `checks`. */
function legacySlice({ checkedSha, checkResults, greenDecisions, greenSha, ...slice }: z.infer<typeof legacySliceSchema>, checks: string[]): Slice {
  let checked = slice.checked;
  const legacySha = slice.status === 'done' ? greenSha ?? checkedSha : checkedSha ?? greenSha;
  // LEGACY-STATE(checked-pass): an old pass stands only with the results it saved, in a run that kept its checks;
  // one without results is no pass, so resume sends the slice back to checks. A done slice keeps its green commit, with
  // the results it saved or none in a file that saved none: its checks are never reused, since only the active slice's checks are, and reopening or
  // restacking a done slice drops its pass. Remove once no run paused before the release that ships issue #60 is left
  // to resume.
  const saved = checks.length > 0 && checkResults !== undefined;
  if (checked === undefined && legacySha !== undefined && (saved || (slice.status === 'done' && greenSha !== undefined))) {
    checked = { results: checkResults ?? [], sha: legacySha };
  }
  // LEGACY-STATE(green-sha): a green review was greenSha; it carries over as `green` only when greenSha is the checked commit, so a slice not done whose checkedSha moved past it loses its green review. Remove with checked-pass.
  let green = slice.green;
  if (green === undefined && greenSha !== undefined && checked?.sha === greenSha) green = greenDecisions === undefined ? {} : { decisions: greenDecisions };
  return { ...slice, checked, green };
}

/**
 * What a spawned factory agent (or a routed scout) actually ran, recorded from inside its session on its first turn:
 * the live model and thinking level (`unset` when the session has none), so a fallback model shows. `slice` is the
 * slice active then; a scout during intake has none.
 */
const agentRecordSchema = z.object({
  agentId: text,
  model: text,
  name: text,
  role: z.enum(MODEL_ROLES),
  sessionId: text,
  slice: z.string().optional(),
  thinking: text,
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

const runSchema = z.object({
  /** One record per spawned factory agent session and routed scout session. Empty in runs from before it was kept. */
  agents: z.array(agentRecordSchema).default([]),
  baseRef: text,
  /** Commit `baseRef` pointed at when the plan was approved; slice 01 branches from it. */
  baseSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  /** Check commands every slice must pass, fixed when the run starts. Empty in runs from before they were kept here. */
  checks: z.array(text).default([]),
  createdAt: text,
  /** Decisions the user made during the run (accepted tradeoffs, out-of-scope work). Reviewers read them. */
  decisions: z.array(text).default([]),
  events: z.array(z.object({ at: text, detail: z.string(), kind: text, slice: z.string().optional() })),
  feature: text,
  /** Existing local branch that `/factory submit` fast-forwards to the top slice, instead of opening PRs. */
  landOn: text.optional(),
  /** Role to model policy from `models` in factory.json, fixed when the run starts. Empty in runs from before it was kept. */
  models: modelsSchema.default({}),
  ownerSessionId: text,
  retroRecorded: z.boolean(),
  slices: z.array(legacySliceSchema),
  source: sourceSchema,
  status: z.enum(['done', 'intake', 'paused', 'running', 'stalled']),
  trunk: text,
  /**
   * Work carried with factory_carry `to: "end"`, as ticket sections: it waits on the run until the next
   * factory_follow_up takes all of it into its slice's ticket. The retro waits for an empty queue.
   */
  waiting: z.array(text).default([]),
  version: z.literal(1),
}).transform(({ slices, ...run }) => ({ ...run, slices: slices.map(slice => legacySlice(slice, run.checks)) }));
export type Run = z.infer<typeof runSchema>;

export type Workspace = { config: FactoryConfig; root: string };

export function runDir(ws: Workspace, feature: string) {
  return join(ws.root, ws.config.scratchDir, feature);
}

export const statePath = (ws: Workspace, feature: string) => join(runDir(ws, feature), 'state.json');
export const ticketPath = (ws: Workspace, feature: string, slice: Pick<Slice, 'branch' | 'id'>) =>
  join(runDir(ws, feature), 'issues', `${slice.branch.split('/').pop()}.md`);
export const reviewDir = (ws: Workspace, feature: string, reviewId: string) => join(runDir(ws, feature), 'reviews', reviewId);
export const reportPath = (ws: Workspace, feature: string, slice: Pick<Slice, 'id'>) => join(runDir(ws, feature), 'reports', `${slice.id}.md`);

/** Write via rename so concurrent readers never see a partial file. */
export function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/** Last state each tool call saved in this process, by path. A different file on disk was edited outside the tools. */
const lastSaved = new Map<string, string>();

export function readRun(ws: Workspace, feature: string): Run {
  const path = statePath(ws, feature);
  const content = readFileSync(path, 'utf8');
  const expected = lastSaved.get(path);
  if (expected !== undefined && expected !== content) {
    throw new Error(`${path} changed outside the factory tools. Restore it, or pause and resume the run to re-verify it.`);
  }
  const parsed = runSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error(`Corrupt factory state ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Forgets the in-process copy so the next read trusts disk again. Only resume calls this, then re-verifies. */
export function forgetRun(ws: Workspace, feature: string) {
  lastSaved.delete(statePath(ws, feature));
}

export function saveRun(ws: Workspace, run: Run) {
  const content = `${JSON.stringify(run, null, 2)}\n`;
  writeAtomic(statePath(ws, run.feature), content);
  lastSaved.set(statePath(ws, run.feature), content);
}

/**
 * A deliberate invalidation: the mutation reset the slice to an earlier phase and wants that saved, then
 * reports why. Every other error discards the mutation.
 */
export class Invalidated extends Error {}

const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes read-modify-write of one run's state across concurrent tool calls in this process.
 * The mutation is saved when it returns or throws `Invalidated`; any other error leaves the state unchanged.
 */
export function withRun<T>(ws: Workspace, feature: string, mutate: (run: Run) => Promise<T> | T): Promise<T> {
  const key = statePath(ws, feature);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const run = readRun(ws, feature);
    try {
      const result = await mutate(run);
      saveRun(ws, run);
      return result;
    } catch (error) {
      if (error instanceof Invalidated) saveRun(ws, run);
      throw error;
    }
  });
  queues.set(key, next);
  return next;
}

export function addEvent(run: Run, kind: string, detail: string, slice?: Slice) {
  run.events.push({ at: new Date().toISOString(), detail, kind, slice: slice?.id });
}

export function activeSlice(run: Run) {
  return run.slices.find(slice => slice.status === 'active');
}

/**
 * The decision count a green slice's review covered, when decisions landed after it; otherwise undefined. Since
 * factory_decide reopens such a slice at once, only a state file written before it did keeps this state; one from
 * before the count has none, and its green review stays valid.
 */
export function outdatedGreenCount(run: Run, slice: Slice) {
  const covered = slice.green?.decisions;
  if (slice.phase !== 'ready' || covered === undefined) return undefined;
  return run.decisions.length > covered ? covered : undefined;
}

/** The commit the slice's green review approved: its checked commit, while it has a green review. Otherwise undefined. */
export function greenCommit(slice: Slice) {
  return slice.green === undefined ? undefined : slice.checked?.sha;
}

/** Whether the slice is past its checks: in review, or ready with a green review. Only such a slice holds a pass. */
export function hasPass(slice: Slice) {
  return slice.phase === 'review' || slice.phase === 'ready';
}

/**
 * The slice's passing check results when they still stand on `sha`, so the checks need not run again: the slice holds
 * a pass (`hasPass`) on that commit. Otherwise undefined.
 */
export function standingChecks(slice: Slice, sha: string) {
  const checked = slice.checked;
  return checked?.sha === sha && hasPass(slice) ? checked.results : undefined;
}

/** Drops the slice's passed checks and review and moves it to `phase`. */
export function dropPass(slice: Slice, phase: Slice['phase']) {
  slice.phase = phase;
  slice.checked = undefined;
  slice.green = undefined;
  slice.review = undefined;
}

/** Discards the open review of a slice in review, whose reviewers can no longer finish it, for `reason`; returns its id, or undefined when there was none. */
export function discardReview(run: Run, slice: Slice, reason: string) {
  const review = slice.phase === 'review' ? slice.review : undefined;
  if (review === undefined) return undefined;
  slice.review = undefined;
  addEvent(run, 'review-invalidated', `${review.id}: ${reason}`, slice);
  return review.id;
}
