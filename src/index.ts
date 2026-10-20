import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import {
  activeSlice,
  addEvent,
  findingSchema,
  forgetRun,
  readRun,
  REVIEW_DOMAINS,
  type Run,
  sliceInputSchema,
  sourceSchema,
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
  fileFactoryIssues,
  type FiledIssues,
  nextAction,
  nextSlice,
  parseRetro,
  pauseRun,
  planReslice,
  planSlices,
  recordRetro,
  recordReview,
  repoRoot,
  requireFeatureName,
  resolveStall,
  resumeRun,
  retroIssueBody,
  retroSchema,
  runChecks,
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
  'factory_checks',
  'factory_review_start',
  'factory_review_record',
  'factory_complete_slice',
  'factory_status',
  'factory_retro',
];
/** Stop attempts in a row without new run events; the last one pauses the run instead of blocking. */
export const MAX_IDLE_STOP_ATTEMPTS = 3;

type Caller = 'main' | typeof REVIEWER | typeof VALIDATOR;

const startSchema = z.object({
  feature: z.string().optional().describe('kebab-case run name for a new run'),
  resume: z.string().optional().describe('Feature name of an existing run to resume instead of starting one'),
  source: sourceSchema.optional().describe('The loaded issue, required for a new run'),
});
const planSchema = z.object({ slices: z.array(sliceInputSchema) });
const seamsSchema = z.object({ seams: z.array(z.string().min(1)).min(1).describe('Seams the user agreed, as public interfaces') });
const submitSchema = z.object({ domain: z.enum(REVIEW_DOMAINS), findings: z.array(findingSchema), reviewId: z.string().min(1) });
const validateSchema = validationSchema.extend({ reviewId: z.string().min(1) });
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
        run = await startRun(ws, { feature: params.feature, sessionId, source: params.source });
      }
      activeRuns.set(ws.root, run.feature);
      await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ORCHESTRATION_TOOLS])]);
      return reply(
        `Run "${run.feature}" is ${run.status}. Checks: ${ws.config.checks.join(', ')}. Slice budget: ${ws.config.sliceTokenBudget} tokens. Fix rounds per slice: ${ws.config.maxRounds}.\nNext: ${nextAction(run)}`,
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
    schema: planSchema,
    async run(params, ws, ctx) {
      const feature = activeFeature(ws);
      const slices = planSlices(ws, readRun(ws, feature), params.slices);
      if (!(await confirm(ctx, `Approve ${slices.length} slices for "${feature}"?`, planSummary(slices)))) {
        return reply('The user rejected the plan. Ask what to change, then call factory_plan again.');
      }
      const run = await withRun(ws, feature, current => {
        approvePlan(ws, current, planSlices(ws, current, params.slices));
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
          `Slice ${slice.id} "${slice.title}" on ${slice.branch} (phase ${slice.phase}).\nTicket: ${ticketPath(ws, run.feature, slice)}\nChecks: ${ws.config.checks.join('; ')}\nContext budget: ${ws.config.sliceTokenBudget} tokens.\nNext: ${nextAction(run)}`,
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
      if (result.passed) return reply(`All checks passed.\n${summary}\nNext: ${nextAction(run)}`);
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`Checks failed.\n${summary}\nFix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Freeze the reviewed state and write the review data file. Then spawn one factory-reviewer per domain.',
    label: 'Factory: start review',
    name: 'factory_review_start',
    schema: emptySchema,
    async run(_params, ws) {
      return withRun(ws, activeFeature(ws), async run => {
        const review = await startReview(ws, run);
        return reply(
          `Review ${review.reviewId} is open.\nData file: ${review.dataFile}\nReference dir: ${review.referenceDir}\nFindings dir: ${review.findingsDir}\nSpawn one ${REVIEWER} per domain, in one task batch: ${review.domains.join(', ')}. Give each its domain, the review id, the data file, and the reference file <reference dir>/<domain>.md. When all have submitted, spawn one ${VALIDATOR} with the review id, the data file, and the findings dir, then call factory_review_record.`,
          review,
        );
      });
    },
  });

  tool({
    caller: REVIEWER,
    description: 'Submit your domain findings for the active review. Call once, with an empty list when you found nothing.',
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
    description: 'Submit the validation: keep the substantiated finding ids, drop the rest with reasons.',
    label: 'Factory: submit validation',
    name: 'factory_review_validate',
    schema: validateSchema,
    async run(params, ws, ctx) {
      const result = await withRun(ws, activeFeature(ws), run => submitValidation(ws, run, { ...params, agentId: ctx.agent.id }));
      return reply(`Kept ${result.kept}, dropped ${result.dropped}.`);
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
    description: 'Mark the green slice done. HEAD must be the reviewed commit.',
    label: 'Factory: complete slice',
    name: 'factory_complete_slice',
    schema: emptySchema,
    async run(_params, ws) {
      return withRun(ws, activeFeature(ws), async run => {
        const slice = await completeSlice(ws, run);
        return reply(`Slice ${slice.id} is done on ${slice.branch}.\nNext: ${nextAction(run)}`);
      });
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
    description: 'Software factory: /factory <issue> | resume <feature> | pause | status | submit [feature]',
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
          'Open draft PRs?',
          `gh stack will adopt ${run.slices.length} branches onto ${run.trunk} and open one draft PR per slice:\n${run.slices.map(slice => slice.branch).join('\n')}`,
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
