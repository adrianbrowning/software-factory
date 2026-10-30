import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONFIG_PATH, checksPrompt, loadConfig, parseChecks, suggestChecks } from './config.ts';
import { evidence } from './evidence.ts';
import {
  activeSlice,
  addEvent,
  findingSchema,
  forgetRun,
  readRun,
  REQUIRED_REVIEW_DOMAINS,
  REVIEW_DOMAINS,
  type Run,
  skippedDomainsSchema,
  sliceInputSchema,
  type Source,
  statePath,
  ticketPath,
  withRun,
  type Workspace,
} from './run.ts';
import {
  amendSeams,
  applyReslice,
  approvePlan,
  completeSlice,
  fetchGithubIssue,
  fileFactoryIssues,
  type FiledIssues,
  fileSource,
  githubSource,
  nextAction,
  nextSlice,
  parseRetro,
  pauseRun,
  planReslice,
  planSlices,
  recordDecisions,
  recordRetro,
  recordReview,
  reopenSlice,
  repoChecks,
  repoRoot,
  requireFeatureName,
  resolveBase,
  resolveStall,
  resumeRun,
  retroIssueBody,
  retroSchema,
  runChecks,
  saveChecks,
  sourceInputSchema,
  type SourceInput,
  startReview,
  startRun,
  submitDomain,
  submitStack,
  submitValidation,
  summarize,
  validationSchema,
} from './workflow.ts';

const IMPLEMENTER = 'factory-implementer';
const REVIEWER = 'factory-reviewer';
const VALIDATOR = 'factory-review-validator';
const DEFAULT_FACTORY_REPO = 'adrianbrowning/software-factory';
/** Tools `factory_start` activates; they stay out of every other session's tool list. */
const ORCHESTRATION_TOOLS = [
  'factory_plan',
  'factory_next',
  'factory_reslice',
  'factory_amend_seams',
  'factory_decide',
  'factory_checks',
  'factory_review_start',
  'factory_review_record',
  'factory_complete_slice',
  'factory_reopen',
  'factory_status',
  'factory_retro',
];
/** Stop attempts in a row without new run events; the last one pauses the run instead of blocking. */
export const MAX_IDLE_STOP_ATTEMPTS = 3;

type Caller = 'main' | typeof REVIEWER | typeof VALIDATOR;

const startSchema = z.object({
  feature: z.string().optional().describe('kebab-case run name for a new run'),
  resume: z.string().optional().describe('Feature name of an existing run to resume instead of starting one'),
  source: sourceInputSchema.optional().describe('The issue, required for a new run: github or file by ref (the tool loads it), jira or text in full'),
});
const decisionsSchema = z.object({
  decisions: z.array(z.string().min(1)).min(1).describe('Decisions the user made, each one self-contained sentence'),
});
const planSchema = z.object({ slices: z.array(sliceInputSchema) });
const planToolSchema = planSchema.extend({
  baseRef: z
    .string()
    .min(1)
    .optional()
    .describe('Only when the user chose it: the unmerged branch this work builds on. Slice 01 stacks on it'),
  landOn: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only when the user asked for no new PR branch: an existing local branch that /factory submit fast-forwards to the top slice instead of opening PRs. It is the base when baseRef is omitted',
    ),
  trunk: z.string().min(1).optional().describe('Branch the stack PRs target; defaults to baseRef without its remote'),
});
const seamsSchema = z.object({ seams: z.array(z.string().min(1)).min(1).describe('Seams the user agreed, as public interfaces') });
const reviewStartSchema = z.object({
  keep: z
    .array(z.enum(REVIEW_DOMAINS))
    .optional()
    .describe('Domains to review although the factory path rules skip them (react-ts, test-validity, devops), for a changed file the rules miss'),
  skip: skippedDomainsSchema.describe(
    'Required choice: further domains this diff gives nothing to review (for example performance for a diff with no runtime hot path), each with a reason. The factory already skips react-ts, test-validity, and devops when no changed path could hold their subject. An empty list adds no skips.',
  ),
});
const submitSchema = z.object({ domain: z.enum(REVIEW_DOMAINS), findings: z.array(findingSchema), reviewId: z.string().min(1) });
const validateSchema = validationSchema.extend({ reviewId: z.string().min(1) });
const reopenSchema = z.object({
  reason: z.string().min(1).describe('The bug found in the done slice, as the fix file for its implementer'),
  slice: z.string().regex(/^\d{2}$/).describe('Id of the done slice, for example "04"'),
});
const emptySchema = z.object({});

export function callerOf(ctx: Pick<ExtensionContext, 'agent'>) {
  return ctx.agent.kind === 'main' ? 'main' : ctx.agent.name;
}

/** Active run per repository root. Module scope is shared by the main session and its subagents in one process. */
const activeRuns = new Map<string, string>();
const stopAttempts = new Map<string, { count: number; events: number }>();
const roots = new Map<string, string>();

async function workspace(cwd: string): Promise<Workspace> {
  let root = roots.get(cwd);
  if (root === undefined) {
    root = await repoRoot(cwd);
    roots.set(cwd, root);
  }
  return { config: loadConfig(root), root };
}

function activeFeature(ws: Workspace) {
  const feature = activeRuns.get(ws.root);
  if (feature === undefined) throw new Error('No active factory run. Start one with /factory <issue>, or /factory resume <feature>.');
  return feature;
}

type Reply = { content: { text: string; type: 'text' }[]; details: unknown };

function reply(text: string, details?: unknown): Reply {
  return { content: [{ text, type: 'text' }], details };
}

async function confirm(ctx: ExtensionContext, title: string, body: string) {
  if (!ctx.hasUI) throw new Error(`${title} needs the interactive UI.`);
  return ctx.ui.confirm(title, body);
}

/** The run source. The tool loads GitHub and file issues itself; the user decides on GitHub text from outside the repository. */
async function loadSource(ctx: ExtensionContext, ws: Workspace, input: SourceInput): Promise<Source> {
  if (input.kind === 'file') return fileSource(ws, input.ref);
  if (input.kind !== 'github') return input;
  return githubSource(input.ref, await fetchGithubIssue(ws, input.ref), outside =>
    confirm(
      ctx,
      `Use ${outside.length} parts of the issue written outside the repository?`,
      `These authors are not repository collaborators. Yes uses their text as evidence for the run; No leaves it out.\n\n${outside.map(part => `@${part.author} (${part.association}):\n${evidence(part.text, 1_000)}`).join('\n\n')}`,
    ),
  );
}

/** Shows the check dialog: the repository's current checks (or the default ones) chosen, other suggestions commented out. */
async function chooseChecks(ctx: ExtensionContext, ws: Workspace) {
  if (!ctx.hasUI) throw new Error('Choosing the checks needs the interactive UI.');
  const suggestions = suggestChecks(ws.root, ws.config);
  const current = repoChecks(ws);
  const chosen = current.length === 0 ? suggestions.chosen : current;
  const prompt = checksPrompt({
    chosen,
    scripts: suggestions.scripts.filter(command => !chosen.includes(command)),
    workflows: suggestions.workflows.filter(command => !chosen.includes(command)),
  });
  const text = await ctx.ui.editor('Checks for this repository (one command per line)', prompt);
  return text === undefined ? undefined : parseChecks(text);
}

/** The first run in a repository asks the user for its checks and saves them; later runs reuse them. */
async function ensureChecks(ctx: ExtensionContext, ws: Workspace) {
  if (repoChecks(ws).length > 0) return;
  for (;;) {
    const checks = await chooseChecks(ctx, ws);
    if (checks === undefined) throw new Error('The user cancelled the checks dialog. Every run needs at least one check: ask which checks to run, then call factory_start again.');
    if (checks.length > 0) return saveChecks(ws, checks);
    ctx.ui.notify('Every run needs at least one check. Type at least one command, or cancel.', 'warning');
  }
}

/** Asks the user how to continue once a slice's fix budget is used up. Without a UI the run pauses. */
async function decideStall(ctx: ExtensionContext, ws: Workspace, feature: string) {
  const run = readRun(ws, feature);
  const slice = activeSlice(run);
  if (slice === undefined || !slice.stalled) return '';
  const more = `Continue: ${ws.config.maxRounds} more fix rounds`;
  const choice = ctx.hasUI
    ? await ctx.ui.select(`Slice ${slice.id} "${slice.title}" is not green after ${slice.roundLimit} fix rounds`, [
        { description: 'The loop keeps fixing and re-reviewing.', label: more },
        { description: 'Stop here; /factory resume continues later.', label: 'Pause the run' },
      ])
    : undefined;
  const status = await withRun(ws, feature, current => {
    resolveStall(ws, current, choice === more ? 'continue' : 'pause');
    return current.status;
  });
  return status === 'stalled'
    ? '\nThe user paused the run. Run the retro now (skill://retro, then factory_retro) so this stall improves future runs, then stop.'
    : `\nThe user allowed ${ws.config.maxRounds} more fix rounds.`;
}

function planSummary(slices: Run['slices']) {
  return slices
    .map(
      slice =>
        `${slice.id}. ${slice.title}\n   blocked by: ${slice.blockedBy.join('; ') || 'none'}\n   seams: ${slice.seams.join('; ') || `none (${slice.noTestReason})`}\n   ~${slice.estimateTokens} tokens`,
    )
    .join('\n');
}

/** Stop gate: block a stop while the owner session's run is running, and pause it after repeated idle stops. */
export function stopDecision(run: Run, sessionId: string, previous: { count: number; events: number } | undefined) {
  if (run.ownerSessionId !== sessionId || run.status !== 'running') return { action: 'allow' as const };
  const count = previous?.events === run.events.length ? previous.count + 1 : 1;
  if (count >= MAX_IDLE_STOP_ATTEMPTS) return { action: 'pause' as const };
  return { action: 'block' as const, attempts: { count, events: run.events.length } };
}

export default function softwareFactory(pi: ExtensionAPI) {
  pi.setLabel('Software Factory');

  /** Registers a tool whose parameters are the JSON Schema of `schema`; `schema` is also the only runtime parse. */
  function tool<S extends z.ZodType>(definition: {
    caller: Caller;
    description: string;
    essential?: boolean;
    label: string;
    name: string;
    schema: S;
    run: (input: z.infer<S>, ws: Workspace, ctx: ExtensionContext, signal: AbortSignal | undefined) => Promise<Reply>;
  }) {
    pi.registerTool({
      defaultInactive: definition.essential !== true,
      description: definition.description,
      label: definition.label,
      loadMode: 'essential',
      name: definition.name,
      parameters: z.toJSONSchema(definition.schema) as Record<string, unknown>,
      async execute(_id, raw, signal, _onUpdate, ctx) {
        const caller = callerOf(ctx);
        if (caller !== definition.caller) throw new Error(`Only the ${definition.caller} agent may call this tool (caller: ${caller}).`);
        const parsed = definition.schema.safeParse(raw);
        if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
        return definition.run(parsed.data, await workspace(ctx.cwd), ctx, signal);
      },
    });
  }

  tool({
    caller: 'main',
    description: 'Start a software-factory run for a loaded issue (feature + source), or resume one (resume). Read skill://software-factory first.',
    essential: true,
    label: 'Factory: start',
    name: 'factory_start',
    schema: startSchema,
    async run(params, ws, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      let run: Run;
      if (params.resume !== undefined) {
        const feature = requireFeatureName(params.resume);
        if (!existsSync(statePath(ws, feature))) throw new Error(`No run named "${feature}".`);
        forgetRun(ws, feature);
        const current = readRun(ws, feature);
        if (current.status === 'paused' || current.status === 'stalled') {
          if (!(await confirm(ctx, 'Resume software factory run', `Resume "${feature}" (${current.status})?`))) {
            throw new Error(`The user kept "${feature}" ${current.status}.`);
          }
        }
        if (current.checks.length === 0) await ensureChecks(ctx, ws);
        run = await withRun(ws, feature, latest => {
          resumeRun(ws, latest, sessionId);
          return latest;
        });
      } else {
        if (params.feature === undefined || params.source === undefined) throw new Error('A new run needs feature and source.');
        const current = activeRuns.get(ws.root);
        if (current !== undefined && readRun(ws, current).status === 'running') {
          throw new Error(`Run "${current}" is still running in this repository. Finish or /factory pause it first.`);
        }
        const source = await loadSource(ctx, ws, params.source);
        await ensureChecks(ctx, ws);
        run = await startRun(ws, { feature: params.feature, sessionId, source });
      }
      activeRuns.set(ws.root, run.feature);
      await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ORCHESTRATION_TOOLS])]);
      return reply(
        `Run "${run.feature}" is ${run.status}. Checks: ${run.checks.join('; ')}. Slice budget: ${ws.config.sliceTokenBudget} tokens. Fix rounds per slice: ${ws.config.maxRounds}.\nNext: ${nextAction(run)}`,
        summarize(ws, run),
      );
    },
  });

  tool({
    caller: 'main',
    description:
      'Propose the tracer-bullet slices. The user approves or rejects them in a dialog. Each slice must fit the context budget and name its test seams.',
    label: 'Factory: plan',
    name: 'factory_plan',
    schema: planToolSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const base = await resolveBase(ws, { baseRef: params.baseRef, landOn: params.landOn, trunk: params.trunk });
      const slices = planSlices(ws, readRun(ws, feature), params.slices, base);
      const target = base.landOn === undefined ? `PRs target ${base.trunk}` : `/factory submit fast-forwards ${base.landOn} to the top slice; no PRs`;
      const where = `Slice 01 branches from ${base.baseRef} (${base.baseSha.slice(0, 12)}); ${target}.`;
      if (!(await confirm(ctx, `Approve ${slices.length} slices for "${feature}"?`, `${where}\n\n${planSummary(slices)}`))) {
        return reply('The user rejected the plan. Ask what to change, then call factory_plan again.');
      }
      const run = await withRun(ws, feature, current => {
        approvePlan(ws, current, planSlices(ws, current, params.slices, base), base);
        return current;
      });
      return reply(`Plan approved. Tickets are in ${join(ws.config.scratchDir, feature, 'issues')}.\nNext: ${nextAction(run)}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Check out the next slice branch (or return the active slice) and get its ticket.',
    label: 'Factory: next slice',
    name: 'factory_next',
    schema: emptySchema,
    async run(_params, ws) {
      return withRun(ws, activeFeature(ws), async run => {
        const slice = await nextSlice(ws, run);
        if (slice === undefined) return reply(`No slices left.\nNext: ${nextAction(run)}`);
        return reply(
          `Slice ${slice.id} "${slice.title}" on ${slice.branch} (phase ${slice.phase}).\nTicket: ${ticketPath(ws, run.feature, slice)}\nChecks: ${run.checks.join('; ')}\nContext budget: ${ws.config.sliceTokenBudget} tokens.\nNext: ${nextAction(run)}`,
        );
      });
    },
  });

  tool({
    caller: 'main',
    description:
      'Split the active slice into smaller vertical slices when it outgrows the context budget. The user approves the split; committed work carries into the first child.',
    label: 'Factory: re-slice',
    name: 'factory_reslice',
    schema: planSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const run = readRun(ws, feature);
      const { children, slices } = planReslice(ws, run, params.slices);
      const active = activeSlice(run);
      const remaining = slices.slice(active === undefined ? 0 : run.slices.indexOf(active));
      if (!(await confirm(ctx, `Split slice ${active?.id} into ${children.length} slices?`, planSummary(remaining)))) {
        return reply('The user rejected the split. Ask what to change, then call factory_reslice again.');
      }
      return withRun(ws, feature, async current => {
        const first = await applyReslice(ws, current, planReslice(ws, current, params.slices).slices);
        return reply(`Now on slice ${first.id} "${first.title}" (${first.branch}).\nNext: ${nextAction(current)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description:
      'Record decisions the user made (accepted tradeoffs, out-of-scope work). The user confirms them; every later ticket and review data file lists them.',
    label: 'Factory: record decisions',
    name: 'factory_decide',
    schema: decisionsSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      if (!(await confirm(ctx, 'Record these decisions for reviewers?', params.decisions.map(decision => `- ${decision}`).join('\n')))) {
        return reply('The user rejected these decisions. Ask how to word them.');
      }
      const decisions = await withRun(ws, feature, run => recordDecisions(ws, run, params.decisions));
      return reply(`Decisions recorded (${decisions.length} in total). Reviews from now on include them.`);
    },
  });

  tool({
    caller: 'main',
    description: 'Add test seams the user agreed for the active slice (tdd skill: tests only at agreed seams).',
    label: 'Factory: amend seams',
    name: 'factory_amend_seams',
    schema: seamsSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const slice = activeSlice(readRun(ws, feature));
      if (slice === undefined) throw new Error('No active slice. Call factory_next.');
      if (!(await confirm(ctx, `Add test seams to slice ${slice.id}?`, params.seams.map(seam => `- ${seam}`).join('\n')))) {
        return reply('The user rejected these seams. Ask which seams to use.');
      }
      return withRun(ws, feature, run => {
        const amended = amendSeams(ws, run, params.seams);
        return reply(`Slice ${amended.id} seams: ${amended.seams.join('; ')}.\nTicket updated: ${ticketPath(ws, run.feature, amended)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description: 'Run every configured check on the committed slice. Failures produce a fix file for the implementer.',
    label: 'Factory: checks',
    name: 'factory_checks',
    schema: emptySchema,
    async run(_params, ws, ctx, signal) {
      const feature = activeFeature(ws);
      const result = await withRun(ws, feature, run => runChecks(ws, run, signal));
      const summary = result.summary.join('\n');
      const run = readRun(ws, feature);
      const commits = `Slice commits:\n${result.commits}`;
      const unchanged = result.unchanged
        ? '\nNo new commits since the fix file. The implementer report should explain, for each item, why no change was needed.'
        : '';
      if (result.passed) {
        const byPath = result.pathSkipped.length === 0 ? '' : `\nPath rules skip: ${result.pathSkipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ')}. Pass a domain in factory_review_start keep when a changed file holds its subject after all.`;
        return reply(`All checks passed.\n${summary}\n${commits}${unchanged}\nChanged files:\n${result.changed}${byPath}\nNext: ${nextAction(run)}`);
      }
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`Checks failed.\n${summary}\n${commits}${unchanged}\nFix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description: `Freeze the reviewed state and write the review data file. Then spawn one factory-reviewer per domain. The factory skips react-ts, test-validity, and devops by changed paths unless kept; skip any other domain the diff gives nothing to review, with a reason. ${REQUIRED_REVIEW_DOMAINS.join(' and ')} always review, and testing does too for a slice with test seams.`,
    label: 'Factory: start review',
    name: 'factory_review_start',
    schema: reviewStartSchema,
    async run(params, ws) {
      return withRun(ws, activeFeature(ws), async run => {
        const review = await startReview(ws, run, params.skip, params.keep);
        const byPath = review.pathSkipped.length === 0 ? '' : `\nSkipped by path: ${review.pathSkipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ')}.`;
        return reply(
          `Review ${review.reviewId} is open.${byPath}\nData file: ${review.dataFile}\nReference dir: ${review.referenceDir}\nFindings dir: ${review.findingsDir}\nSpawn one ${REVIEWER} per domain, in one task batch: ${review.domains.join(', ')}. Give each its domain, the review id, the data file, and the reference file <reference dir>/<domain>.md. When all have submitted, spawn one ${VALIDATOR} with the review id, the data file, and the findings dir. Wait until it has finished (it may correct its validation once), then call factory_review_record.`,
          review,
        );
      });
    },
  });

  tool({
    caller: REVIEWER,
    description:
      'Submit your domain findings for the active review, with an empty list when you found nothing. One more call replaces them once (for a late correction), until validation.',
    label: 'Factory: submit review findings',
    name: 'factory_review_submit',
    schema: submitSchema,
    async run(params, ws, ctx) {
      const count = await withRun(ws, activeFeature(ws), run => submitDomain(ws, run, { ...params, agentId: ctx.agent.id }));
      return reply(`Recorded ${count} ${params.domain} findings for ${params.reviewId}.`);
    },
  });

  tool({
    caller: VALIDATOR,
    description:
      'Submit the validation: keep the substantiated finding ids, downgrade or escalate with reasons, drop the rest with reasons. One more call replaces it once (to correct the verdict), until the review is recorded.',
    label: 'Factory: submit validation',
    name: 'factory_review_validate',
    schema: validateSchema,
    async run(params, ws, ctx) {
      const result = await withRun(ws, activeFeature(ws), run => submitValidation(ws, run, { ...params, agentId: ctx.agent.id }));
      const action = result.replaced ? 'Replaced the validation' : 'Recorded the validation';
      return reply(
        `${action}: kept ${result.kept}, downgraded ${result.downgraded} to observations, escalated ${result.escalated} to high, dropped ${result.dropped}.`,
      );
    },
  });

  tool({
    caller: 'main',
    description: 'Gate the slice on the validated review: green when no critical or high findings remain.',
    label: 'Factory: record review',
    name: 'factory_review_record',
    schema: emptySchema,
    async run(_params, ws, ctx) {
      const feature = activeFeature(ws);
      const result = await withRun(ws, feature, run => recordReview(ws, run));
      if (result.green) {
        const notes = result.observations.length > 0 ? `\nObservations (non-blocking):\n${result.observations.join('\n\n')}` : '';
        return reply(`Review is green.${notes}\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`${result.blocking} blocking findings. Fix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Mark the green slice done. HEAD must be the reviewed commit. A reopened slice rebases every later slice branch onto its fix.',
    label: 'Factory: complete slice',
    name: 'factory_complete_slice',
    schema: emptySchema,
    async run(_params, ws) {
      return withRun(ws, activeFeature(ws), async run => {
        const reopened = activeSlice(run)?.doneSha !== undefined;
        const slice = await completeSlice(ws, run);
        const restacked = reopened ? ' Every later slice branch is rebased onto it and earns its checks and review again.' : '';
        return reply(`Slice ${slice.id} is done on ${slice.branch}.${restacked}\nNext: ${nextAction(run)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description:
      'Reopen a done slice to fix a bug found in it, after the user agreed. The fix goes into that slice; completing it rebases every later slice onto the fix, and those slices earn their checks and review again.',
    label: 'Factory: reopen slice',
    name: 'factory_reopen',
    schema: reopenSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const target = readRun(ws, feature).slices.find(slice => slice.id === params.slice);
      // Anything but a done slice is refused by reopenSlice, without a dialog.
      if (target?.status === 'done') {
        const body = `${params.reason}\n\nThe active slice goes back to pending with its commits. When slice ${target.id} is done again, every later slice branch is rebased onto the fix and earns its checks and review again. The run needs a new retro before /factory submit.`;
        if (!(await confirm(ctx, `Reopen slice ${target.id} "${target.title}"?`, body))) {
          return reply(`The user kept slice ${target.id} done. Ask how to handle the bug.`);
        }
      }
      const result = await withRun(ws, feature, run => reopenSlice(ws, run, params.slice, params.reason));
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(
        `Slice ${result.slice.id} "${result.slice.title}" is reopened on ${result.slice.branch}. Fix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`,
      );
    },
  });

  tool({
    caller: 'main',
    description: 'Show the run: slices, phases, fix rounds, peak implementer context, recent events, next action.',
    label: 'Factory: status',
    name: 'factory_status',
    schema: emptySchema,
    async run(_params, ws) {
      const summary = summarize(ws, readRun(ws, activeFeature(ws)));
      return reply(JSON.stringify(summary, null, 2), summary);
    },
  });

  tool({
    caller: 'main',
    description:
      'Record the retro the user agreed. apply findings become a final slice; file-issue findings become issues on the factory repository.',
    label: 'Factory: retro',
    name: 'factory_retro',
    schema: retroSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const retro = parseRetro(ws, readRun(ws, feature), params.findings);
      let filed: FiledIssues = { urls: {} };
      if (retro.apply.length > 0 || retro.file.length > 0) {
        const repo = ws.config.factoryRepo;
        const plan = [
          ...(retro.apply.length > 0 ? ['Final slice applying to this repository:', ...retro.apply.map(finding => `- ${finding.title}`), ''] : []),
          ...(retro.file.length > 0
            ? [
                `Issues on ${repo}${repo === DEFAULT_FACTORY_REPO ? '' : ` (configured in .omp/factory.json, not the default ${DEFAULT_FACTORY_REPO})`}, posted exactly as shown:`,
                ...retro.file.map(finding => `\n## ${finding.title}\n${retroIssueBody(finding)}`),
              ]
            : []),
        ];
        if (!(await confirm(ctx, 'Record the retro with these actions?', plan.join('\n')))) {
          throw new Error('The user declined these retro actions. Ask which to change, then call factory_retro again.');
        }
        filed = await fileFactoryIssues(ws, retro.file);
      }
      return withRun(ws, feature, run => {
        const slice = recordRetro(ws, run, retro, filed);
        const lines = [`Retro written to ${join(ws.config.scratchDir, feature, 'retro.md')}.`];
        if (slice !== undefined) lines.push(`Added slice ${slice.id} "${slice.title}".`);
        lines.push(...Object.values(filed.urls));
        if (filed.error !== undefined) lines.push(`Filing stopped: ${filed.error}. Unfiled findings are marked in retro.md.`);
        lines.push(`Next: ${nextAction(run)}`);
        return reply(lines.join('\n'));
      });
    },
  });

  pi.registerCommand('factory', {
    description: 'Software factory: /factory <issue> | resume <feature> | pause | status | checks | submit [feature]',
    async handler(args, ctx) {
      const [verb = '', ...rest] = args.trim().split(/\s+/);
      const argument = rest.join(' ');
      const ws = await workspace(ctx.cwd);
      if (verb === '' || verb === 'status') {
        const feature = activeRuns.get(ws.root);
        const runsDir = join(ws.root, ws.config.scratchDir);
        const known = existsSync(runsDir) ? readdirSync(runsDir).filter(name => existsSync(statePath(ws, name))) : [];
        const active = feature === undefined ? 'none' : `${feature}: ${nextAction(readRun(ws, feature))}`;
        ctx.ui.notify(`Active run: ${active}\nRuns: ${known.join(', ') || 'none'}`, 'info');
        return;
      }
      if (verb === 'checks') {
        if (ws.config.checks !== undefined) {
          ctx.ui.notify(`Checks come from "checks" in ${CONFIG_PATH}: ${ws.config.checks.join('; ')}. Edit that file to change them.`, 'info');
          return;
        }
        const checks = await chooseChecks(ctx, ws);
        if (checks === undefined || checks.length === 0) {
          ctx.ui.notify(`Checks unchanged: ${repoChecks(ws).join('; ') || 'none chosen'}.`, 'info');
          return;
        }
        await saveChecks(ws, checks);
        ctx.ui.notify(`Saved checks: ${checks.join('; ')}. New runs use them; a run that already started keeps its checks.`, 'info');
        return;
      }
      if (verb === 'pause') {
        const feature = activeFeature(ws);
        await withRun(ws, feature, run => pauseRun(run, 'user paused the run'));
        ctx.ui.notify(`Paused "${feature}".`, 'info');
        return;
      }
      if (verb === 'resume') {
        const feature = requireFeatureName(argument);
        pi.sendUserMessage(`Resume software-factory run "${feature}": read skill://software-factory, call factory_start with resume "${feature}", then continue from its next action.`);
        return;
      }
      if (verb === 'submit') {
        const feature = requireFeatureName(argument || activeFeature(ws));
        const run = readRun(ws, feature);
        const ok = await ctx.ui.confirm(
          run.landOn === undefined ? 'Open draft PRs?' : `Fast-forward ${run.landOn}?`,
          run.landOn === undefined
            ? `gh stack will adopt ${run.slices.length} branches onto ${run.trunk} and open one draft PR per slice:\n${run.slices.map(slice => slice.branch).join('\n')}`
            : `${run.landOn} will fast-forward to ${run.slices.at(-1)?.branch} (${run.slices.length} slices). No PRs are opened and your checkout is not changed.`,
        );
        if (!ok) return;
        const output = await withRun(ws, feature, current => submitStack(ws, current));
        ctx.ui.notify(output.trim() || 'Stack submitted.', 'info');
        return;
      }
      pi.sendUserMessage(`Start a software-factory run for: ${args.trim()}\nRead skill://software-factory and follow it.`);
    },
  });

  pi.on('session_stop', async (event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    let ws: Workspace;
    try {
      ws = await workspace(ctx.cwd);
    } catch {
      return;
    }
    const feature = activeRuns.get(ws.root);
    if (feature === undefined) return;
    const run = readRun(ws, feature);
    const decision = stopDecision(run, event.session_id, stopAttempts.get(feature));
    if (decision.action === 'allow') return;
    if (decision.action === 'pause') {
      stopAttempts.delete(feature);
      await withRun(ws, feature, current => pauseRun(current, `no progress after ${MAX_IDLE_STOP_ATTEMPTS} stop attempts`));
      ctx.ui.notify(`Software factory paused "${feature}": no progress. /factory resume ${feature} continues.`, 'warning');
      return;
    }
    stopAttempts.set(feature, decision.attempts);
    return { decision: 'block', reason: `Software factory run "${feature}" is not finished. Next: ${nextAction(run)}` };
  });

  /** Measures each implementer's context so the retro can see slices that outgrew the budget. */
  async function trackImplementer(ctx: ExtensionContext, compacted: boolean) {
    if (ctx.agent.kind !== 'sub' || ctx.agent.name !== IMPLEMENTER) return;
    const ws = await workspace(ctx.cwd);
    const feature = activeRuns.get(ws.root);
    if (feature === undefined) return;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    const peak = activeSlice(readRun(ws, feature))?.peakContextTokens;
    if (peak === undefined || (!compacted && tokens <= peak)) return;
    await withRun(ws, feature, run => {
      const slice = activeSlice(run);
      if (slice === undefined) return;
      slice.peakContextTokens = Math.max(slice.peakContextTokens, tokens);
      if (compacted) {
        slice.compactions += 1;
        addEvent(run, 'compaction', `implementer compacted at ${tokens} tokens`, slice);
      }
    });
  }

  pi.on('turn_end', async (_event, ctx) => trackImplementer(ctx, false));
  pi.on('auto_compaction_start', async (_event, ctx) => trackImplementer(ctx, true));
}
