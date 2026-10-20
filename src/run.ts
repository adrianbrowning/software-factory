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

const text = z.string().min(1);

/** One finding in the cc-pr-review-ci review.json shape. */
export const findingSchema = z.object({
  domain: z.enum(REVIEW_DOMAINS),
  fix: text,
  fix_prompt: text,
  id: z.string().regex(/^[a-z0-9-]+$/),
  line: z.number().int().positive().optional(),
  path: text,
  problem: text,
  severity: z.enum(['critical', 'high', 'observation']),
  title: text,
});
export type Finding = z.infer<typeof findingSchema>;
export const findingListSchema = z.array(findingSchema);

export const sourceSchema = z.object({
  body: z.string(),
  kind: z.enum(['file', 'github', 'jira', 'text']),
  ref: text,
  title: text,
  url: z.string().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const sliceInputSchema = z.object({
  acceptance: z.array(text).min(1),
  /** Titles of slices that must finish first. */
  blockedBy: z.array(text),
  estimateTokens: z.number().int().positive(),
  /** Why the slice has no test seams (docs or config only). Required when `seams` is empty. */
  noTestReason: text.optional(),
  /** Public interfaces the tests go through, agreed with the user at plan approval (tdd skill). */
  seams: z.array(text),
  title: text,
  whatToBuild: text,
});
export type SliceInput = z.infer<typeof sliceInputSchema>;

const phaseSchema = z.enum(['checks', 'fix', 'implement', 'ready', 'review']);
export type Phase = z.infer<typeof phaseSchema>;

const sha = z.string().regex(/^[0-9a-f]{40}$/);

const sliceSchema = sliceInputSchema.extend({
  branch: text,
  checkedSha: sha.optional(),
  compactions: z.number().int().nonnegative(),
  fixPath: text.optional(),
  fixRounds: z.number().int().nonnegative(),
  greenSha: sha.optional(),
  id: z.string().regex(/^\d{2}$/),
  parentBranch: text,
  peakContextTokens: z.number().int().nonnegative(),
  phase: phaseSchema,
  review: z.object({ id: text, sha, snapshot: text }).optional(),
  reviews: z.number().int().nonnegative(),
  roundLimit: z.number().int().positive(),
  /** Set while the slice waits for the user to decide on an exhausted fix budget. */
  stalled: z.boolean(),
  status: z.enum(['active', 'done', 'pending']),
});
export type Slice = z.infer<typeof sliceSchema>;

const runSchema = z.object({
  baseRef: text,
  createdAt: text,
  events: z.array(z.object({ at: text, detail: z.string(), kind: text, slice: z.string().optional() })),
  feature: text,
  ownerSessionId: text,
  retroRecorded: z.boolean(),
  slices: z.array(sliceSchema),
  source: sourceSchema,
  status: z.enum(['done', 'intake', 'paused', 'running', 'stalled']),
  trunk: text,
  version: z.literal(1),
});
export type Run = z.infer<typeof runSchema>;
export type RunStatus = Run['status'];

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

export function readRun(ws: Workspace, feature: string): Run {
  const parsed = runSchema.safeParse(JSON.parse(readFileSync(statePath(ws, feature), 'utf8')));
  if (!parsed.success) throw new Error(`Corrupt factory state ${statePath(ws, feature)}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function saveRun(ws: Workspace, run: Run) {
  writeAtomic(statePath(ws, run.feature), `${JSON.stringify(run, null, 2)}\n`);
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes read-modify-write of one run's state across concurrent tool calls in this process.
 * State is saved even when `mutate` throws, so a mutation must only throw after changes it means to keep.
 */
export function withRun<T>(ws: Workspace, feature: string, mutate: (run: Run) => Promise<T> | T): Promise<T> {
  const key = statePath(ws, feature);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const run = readRun(ws, feature);
    try {
      return await mutate(run);
    } finally {
      saveRun(ws, run);
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
