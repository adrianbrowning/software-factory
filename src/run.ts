import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { type FactoryConfig, modelsSchema, SPAWN_MODEL_ROLES } from './config.ts';
import { legacyObservations } from './legacy-observations.ts';
import { withFileLock } from './state-lock.ts';

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

/** What an observation is about, which decides its default placement (see `DEFAULT_PLACEMENT`). */
export const OBSERVATION_CATEGORIES = ['correctness', 'missing-test', 'misleading-doc', 'naming', 'structure', 'style'] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/** Where a slice's batch of observations puts one by default: work that is wrong or unproven waits in the end queue, taste is left. 'fix-once' fixes the observation in this slice while the slice has none placed as fixed (so a slice never loops on fix rounds), then it takes the end-queue default. `fixesOnceInSlice` is the one owner of whether a category is fixed once in a given slice: the table's 'fix-once' rows, plus 'correctness' on a follow-up slice built from end-queue items (slice.fromEndQueue). defaultChoice in place.ts reads it and holds no category rule of its own; a fixed-once observation then defers to the sink or leaves on a follow-up slice, never the end queue. */
export const DEFAULT_PLACEMENT = {
  correctness: 'end',
  'misleading-doc': 'fix-once',
  'missing-test': 'end',
  naming: 'leave',
  structure: 'leave',
  style: 'leave',
} as const satisfies Record<ObservationCategory, 'end' | 'fix-once' | 'leave'>;

/** Whether an observation of this category is fixed once in this slice (see `DEFAULT_PLACEMENT`). */
export function fixesOnceInSlice(category: ObservationCategory, slice: Pick<Slice, 'fromEndQueue'>): boolean {
  return DEFAULT_PLACEMENT[category] === 'fix-once' || (category === 'correctness' && slice.fromEndQueue === true);
}

export const SOURCE_KINDS = ['github', 'jira', 'file', 'text'] as const;

/** One finding in the cc-pr-review-ci review.json shape. */
export const findingSchema = z.object({
  /** Required on an observation (submitDomain refuses one without it). A critical or high finding needs none; the validator gives it on a downgrade. */
  category: z
    .enum(OBSERVATION_CATEGORIES)
    .optional()
    .describe('Required for an observation: correctness, missing-test, misleading-doc, naming, structure or style. It sets where the observation goes by default'),
  criterion: z.string().min(1).optional().describe('Set by the validator when it escalates the finding for an unmet acceptance criterion: the quoted criterion'),
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
  symbol: text.optional().describe('Enclosing function, method, class, tool handler (such as "the factory_carry handler") or test title the finding points at; omit for a finding about a whole file'),
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

export const relatedSourceSchema = z.object({ ref: text, title: text, url: z.string().optional() });
export type RelatedSource = z.infer<typeof relatedSourceSchema>;

export const sourceSchema = z.object({
  body: z.string().describe('Full issue text, including relevant comments'),
  kind: z.enum(SOURCE_KINDS),
  ref: text.describe('Issue reference as the user gave it'),
  related: z.array(relatedSourceSchema).optional().describe('Further issues whose text is in the body, after the primary issue'),
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
  seams: z.array(text).describe('Public interfaces the tests go through (tdd skill seams): name the interface (function, tool or command); a file may be added as an optional location hint'),
  title: text,
  whatToBuild: text.describe('End-to-end behavior from the user perspective, not a layer list'),
});
export type SliceInput = z.infer<typeof sliceInputSchema>;
/** A slice from factory_reslice: split children claim no decisions; the split slice's decisions move to its last child. */
export const resliceItemSchema = sliceInputSchema.omit({ ownsDecisions: true }).extend({
  carried: z
    .array(text)
    .optional()
    .describe('Keys (`<review id>:<observation id>`, as listed on the split slice\'s `Carried keys:` lines) of the carried items this child builds; each moves, with its full text, from the first child to this one'),
});

const phaseSchema = z.enum(['checks', 'fix', 'implement', 'ready', 'review']);

/** SHA-1 or SHA-256 object name. */
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** An observation waiting for placement: the finding, the category that sets its default, the review it came from, and that review's commit. */
const unplacedSchema = z.object({
  category: z.enum(OBSERVATION_CATEGORIES),
  finding: findingSchema,
  review: text,
  /** The commit the review that kept the observation was made on; a deferred item names it. Absent in state from before it was stored. */
  sha: sha.optional(),
});
export type Unplaced = z.infer<typeof unplacedSchema>;

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
  /** Set on a targeted review (see `Slice.targeting`): the review it follows and the new-side lines of the fix diff. Only observations are limited to these lines; blocking findings may be anywhere in the slice diff. */
  targeted: z.object({ from: text, lines: z.record(text, z.array(z.tuple([z.number().int().positive(), z.number().int().positive()]))) }).optional(),
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
  /** Fix files written for the slice, counted or not; the next fix file is `<id>-f<fixFiles + 1>`. `fixRounds` is only the fix budget count. A slice saved without it starts from the higher of `fixRounds` and the N in its retained `fixPath` (`<id>-f<N>.md`); see legacySlice. */
  fixFiles: z.number().int().nonnegative(),
  fixRounds: z.number().int().nonnegative(),
  /**
   * The green review of the checked commit (`checked.sha`, see `greenCommit`): how many recorded decisions it covered,
   * so a newer decision needs a new review. A green review from a state file that predates the count has none.
   */
  green: z.object({ decisions: z.number().int().nonnegative().optional(), targeted: z.literal(true).optional() }).optional(),
  /** Whether the slice's last full green review stands: set by a full green, cleared by a red review and by a fix round that counts. A targeted green completes the slice only while it holds. */
  fullGreen: z.boolean().optional(),
  id: z.string().regex(/^\d{2}$/),
  /** Decision numbers (1-based) the slice builds; a state file from before ownership owns none. */
  ownsDecisions: z.array(z.number().int().positive()).default([]),
  parentBranch: text,
  peakContextTokens: z.number().int().nonnegative(),
  phase: phaseSchema,
  review: reviewSchema.optional(),
  reviews: z.number().int().nonnegative(),
  roundLimit: z.number().int().positive(),
  /** Set by addFollowUp on the slice that builds the end queue: in any run mode defaultChoice never puts that slice's own end-default observations back into the end queue, or the run would never reach its retro. */
  fromEndQueue: z.literal(true).optional(),
  /** Set on the Record deferred items slice the factory adds to write file-sink items. Its own reviews defer nothing to the sink. */
  record: z.literal(true).optional(),
  /** Shared by every Record slice of one batch, so a split Record slice's children fail or succeed together (recordFailed). Absent on a Record slice from an older state file. */
  recordBatch: text.optional(),
  /** Set while the slice waits for the user to decide on an exhausted fix budget. */
  stalled: z.boolean(),
  /** Kept observations of the slice's reviews, red ones too, that no placement has handled yet; factory_place and factory_complete_slice drain it. Each placement removes its observation (placeObservations). restartSlice keeps them: the slice's commits stay and the ledger keeps its entries too, so they still wait for the slice's batch placement. */
  unplaced: z.array(unplacedSchema).default([]),
  /** Set by a red review, and by an observation-only fix round: the next review is targeted, over `domains` (plus the required ones), on the changes since `base`, the commit of the review `from`. Cleared when a review is recorded. */
  targeting: z.object({ base: sha, domains: z.array(z.enum(REVIEW_DOMAINS)), from: text }).optional(),
  status: z.enum(['active', 'done', 'pending']),
  /** Set when a headless run accepted the slice with blocking findings or open fix items left after its last fix round: one line per item, prefixed `blocking finding` or `open fix item`, then `id: summary` when it has an id. Green stands in for them; an interactive run never completes such a slice. */
  unresolved: z.array(text).optional(),
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
  fixFiles: z.number().int().nonnegative().optional(),
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
  // LEGACY-STATE(fix-files): an old state file counted every fix round in fixRounds, so fixFiles starts from it. A slice saved while stalled had already written its f<fixRounds+1> file without raising fixRounds, so fixFiles starts from the higher of fixRounds and the N in the retained fixPath (`<id>-f<N>.md`); otherwise the round after a resumed stall would overwrite that file. Remove with checked-pass, once no run paused before the release that ships fixFiles is left to resume.
  const pathRound = Number(/-f(\d+)\.md$/.exec(slice.fixPath ?? '')?.[1] ?? 0);
  return { ...slice, checked, fixFiles: slice.fixFiles ?? Math.max(slice.fixRounds, pathRound), green };
}

/**
 * What a factory agent or scout spawned by the run's main session actually ran, routed or not, recorded from inside its session:
 * the live model and thinking level (`unset` when the session has none), so a fallback model shows. `slice` is the
 * slice active then; a scout during intake has none.
 */
const agentRecordSchema = z.object({
  agentId: text,
  model: text,
  name: text,
  role: z.enum(SPAWN_MODEL_ROLES),
  sessionId: text,
  slice: z.string().optional(),
  thinking: text,
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

/** A recorded decision. `autonomous` marks one a headless run made without the user. Older state files hold plain strings, loaded as the user's. */
const decisionSchema = z.preprocess(
  value => (typeof value === 'string' ? { text: value } : value),
  z.object({ author: z.enum(['autonomous', 'user']).default('user'), text }),
);
export type Decision = z.infer<typeof decisionSchema>;

/** Whether decision `number` (1-based) is one a headless run made without the user. An autonomous decision is checked, never a waiver. */
export function isAutonomous(decisions: Decision[], number: number | undefined) {
  return number !== undefined && decisions[number - 1]?.author === 'autonomous';
}

/**
 * One item sent to the deferred sink (factory_defer, an accepted-unresolved review, or a headless retro). `key` is
 * `review:id` for a finding with an id (so it is deferred once), `review:unresolved:N` for an accepted-unresolved item
 * without an id, `review:note:N` for a note, and `retro:R:N` for the Nth finding of the run's Rth retro. `recorded` names the Record
 * deferred items slice that writes a file item. `location` is the GitHub issue URL, or the sink
 * file's path while the item waits on the run for the file to be written.
 */
const deferredItemSchema = z.object({
  body: text,
  id: text.optional(),
  key: text,
  kind: z.enum(['note', 'observation', 'retro', 'unresolved']),
  location: text,
  recorded: text.optional(),
  /**
   * Set once the item was listed in a second Record deferred items slice because its first one was accepted
   * unresolved. The retry is bounded: an item whose second Record slice also fails is not queued again, and
   * factory_status shows it as not written to the file.
   */
  retried: z.literal(true).optional(),
  review: text,
  slice: text,
  title: text,
});
export type DeferredItem = z.infer<typeof deferredItemSchema>;

/** Where a handled observation went. */
export const PLACEMENTS = ['carried', 'deferred', 'fixed', 'left'] as const;

/**
 * One observation the run has handled, kept so a repeat is refused and a later review can tell it is not new. `key` is
 * `review:id`, the key of a deferred item. `location`, `title` and `problem` are the kept finding's text, for matching a
 * repeat under a new id. `to` is where a carried observation went when it was carried: a pending slice id, or `end`. It
 * is written once and not kept in step when the carried text moves (reslice, follow-up); the review data file reads where
 * the text sits instead.
 */
const observationEntrySchema = z.object({
  id: text,
  key: text,
  location: text,
  placement: z.enum(PLACEMENTS),
  problem: text,
  review: text,
  slice: text,
  title: text,
  to: text.optional(),
});
export type ObservationEntry = z.infer<typeof observationEntrySchema>;

const runSchema = z.object({
  /** One record per factory agent or scout session the run's main session spawned. Empty in runs from before it was kept. */
  agents: z.array(agentRecordSchema).default([]),
  /** Local branch a headless run started with `--base` builds on; `baseRef` and `baseSha` are fixed to it at start. Absent otherwise. */
  baseBranch: text.optional(),
  baseRef: text,
  /** Commit `baseRef` pointed at when the plan was approved (at start for a headless run started with `--base`); slice 01 branches from it. */
  baseSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  /** Legacy (see legacyObservations): observations carried to a slice or the end queue, as `review:id`, in a state file from before the ledger. Read once, never written. */
  carriedObservations: z.array(text).default([]),
  /** Check commands every slice must pass, fixed when the run starts. Empty in runs from before they were kept here. */
  checks: z.array(text).default([]),
  createdAt: text,
  /** Decisions recorded during the run (accepted tradeoffs, out-of-scope work), each with its author. Reviewers read them; an autonomous one is checked, not a waiver. */
  decisions: z.array(decisionSchema).default([]),
  /** Items sent to the deferred sink, in order. */
  deferred: z.array(deferredItemSchema).default([]),
  events: z.array(z.object({ at: text, detail: z.string(), kind: text, slice: z.string().optional() })),
  feature: text,
  /** Existing local branch that `/factory submit` fast-forwards to the top slice, instead of opening PRs. */
  landOn: text.optional(),
  /**
   * Role to model policy from `models` in factory.json, fixed when the run starts. Empty in runs from before it was kept.
   * It shares the factory.json input schema, so any change to modelsSchema must still accept every stored run.
   */
  models: modelsSchema.default({}),
  /** Whether the run asks the user at its gates or decides alone. Runs from before it was kept are interactive. */
  mode: z.enum(['headless', 'interactive']).default('interactive'),
  /** Every observation the run has handled (carried, deferred, fixed or left), in order. A state file from before it was kept has none: its entries come from `carriedObservations` and its deferred items (see legacyObservations). */
  observations: z.array(observationEntrySchema).optional(),
  ownerSessionId: text,
  retroRecorded: z.boolean(),
  slices: z.array(legacySliceSchema),
  source: sourceSchema,
  /** Titles of slices factory_reslice split away, so a carried section's header still names a known slice after its slice was split. Empty in runs from before it was kept. */
  splitTitles: z.array(text).default([]),
  status: z.enum(['done', 'intake', 'paused', 'running', 'stalled']),
  trunk: text,
  /**
   * Work carried with factory_carry `to: "end"`, as ticket sections: it waits on the run until the next
   * factory_follow_up takes all of it into its slice's ticket. The retro waits for an empty queue.
   */
  waiting: z.array(text).default([]),
  version: z.union([z.literal(1), z.literal(2)]),
  /** The factory version that last saved the file. Absent in version 1 files. */
  factoryVersion: z.string().optional(),
}).transform(({ carriedObservations, slices, version: _version, ...run }) => {
  const sections = [...run.waiting.map(section => ({ text: section, to: 'end' })), ...slices.flatMap(slice => slice.carried.map(section => ({ text: section, to: slice.id })))];
  // A state file with an `observations` list is current: its deferred items are not read as observations.
  const observations = run.observations ?? legacyObservations(carriedObservations, run.deferred, sections);
  // LEGACY-STATE(version-1): a version 1 file loads as the current version; the next save writes version 2.
  return { ...run, observations, slices: slices.map(slice => legacySlice(slice, run.checks)), version: 2 as const };
});
export type Run = z.infer<typeof runSchema>;

export type Workspace = { config: FactoryConfig; root: string };

export function runDir(ws: Workspace, feature: string) {
  return join(ws.root, ws.config.scratchDir, feature);
}

export const statePath = (ws: Workspace, feature: string) => join(runDir(ws, feature), 'state.json');
/** Held while one tool call, in any thread or process, does a read-modify-write of this run's state. */
export const lockPath = (ws: Workspace, feature: string) => `${statePath(ws, feature)}.lock`;
export const ticketPath = (ws: Workspace, feature: string, slice: Pick<Slice, 'branch' | 'id'>) =>
  join(runDir(ws, feature), 'issues', `${slice.branch.split('/').pop()}.md`);
export const reviewDir = (ws: Workspace, feature: string, reviewId: string) => join(runDir(ws, feature), 'reviews', reviewId);
export const REVIEW_REFERENCE_DIR = fileURLToPath(new URL('../skills/software-factory/references/review/', import.meta.url));

/** The domains a review waits for: every domain it did not skip. */
export function reviewDomains(skipped: { domain: Domain }[]) {
  return REVIEW_DOMAINS.filter(domain => !skipped.some(entry => entry.domain === domain));
}

/** The files a review's reviewers and validator work from; recoverable after a resume from the review id alone. */
export function reviewPaths(ws: Workspace, run: Pick<Run, 'feature'>, id: string) {
  return {
    dataFile: join(reviewDir(ws, run.feature, id), 'data.md'),
    findingsDir: join(reviewDir(ws, run.feature, id), 'domains'),
    referenceDir: REVIEW_REFERENCE_DIR,
  };
}
export const reportFile = (slice: Pick<Slice, 'id'>) => posix.join('reports', `${slice.id}.md`);
export const reportPath = (ws: Workspace, feature: string, slice: Pick<Slice, 'id'>) => join(runDir(ws, feature), reportFile(slice));

/** Write via rename so concurrent readers never see a partial file. */
export function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/**
 * The hashes of the last two states the tools saved, newest first, in a file beside state.json. Every copy of the
 * extension (other worker threads, other processes) reads it, so a save by one is not mistaken by another for an edit
 * outside the tools. The newest hash is written before state.json is replaced, so a reader that races a save finds
 * the state it read in the file. The price: restoring the state of the save just before the newest passes too.
 * A reader whose hash is missing reads both files once more before it rejects, which covers two saves landing
 * between its reads. No file means no tool has saved yet: the state is trusted as it is.
 */
const savedPath = (path: string) => `${path}.saved`;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

function savedHashes(path: string): string[] {
  try {
    return readFileSync(savedPath(path), 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The run state schema version this factory writes and the newest it can read. */
export const STATE_VERSION = 2;
export const FACTORY_VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;
/** The two fields readRun checks before the full parse, so a newer file gets a version error, not a schema one. */
const stateHeaderSchema = z.object({ factoryVersion: z.string().optional().catch(undefined), version: z.number() });

export function readRun(ws: Workspace, feature: string): Run {
  const path = statePath(ws, feature);
  let content = readFileSync(path, 'utf8');
  let saved = savedHashes(path);
  if (saved.length > 0 && !saved.includes(hash(content))) {
    // Two saves can land between the two reads above, pushing this state out of the list; look once more.
    content = readFileSync(path, 'utf8');
    saved = savedHashes(path);
    if (saved.length > 0 && !saved.includes(hash(content))) {
      throw new Error(`${path} changed outside the factory tools. Restore it, or pause and resume the run to re-verify it.`);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`Corrupt factory state ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const header = stateHeaderSchema.safeParse(raw);
  if (header.success && header.data.version > STATE_VERSION) {
    const writer = header.data.factoryVersion;
    throw new Error(
      `${path} was written by ${writer === undefined ? 'a factory of an unknown version' : `factory ${writer}`} (state version ${header.data.version}); this factory is ${FACTORY_VERSION} and reads state up to version ${STATE_VERSION}. Update the factory plugin.`,
    );
  }
  const parsed = runSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Corrupt factory state ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Forgets the saved hashes so the next read trusts disk again. Only resume calls this, then re-verifies. */
export function forgetRun(ws: Workspace, feature: string) {
  rmSync(savedPath(statePath(ws, feature)), { force: true });
}

export function saveRun(ws: Workspace, run: Run) {
  const path = statePath(ws, run.feature);
  const content = `${JSON.stringify({ ...run, factoryVersion: FACTORY_VERSION, version: STATE_VERSION }, null, 2)}\n`;
  const valid = runSchema.safeParse(JSON.parse(content));
  if (!valid.success) throw new Error(`Refusing to save invalid factory state ${path}: ${z.prettifyError(valid.error)}`);
  const current = hash(content);
  writeAtomic(savedPath(path), `${current}\n${savedHashes(path).find(previous => previous !== current) ?? ''}\n`);
  writeAtomic(path, content);
}

/**
 * A deliberate invalidation: the mutation reset the slice to an earlier phase and wants that saved, then
 * reports why. Every other error discards the mutation.
 */
export class Invalidated extends Error {}

const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes read-modify-write of one run's state across concurrent tool calls: the queue orders them in this
 * process, and the lock file orders them against other copies of the extension in worker threads or processes.
 * The mutation is saved when it returns or throws `Invalidated`; any other error leaves the state unchanged.
 */
export function withRun<T>(ws: Workspace, feature: string, mutate: (run: Run) => Promise<T> | T): Promise<T> {
  const key = statePath(ws, feature);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
    withFileLock(lockPath(ws, feature), async () => {
      const run = readRun(ws, feature);
      try {
        const result = await mutate(run);
        saveRun(ws, run);
        return result;
      } catch (error) {
        if (error instanceof Invalidated) saveRun(ws, run);
        throw error;
      }
    }),
  );
  queues.set(key, next);
  return next;
}

export function addEvent(run: Run, kind: string, detail: string, slice?: Slice) {
  run.events.push({ at: new Date().toISOString(), detail, kind, slice: slice?.id });
}

export function activeSlice(run: Run) {
  return run.slices.find(slice => slice.status === 'active');
}

/** The one explanation every reply gives for a slice that used up its fix budget. */
export function stallNotice(run: Run, slice: Slice) {
  if (run.mode === 'headless') return `The fix budget of slice ${slice.id} "${slice.title}" is used up after ${slice.roundLimit} fix rounds. A headless run cannot raise it, so the run does not continue past this slice.`;
  return `The fix budget of slice ${slice.id} "${slice.title}" is used up after ${slice.roundLimit} fix rounds. Tell the user that /factory resume ${run.feature} asks whether to raise it and resume.`;
}

/** Throws the stall notice when the active slice used up its fix budget. */
export function requireNotStalled(run: Run) {
  const slice = activeSlice(run);
  if (slice?.stalled) throw new Error(stallNotice(run, slice));
}

export function requireActive(run: Run) {
  const slice = activeSlice(run);
  if (slice === undefined) {
    throw new Error(
      'No active slice. Call factory_next. To change a slice that is done, ask the user: factory_reopen fixes a bug in that slice, factory_follow_up adds a slice on top of the stack.',
    );
  }
  requireNotStalled(run);
  return slice;
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

/** Drops the slice's green review: its green mark, its review, and any unresolved items it was accepted with. */
export function clearGreen(slice: Slice) {
  slice.green = undefined;
  slice.review = undefined;
  slice.unresolved = undefined;
}

/** Drops the slice's full green; it leaves `targeting` alone (the red branch replaces it, requestFix callers set it first). Not part of clearGreen: a full green survives an observation-only fix round. Called on a red review and a counted fix round. */
export function clearFullGreen(slice: Slice) {
  slice.fullGreen = false;
}

/** Drops the slice's passed checks and review and moves it to `phase`. */
export function dropPass(slice: Slice, phase: Slice['phase']) {
  slice.phase = phase;
  slice.checked = undefined;
  clearGreen(slice);
}

/** True while the slice is in review with its review set; the phase check is needed because `review` stays set after a green review. */
export function reviewIsOpen(slice: Slice): slice is Slice & { review: NonNullable<Slice['review']> } {
  return slice.phase === 'review' && slice.review !== undefined;
}

/** Discards the open review of a slice in review, whose reviewers can no longer finish it, for `reason`; returns its id, or undefined when there was none. */
export function discardReview(run: Run, slice: Slice, reason: string) {
  const review = slice.phase === 'review' ? slice.review : undefined;
  if (review === undefined) return undefined;
  slice.review = undefined;
  addEvent(run, 'review-invalidated', `${review.id}: ${reason}`, slice);
  return review.id;
}
