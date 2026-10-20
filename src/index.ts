import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { activeSlice, addEvent, readRun, REVIEW_DOMAINS, type Run, statePath, ticketPath, withRun, type Workspace } from './run.ts';
import {
  amendSeams,
  appendSlice,
  applyReslice,
  approvePlan,
  completeSlice,
  fileFactoryIssues,
  nextAction,
  nextSlice,
  planReslice,
  planSlices,
  parseRetro,
  RETRO_CATEGORIES,
  recordRetro,
  recordReview,
  repoRoot,
  resolveStall,
  retroSlice,
  runChecks,
  settle,
  startReview,
  startRun,
  submitDomain,
  submitStack,
  submitValidation,
  summarize,
} from './workflow.ts';

const IMPLEMENTER = 'factory-implementer';
const REVIEWER = 'factory-reviewer';
const VALIDATOR = 'factory-review-validator';
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
/** Stop attempts with no new run events before the gate gives up and pauses the run. */
const MAX_IDLE_STOP_BLOCKS = 3;

/** Active run per repository root. Module scope is shared by the main session and its subagents in one process. */
const activeRuns = new Map<string, string>();
const stopBlocks = new Map<string, { count: number; events: number }>();

async function workspace(cwd: string): Promise<Workspace> {
  const root = await repoRoot(cwd);
  return { config: loadConfig(root), root };
}

function activeFeature(ws: Workspace) {
  const feature = activeRuns.get(ws.root);
  if (feature === undefined) throw new Error('No active factory run. Start one with /factory <issue>, or /factory resume <feature>.');
  return feature;
}

function requireAgent(ctx: ExtensionContext, expected: 'main' | typeof REVIEWER | typeof VALIDATOR) {
  const actual = ctx.agent.kind === 'main' ? 'main' : ctx.agent.name;
  if (actual !== expected) throw new Error(`Only the ${expected} agent may call this tool (caller: ${actual}).`);
}

function reply(text: string, details?: unknown) {
  return { content: [{ text, type: 'text' as const }], details };
}

/** Asks the user how to continue once a slice's fix budget is used up. Without a UI the run pauses. */
async function decideStall(ctx: ExtensionContext, ws: Workspace, run: Run) {
  const slice = activeSlice(run);
  if (slice === undefined || !slice.stalled) return '';
  const more = `Continue: ${ws.config.maxRounds} more fix rounds`;
  const choice = ctx.hasUI
    ? await ctx.ui.select(`Slice ${slice.id} "${slice.title}" is not green after ${slice.roundLimit} fix rounds`, [
        { description: 'The loop keeps fixing and re-reviewing.', label: more },
        { description: 'Stop here; /factory resume continues later.', label: 'Pause the run' },
      ])
    : undefined;
  resolveStall(ws, run, choice === more ? 'continue' : 'pause');
  return run.status === 'stalled'
    ? '\nThe user paused the run. Run the retro now (skill://retro, then factory_retro) so this stall improves future runs, then stop.'
    : `\nThe user allowed ${ws.config.maxRounds} more fix rounds.`;
}

function planSummary(run: Run) {
  return run.slices
    .map(
      slice =>
        `${slice.id}. ${slice.title}\n   blocked by: ${slice.blockedBy.join('; ') || 'none'}\n   seams: ${slice.seams.join('; ') || `none (${slice.noTestReason})`}\n   ~${slice.estimateTokens} tokens`,
    )
    .join('\n');
}

export default function softwareFactory(pi: ExtensionAPI) {
  const z = pi.zod;
  pi.setLabel('Software Factory');

  const findingSchema = z.object({
    domain: z.enum(REVIEW_DOMAINS).describe('Your review domain'),
    fix: z.string().describe('How to fix it'),
    fix_prompt: z.string().describe('Plain-text prompt an implementer can act on directly'),
    id: z.string().describe('Stable id: {domain}-{kebab-case-title}, no line numbers'),
    line: z.number().int().optional().describe('New-file line number on the + side of the diff; omit for file-level findings'),
    path: z.string().describe('Repo-relative path as in the diff header'),
    problem: z.string().describe('What is wrong and why it matters'),
    severity: z.enum(['critical', 'high', 'observation']),
    title: z.string(),
  });
  const sliceSchema = z.object({
    acceptance: z.array(z.string()).describe('Checkable acceptance criteria'),
    blockedBy: z.array(z.string()).describe('Titles of slices that must finish first'),
    estimateTokens: z.number().int().describe('Estimated implementer context tokens for the whole slice'),
    noTestReason: z.string().optional().describe('Only when seams is empty: why the slice has nothing to test'),
    seams: z.array(z.string()).describe('Public interfaces the tests go through (tdd skill seams)'),
    title: z.string(),
    whatToBuild: z.string().describe('End-to-end behavior from the user perspective, not a layer list'),
  });
  const startSchema = z.object({
    feature: z.string().optional().describe('kebab-case run name for a new run'),
    resume: z.string().optional().describe('Feature name of an existing run to resume instead of starting one'),
    source: z
      .object({
        body: z.string().describe('Full issue text, including relevant comments'),
        kind: z.enum(['github', 'jira', 'file', 'text']),
        ref: z.string().describe('Issue reference as the user gave it'),
        title: z.string(),
        url: z.string().optional(),
      })
      .optional()
      .describe('The loaded issue, required for a new run'),
  });
  const planSchema = z.object({ slices: z.array(sliceSchema) });
  const seamsSchema = z.object({ seams: z.array(z.string()).describe('Seams the user agreed, as public interfaces') });
  const submitSchema = z.object({ domain: z.enum(REVIEW_DOMAINS), findings: z.array(findingSchema), reviewId: z.string() });
  const validateSchema = z.object({
    dropped: z.array(z.object({ id: z.string(), reason: z.string() })).describe('Findings removed, each with a reason'),
    keep: z.array(z.string()).describe('Ids of findings the diff substantiates'),
    reviewId: z.string(),
  });
  const retroSchema = z.object({
    findings: z.array(
      z.object({
        action: z.enum(['apply', 'file-issue', 'skip']).describe('apply: repo change in a final slice; file-issue: factory issue'),
        category: z.enum(RETRO_CATEGORIES),
        detail: z.string(),
        severity: z.enum(['high', 'medium', 'low']),
        target: z.enum(['repo', 'factory']).describe('repo: the repository worked on; factory: this plugin'),
        title: z.string(),
      }),
    ),
  });
  const empty = z.object({});

  pi.registerTool({
    description:
      'Start a software-factory run for a loaded issue (feature + source), or resume one (resume). Read skill://software-factory first.',
    label: 'Factory: start',
    loadMode: 'essential',
    name: 'factory_start',
    parameters: startSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const params = startSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      let run: Run;
      if (params.resume !== undefined) {
        const feature = params.resume;
        if (!existsSync(statePath(ws, feature))) throw new Error(`No run named "${feature}".`);
        run = await withRun(ws, feature, async current => {
          if (current.status === 'paused' || current.status === 'stalled') {
            const ok = ctx.hasUI && (await ctx.ui.confirm('Resume software factory run', `Resume "${feature}" (${current.status})?`));
            if (!ok) throw new Error(`The user kept "${feature}" ${current.status}.`);
            current.status = 'running';
            resolveStall(ws, current, 'continue');
          }
          current.ownerSessionId = sessionId;
          addEvent(current, 'resume', `session ${sessionId}`);
          return current;
        });
      } else {
        if (params.feature === undefined || params.source === undefined) throw new Error('A new run needs feature and source.');
        const current = activeRuns.get(ws.root);
        if (current !== undefined && readRun(ws, current).status !== 'done') {
          throw new Error(`Run "${current}" is still open in this repository. Finish or pause it first.`);
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

  pi.registerTool({
    defaultInactive: true,
    description:
      'Propose the tracer-bullet slices. The user approves or rejects them in a dialog. Each slice must fit the context budget and name its test seams.',
    label: 'Factory: plan',
    loadMode: 'essential',
    name: 'factory_plan',
    parameters: planSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const params = planSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const slices = planSlices(ws, run, params.slices);
        if (!ctx.hasUI) throw new Error('Plan approval needs the interactive UI.');
        const preview = { ...run, slices };
        const approved = await ctx.ui.confirm(`Approve ${slices.length} slices for "${run.feature}"?`, planSummary(preview));
        if (!approved) return reply('The user rejected the plan. Ask what to change, then call factory_plan again.');
        approvePlan(ws, run, slices);
        return reply(`Plan approved. Tickets are in ${join(ws.config.scratchDir, run.feature, 'issues')}.\nNext: ${nextAction(run)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Check out the next slice branch (or return the active slice) and get its ticket.',
    label: 'Factory: next slice',
    loadMode: 'essential',
    name: 'factory_next',
    parameters: empty,
    async execute(_id, _raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const slice = await nextSlice(ws, run);
        if (slice === undefined) return reply(`No slices left.\nNext: ${nextAction(run)}`);
        return reply(
          `Slice ${slice.id} "${slice.title}" on ${slice.branch} (phase ${slice.phase}).\nTicket: ${ticketPath(ws, run.feature, slice)}\nChecks: ${ws.config.checks.join('; ')}\nContext budget: ${ws.config.sliceTokenBudget} tokens.\nNext: ${nextAction(run)}`,
        );
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description:
      'Split the active slice into smaller vertical slices when it outgrows the context budget. The user approves the split; committed work carries into the first child.',
    label: 'Factory: re-slice',
    loadMode: 'essential',
    name: 'factory_reslice',
    parameters: planSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const params = planSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const { children, slices } = planReslice(ws, run, params.slices);
        if (!ctx.hasUI) throw new Error('Re-slice approval needs the interactive UI.');
        const active = activeSlice(run);
        const title = `Split slice ${active?.id} into ${children.length} slices?`;
        const remaining = slices.slice(active === undefined ? 0 : run.slices.indexOf(active));
        if (!(await ctx.ui.confirm(title, planSummary({ ...run, slices: remaining })))) {
          return reply('The user rejected the split. Ask what to change, then call factory_reslice again.');
        }
        const first = await applyReslice(ws, run, slices);
        return reply(`Now on slice ${first.id} "${first.title}" (${first.branch}).\nNext: ${nextAction(run)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Add test seams the user agreed for the active slice (tdd skill: tests only at agreed seams).',
    label: 'Factory: amend seams',
    loadMode: 'essential',
    name: 'factory_amend_seams',
    parameters: seamsSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const params = seamsSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        if (!ctx.hasUI) throw new Error('Seam approval needs the interactive UI.');
        const slice = activeSlice(run);
        if (!(await ctx.ui.confirm(`Add test seams to slice ${slice?.id}?`, params.seams.map(seam => `- ${seam}`).join('\n')))) {
          return reply('The user rejected these seams. Ask which seams to use.');
        }
        const amended = amendSeams(ws, run, params.seams);
        return reply(`Slice ${amended.id} seams: ${amended.seams.join('; ')}.\nTicket updated: ${ticketPath(ws, run.feature, amended)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Run every configured check on the committed slice. Failures produce a fix file for the implementer.',
    label: 'Factory: checks',
    loadMode: 'essential',
    name: 'factory_checks',
    parameters: empty,
    async execute(_id, _raw, signal, onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      onUpdate?.(reply(`Running ${ws.config.checks.join(' → ')}`));
      return withRun(ws, activeFeature(ws), async run => {
        if (signal?.aborted) throw new Error('Cancelled');
        const result = await runChecks(ws, run);
        const summary = result.summary.join('\n');
        if (result.passed) return reply(`All checks passed.\n${summary}\nNext: ${nextAction(run)}`);
        const stall = result.stalled ? await decideStall(ctx, ws, run) : '';
        return reply(`Checks failed.\n${summary}\nFix file: ${result.fixPath}${stall}\nNext: ${nextAction(run)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Freeze the reviewed state and write the review data file. Then spawn one factory-reviewer per domain.',
    label: 'Factory: start review',
    loadMode: 'essential',
    name: 'factory_review_start',
    parameters: empty,
    async execute(_id, _raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const review = await startReview(ws, run);
        return reply(
          `Review ${review.reviewId} is open.\nData file: ${review.dataFile}\nReference dir: ${review.referenceDir}\nFindings dir: ${review.findingsDir}\nSpawn one ${REVIEWER} per domain, in one task batch: ${review.domains.join(', ')}. Give each its domain, the review id, the data file, and the reference file <reference dir>/<domain>.md. When all have submitted, spawn one ${VALIDATOR} with the review id, the data file, and the findings dir, then call factory_review_record.`,
          review,
        );
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Submit your domain findings for the active review. Call once, with an empty list when you found nothing.',
    label: 'Factory: submit review findings',
    loadMode: 'essential',
    name: 'factory_review_submit',
    parameters: submitSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, REVIEWER);
      const params = submitSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      const count = submitDomain(ws, readRun(ws, activeFeature(ws)), params);
      return reply(`Recorded ${count} ${params.domain} findings for ${params.reviewId}.`);
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Submit the validation: keep the substantiated finding ids, drop the rest with reasons.',
    label: 'Factory: submit validation',
    loadMode: 'essential',
    name: 'factory_review_validate',
    parameters: validateSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, VALIDATOR);
      const params = validateSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      const result = submitValidation(ws, readRun(ws, activeFeature(ws)), params);
      return reply(`Kept ${result.kept}, dropped ${result.dropped}.`);
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Gate the slice on the validated review: green when no critical or high findings remain.',
    label: 'Factory: record review',
    loadMode: 'essential',
    name: 'factory_review_record',
    parameters: empty,
    async execute(_id, _raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const result = await recordReview(ws, run);
        if (result.green) {
          const notes = result.observations.length > 0 ? `\nObservations (non-blocking):\n${result.observations.join('\n\n')}` : '';
          return reply(`Review is green.${notes}\nNext: ${nextAction(run)}`);
        }
        const stall = result.stalled ? await decideStall(ctx, ws, run) : '';
        return reply(`${result.blocking} blocking findings. Fix file: ${result.fixPath}${stall}\nNext: ${nextAction(run)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Mark the green slice done. HEAD must be the reviewed commit.',
    label: 'Factory: complete slice',
    loadMode: 'essential',
    name: 'factory_complete_slice',
    parameters: empty,
    async execute(_id, _raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const slice = await completeSlice(ws, run);
        return reply(`Slice ${slice.id} is done on ${slice.branch}.\nNext: ${nextAction(run)}`);
      });
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description: 'Show the run: slices, phases, fix rounds, peak implementer context, recent events, next action.',
    label: 'Factory: status',
    loadMode: 'essential',
    name: 'factory_status',
    parameters: empty,
    async execute(_id, _raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const ws = await workspace(ctx.cwd);
      const summary = summarize(ws, readRun(ws, activeFeature(ws)));
      return reply(JSON.stringify(summary, null, 2), summary);
    },
  });

  pi.registerTool({
    defaultInactive: true,
    description:
      'Record the retro the user agreed. apply findings become a final slice; file-issue findings become issues on the factory repository.',
    label: 'Factory: retro',
    loadMode: 'essential',
    name: 'factory_retro',
    parameters: retroSchema,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      requireAgent(ctx, 'main');
      const params = retroSchema.parse(raw);
      const ws = await workspace(ctx.cwd);
      return withRun(ws, activeFeature(ws), async run => {
        const { apply, file, findings } = parseRetro(run, params.findings);
        if (apply.length > 0 || file.length > 0) {
          if (!ctx.hasUI) throw new Error('Retro actions need the interactive UI; record them with action "skip" instead.');
          const plan = [
            ...(apply.length > 0 ? ['Final slice applying to this repository:', ...apply.map(finding => `- ${finding.title}`)] : []),
            ...(file.length > 0 ? [`Issues on ${ws.config.factoryRepo}:`, ...file.map(finding => `- ${finding.title}`)] : []),
          ];
          if (!(await ctx.ui.confirm('Record the retro with these actions?', plan.join('\n')))) {
            throw new Error('The user declined these retro actions. Ask which to change, then call factory_retro again.');
          }
        }
        recordRetro(ws, run, findings);
        const lines = [`Retro written to ${join(ws.config.scratchDir, run.feature, 'retro.md')}.`];
        if (apply.length > 0) {
          const estimate = Math.floor(ws.config.sliceTokenBudget / 4);
          const slice = appendSlice(ws, run, retroSlice(apply, run.slices.map(existing => existing.title), estimate));
          lines.push(`Added slice ${slice.id} "${slice.title}".`);
        }
        if (file.length > 0) {
          try {
            lines.push(...(await fileFactoryIssues(ws, file)));
          } catch (error) {
            lines.push(`Filing issues failed; they are still in retro.md: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        settle(run);
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
        await withRun(ws, feature, run => {
          run.status = 'paused';
          addEvent(run, 'pause', 'user paused the run');
        });
        ctx.ui.notify(`Paused "${feature}".`, 'info');
        return;
      }
      if (verb === 'resume') {
        if (argument === '') throw new Error('Usage: /factory resume <feature>');
        pi.sendUserMessage(`Resume software-factory run "${argument}": read skill://software-factory, call factory_start with resume "${argument}", then continue from its next action.`);
        return;
      }
      if (verb === 'submit') {
        const feature = argument || activeFeature(ws);
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
    if (run.ownerSessionId !== event.session_id || run.status !== 'running') return;
    const previous = stopBlocks.get(feature);
    const count = previous?.events === run.events.length ? previous.count + 1 : 1;
    if (count > MAX_IDLE_STOP_BLOCKS) {
      stopBlocks.delete(feature);
      await withRun(ws, feature, current => {
        current.status = 'paused';
        addEvent(current, 'pause', `no progress after ${MAX_IDLE_STOP_BLOCKS} stop attempts`);
      });
      ctx.ui.notify(`Software factory paused "${feature}": no progress. /factory resume ${feature} continues.`, 'warning');
      return;
    }
    stopBlocks.set(feature, { count, events: run.events.length });
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
