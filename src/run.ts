import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { FactoryConfig } from './config.ts';

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
  /** Public interfaces the tests go through, agreed with the user at plan approval (tdd skill). */
  seams: z.array(text).describe('Public interfaces the tests go through (tdd skill seams)'),
  title: text,
  whatToBuild: text.describe('End-to-end behavior from the user perspective, not a layer list'),
});
export type SliceInput = z.infer<typeof sliceInputSchema>;

const phaseSchema = z.enum(['checks', 'fix', 'implement', 'ready', 'review']);

/** SHA-1 or SHA-256 object name. */
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/**
 * Who wrote a review artifact and the sha256 of what the tool wrote, so a later edit is detected. `amended` marks a
 * domain reviewer or validator that has used its one replacement.
 */
const submissionSchema = z.object({ agentId: text, amended: z.boolean().optional(), hash: text });

const skippedDomainSchema = z.object({ domain: z.enum(REVIEW_DOMAINS), reason: text.describe('Why the diff needs no review in this domain') });
export const skippedDomainsSchema = z.array(skippedDomainSchema);

const reviewSchema = z.object({
  /** How many recorded decisions the review data file listed; findings may cite only these. */
  decisions: z.number().int().nonnegative().default(0),
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

const sliceSchema = sliceInputSchema.extend({
  branch: text,
  checkedSha: sha.optional(),
  /** What each check reported when `checkedSha` passed; the review data file lists them for reviewers. */
  checkResults: z.array(text).optional(),
  compactions: z.number().int().nonnegative(),
  fixPath: text.optional(),
  /** Commit the current fix file describes; checks on the same commit mean the fix round changed nothing. */
  fixFromSha: sha.optional(),
  fixRounds: z.number().int().nonnegative(),
  greenSha: sha.optional(),
  id: z.string().regex(/^\d{2}$/),
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

const runSchema = z.object({
  baseRef: text,
  /** Commit `baseRef` pointed at when the plan was approved; slice 01 branches from it. */
  baseSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  createdAt: text,
  /** Decisions the user made during the run (accepted tradeoffs, out-of-scope work). Reviewers read them. */
  decisions: z.array(text).default([]),
  events: z.array(z.object({ at: text, detail: z.string(), kind: text, slice: z.string().optional() })),
  feature: text,
  /** Existing local branch that `/factory submit` fast-forwards to the top slice, instead of opening PRs. */
  landOn: text.optional(),
  ownerSessionId: text,
  retroRecorded: z.boolean(),
  slices: z.array(sliceSchema),
  source: sourceSchema,
  status: z.enum(['done', 'intake', 'paused', 'running', 'stalled']),
  trunk: text,
  version: z.literal(1),
});
export type Run = z.infer<typeof runSchema>;

export type Workspace = { config: FactoryConfig; root: string };

export function runDir(ws: Workspace, feature: string) {
  return join(ws.root, ws.config.scratchDir, feature);
}

export const statePath = (ws: Workspace, feature: string) => join(runDir(ws, feature), 'state.json');
export const ticketPath = (ws: Workspace, feature: string, slice: Pick<Slice, 'branch' | 'id'>) =>
  join(runDir(ws, feature), 'issues', `${slice.branch.split('/').pop()}.md`);
export const reviewDir = (ws: Workspace, feature: string, reviewId: string) => join(runDir(ws, feature), 'reviews', reviewId);

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
