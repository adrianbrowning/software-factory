import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { bindRun } from './active-run.ts';
import { auditChild, IMPLEMENTER, REVIEWER, resetAudit, SPAWN_ROLES, VALIDATOR } from './agents.ts';
import { CONFIG_PATH, describeModels, loadConfig, requireAvailableModels, requireOrchestrator, type RoleModels, routeSpawn } from './config.ts';
import { evidenceHead, evidenceLine } from './evidence.ts';
import { deferItems } from './deferred.ts';
import { chooseChecks, confirmInteractive, ensureChecks, gate, loadSource } from './gates.ts';
import {
  activeSlice,
  addEvent,
  builtBy,
  findingSchema,
  fixVerdictSchema,
  forgetRun,
  readRun,
  reportPath,
  REQUIRED_REVIEW_DOMAINS,
  REVIEW_DOMAINS,
  type Run,
  skippedDomainsSchema,
  resliceItemSchema,
  sliceInputSchema,
  statePath,
  ticketPath,
  withRun,
  type Workspace,
} from './run.ts';
import { implementerReportSchema, startImplementerSession, submitImplementerReport } from './report.ts';
import { boundAt, cachedRoot, NO_ACTIVE_RUN, type Reply, resetRoots, type RootEntry, toolRegistrar } from './tool-scope.ts';
import { PrTextsFailed, submitStack } from './submit.ts';
import {
  completeSlice,
  decisionInputSchema,
  fixObservations,
  planDecisions,
  planFix,
  recordDecisions,
  recordReview,
  runChecks,
  startReview,
  submitDomain,
  submitValidation,
  validationSchema,
} from './review.ts';
import {
  addFollowUp,
  amendSeams,
  applyReslice,
  approvePlan,
  carryObservations,
  fileFactoryIssues,
  type FiledIssues,
  headlessTarget,
  nextAction,
  nextSlice,
  parseRetro,
  pauseRun,
  planCarry,
  planDefer,
  planFollowUp,
  planReslice,
  planSlices,
  recordRetro,
  retroDrafts,
  reopenSlice,
  repoChecks,
  requireFeatureName,
  resolveBase,
  resolveStall,
  requireNotStalled,
  stallNotice,
  resumeRun,
  retroIssueBody,
  retroSchema,
  saveChecks,
  sourceInputSchema,
  startRun,
  summarize,
  HEADLESS_FIX_ROUNDS,
} from './workflow.ts';

const DEFAULT_FACTORY_REPO = 'adrianbrowning/software-factory';
/** Tools `factory_start` activates; they stay out of every other session's tool list. */
const ORCHESTRATION_TOOLS = [
  'factory_pause',
  'factory_plan',
  'factory_next',
  'factory_reslice',
  'factory_amend_seams',
  'factory_decide',
  'factory_checks',
  'factory_review_start',
  'factory_review_record',
  'factory_complete_slice',
  'factory_fix',
  'factory_carry',
  'factory_defer',
  'factory_reopen',
  'factory_follow_up',
  'factory_status',
  'factory_retro',
];
/** Stop attempts in a row without new run events; the last one pauses the run instead of blocking. */
export const MAX_IDLE_STOP_ATTEMPTS = 3;
const startSchema = z.object({
  feature: z.string().optional().describe('kebab-case run name for a new run'),
  resume: z.string().optional().describe('Feature name of an existing run to resume instead of starting one'),
  source: sourceInputSchema.optional().describe('The issue, required for a new run: github or file by ref (the tool loads it), jira or text in full'),
});
const decisionsSchema = z.object({
  decisions: z
    .array(decisionInputSchema)
    .min(1)
    .describe('Decisions the user made, each one self-contained sentence; give { text, slice } when the plan assigns the work to one pending or active slice'),
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
const submitSchema = z.object({
  domain: z.enum(REVIEW_DOMAINS),
  findings: z.array(findingSchema),
  fixItems: z
    .array(fixVerdictSchema)
    .optional()
    .describe(
      'Scope domain only, and required for it: one verdict per id the FIX ITEMS section lists ([] when it lists none). fixed, not-a-defect (evidence from the diff or code), waived (with the recorded decision number), or open (blocks the slice and carries into the next round)',
    ),
  reviewId: z.string().min(1),
});
const validateSchema = validationSchema.extend({ reviewId: z.string().min(1) });
const reopenSchema = z.object({
  reason: z.string().min(1).describe('The bug found in the done slice, as the fix file for its implementer'),
  slice: z.string().regex(/^\d{2}$/).describe('Id of the done slice, for example "04"'),
});
const followUpSchema = sliceInputSchema.omit({ blockedBy: true, ownsDecisions: true });
const resliceSchema = z.object({ slices: z.array(resliceItemSchema) });
const fixSchema = z.object({
  bug: z
    .string()
    .optional()
    .describe('A bug the user found in the active slice after its green review, in full, for the fix file. Give it, observations, or both'),
  observations: z
    .array(z.string().min(1))
    .optional()
    .describe('Ids of observations from the green review of the active slice that the user chose to fix in this slice, for example "thermo-naming". Ids only a done slice\'s green review lists are refused: use factory_reopen for that slice, or factory_follow_up'),
  reason: z.string().min(1).describe('Why the user wants them fixed before the slice is done, for the fix file'),
});
const carrySchema = z.object({
  note: z
    .string()
    .optional()
    .describe('Work the user wants built in a later slice, in full, for its ticket. Give it, observations, or both'),
  observations: z
    .array(z.string().min(1))
    .optional()
    .describe('Ids of observations from the active slice\'s green review, else from the one done slice whose last green review lists them, that the user chose to carry, for example "thermo-naming". Refused when several done slices list them: build them in a factory_follow_up slice'),
  to: z
    .union([z.string().regex(/^\d{2}$/), z.literal('end')])
    .describe('Id of the pending slice whose ticket takes the work, for example "03"; or "end": the work waits on the run for the next factory_follow_up slice'),
});
const deferSchema = z.object({
  note: z.string().optional().describe('Work to send to the deferred sink in full. Give it, observations, or both'),
  observations: z
    .array(z.string().min(1))
    .optional()
    .describe('Ids of observations from the active slice\'s green review, else from the one done slice whose last green review lists them, to send to the deferred sink, for example "thermo-naming". Ids already carried or deferred are refused'),
});
const emptySchema = z.object({});

/**
 * Per-process caches, shared by the main session and its subagents in one process. The active run itself is not kept
 * here: omp loads a separate copy of this extension on each worker thread, so the run binding lives in a pointer file
 * in the checkout's git dir (see ./active-run.ts), the one place every copy resolves it from.
 */
const stopAttempts = new Map<string, { count: number; events: number }>();
/** Test-only: clears the module-level run state (stop attempts, cached roots and pointer paths, audited sessions), so tests do not share it. */
export function resetModuleState() {
  stopAttempts.clear();
  resetRoots();
  resetAudit();
}

async function workspace(cwd: string): Promise<Workspace> {
  const { root } = await cachedRoot(cwd);
  return { config: loadConfig(root), root };
}

/** The next action of the bound run, or why its state cannot be read: the pointer can outlive the run's state. */
function describeBound(ws: Workspace, feature: string) {
  try {
    return nextAction(readRun(ws, feature));
  } catch (error) {
    return `state unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Whether the bound run is running. A pointer outlives the process, so a run whose state is gone or unreadable is not running. */
function isRunning(bound: { feature: string; ws: Workspace } | undefined) {
  if (bound === undefined) return false;
  try {
    return readRun(bound.ws, bound.feature).status === 'running';
  } catch {
    return false;
  }
}

/** The active run of the repository holding `cwd`. Undefined when no run is active there, or outside any git repo, which has no run. */
async function runForCwd(cwd: string) {
  const entry = await cachedRoot(cwd).catch(() => undefined);
  return entry === undefined ? undefined : boundAt(entry);
}

function reply(text: string, details?: unknown): Reply {
  return { content: [{ text, type: 'text' }], details };
}

/**
 * A headless run's own submission: when the run is done, opens draft PRs for the whole stack; with `stop` (the slice a
 * paused run stopped at), opens them for the done slices below it, whose bodies say where and why the stack stopped.
 * Returns the reply text, empty when the run is not headless or not at that point. A policy of submission "stop" opens
 * nothing. A gh failure does not undo the work the tool already saved: it is recorded as a `submit-failed` event and
 * reported in the text, and the run stays done (`/factory submit` retries) or paused. Merging stays manual.
 */
async function submitHeadless(ws: Workspace, feature: string, stop?: { reason: string; sliceId: string }) {
  const run = readRun(ws, feature);
  if (run.mode !== 'headless' || run.status !== (stop === undefined ? 'done' : 'paused')) return '';
  if (run.landOn !== undefined) return `\nThis run lands on ${run.landOn}, so it opens no PRs: /factory submit fast-forwards it.`;
  if (ws.config.headless.submission === 'stop') return '\nThe headless policy sets submission to stop, so no PRs were opened. /factory submit opens them.';
  // Saved before submitStack runs, so a later failure cannot discard the choice; each PR body lists it.
  const stopped = stop === undefined ? undefined : run.slices.find(slice => slice.id === stop.sliceId);
  await withRun(ws, feature, current => addEvent(current, 'autonomous', `gate submission (auto): opening draft PRs${stopped === undefined ? '' : ` for the slices below slice ${stopped.id}`}`));
  try {
    return await withRun(ws, feature, async current => {
      const output = await submitStack(ws, current, () => {}, stopped === undefined || stop === undefined ? undefined : { reason: stop.reason, slice: stopped });
      if (output === '') throw new NoSubmission(`\nNo done slice is below slice ${stop?.sliceId}, so no PRs were opened.`);
      return `\nDraft PRs are open (merging stays manual):\n${output}`;
    });
  } catch (error) {
    if (error instanceof NoSubmission) return error.message;
    const message = error instanceof Error ? error.message : String(error);
    await withRun(ws, feature, current => {
      // gh stack submit succeeded: the discarded mutation held the submit event, so save it here.
      if (error instanceof PrTextsFailed) addEvent(current, 'submit', 'stack submitted as draft PRs');
      addEvent(current, 'submit-failed', evidenceLine(message, 500));
    });
    const retry = stop === undefined ? '/factory submit retries it' : 'after /factory resume finishes the stack, /factory submit opens the PRs';
    return `\nSubmission failed: ${message}\nThe run is saved as ${run.status === 'done' ? 'done' : 'paused'}; ${retry}.`;
  }
}

/** Nothing to submit: thrown inside the run mutation so it saves no event. */
class NoSubmission extends Error {}

/** Asks the user how to continue once a slice's fix budget is used up. Without a UI the run pauses. */
async function decideStall(ctx: ExtensionContext, ws: Workspace, feature: string) {
  const run = readRun(ws, feature);
  const slice = activeSlice(run);
  if (slice === undefined || !slice.stalled) return '';
  if (run.mode === 'headless') {
    // A headless run never prompts to raise the fix budget: red checks after the last round pause the run.
    const round = Math.max(...slice.fixItems.map(item => item.round));
    const failing = slice.fixItems.filter(item => item.round === round).map(item => item.summary);
    const reason = `slice ${slice.id} "${slice.title}" is still red after ${slice.roundLimit} fix rounds: ${failing.join('; ')}`;
    await withRun(ws, feature, current => pauseRun(current, reason));
    const submitted = await submitHeadless(ws, feature, { reason, sliceId: slice.id });
    return `\nThe headless run is paused: ${reason}. ${stallNotice(run, slice)}${submitted} Stop now.`;
  }
  const more = `Continue: ${ws.config.maxRounds} more fix rounds`;
  const choice = ctx.hasUI
    ? await ctx.ui.select(`Slice ${slice.id} "${slice.title}" is not green after ${slice.roundLimit} fix rounds`, [
        { description: 'The loop keeps fixing and re-reviewing.', label: more },
        { description: 'Stop here; /factory resume asks whether to raise the fix budget.', label: 'Pause the run' },
      ])
    : undefined;
  const settled = await withRun(ws, feature, current => {
    resolveStall(ws, current, choice === more ? 'continue' : 'pause');
    return { status: current.status, waiting: current.waiting.length };
  });
  if (settled.status !== 'stalled') return `\nThe user allowed ${ws.config.maxRounds} more fix rounds.`;
  const retro =
    settled.waiting === 0
      ? 'Run the retro now (skill://retro, then factory_retro) so this stall improves future runs, then stop.'
      : `Carried items wait on the run (${settled.waiting}), so the retro waits: after /factory resume, a factory_follow_up slice takes them (Next: asks for it once every existing slice is done). Stop now.`;
  return `\nThe user paused the run. ${stallNotice(run, slice)} ${retro}`;
}

function planSummary(slices: Run['slices']) {
  return slices
    .map(
      slice =>
        `${slice.id}. ${slice.title}\n   blocked by: ${slice.blockedBy.join('; ') || 'none'}\n   seams: ${slice.seams.join('; ') || `none (${slice.noTestReason})`}\n${slice.ownsDecisions.length > 0 ? `   builds decisions: ${slice.ownsDecisions.join(', ')}\n` : ''}   ~${slice.estimateTokens} tokens`,
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
  const { startTool, tool } = toolRegistrar(pi);

  /** The orchestrator check on this session's live model (omp's current one, else ctx.model) and thinking level. */
  function requireOrchestratorSession(models: RoleModels, ctx: ExtensionContext, when: 'resume' | 'start') {
    if (models.orchestrator === undefined) return;
    requireOrchestrator(models, { model: ctx.models.current() ?? ctx.model, thinking: pi.getThinkingLevel() }, spec => ctx.models.resolve(spec), when);
  }

  const STALL_DESCRIPTION =
    'A used-up fix budget asks the user to continue or pause; a paused run stalls until /factory resume, which asks whether to raise the budget.';

  /** What `factory_start` and `/factory headless` do: resume a run, or load the issue, check the setup, start the run and bind this session to it. */
  async function startOrResume(params: z.infer<typeof startSchema> & { mode?: Run['mode'] }, { entry, ws }: { entry: RootEntry; ws: Workspace }, ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    let run: Run;
    const notes: string[] = [];
    const mode = params.mode ?? 'interactive';
    if (params.resume !== undefined) {
      const feature = requireFeatureName(params.resume);
      if (!existsSync(statePath(ws, feature))) throw new Error(`No run named "${feature}".`);
      forgetRun(ws, feature);
      const current = readRun(ws, feature);
      requireOrchestratorSession(current.models, ctx, 'resume');
      const slice = activeSlice(current);
      if (slice?.stalled) {
        if (current.mode === 'headless') {
          throw new Error(`The headless fix budget is fixed at ${slice.roundLimit} rounds (decision 8), so resume does not raise it. "${feature}" stays stalled. ${stallNotice(current, slice)}`);
        }
        const body = `In "${feature}", slice ${slice.id} "${slice.title}" used up its fix budget of ${slice.roundLimit} rounds. Raise the fix budget by ${ws.config.maxRounds} rounds and resume?`;
        if (!(await gate(ctx, ws, feature, 'resume', 'Resume software factory run', body))) {
          if (current.status !== 'stalled') await withRun(ws, feature, latest => resolveStall(ws, latest, 'pause'));
          throw new Error(`The user kept "${feature}" stalled. ${stallNotice(current, slice)}`);
        }
      } else if (current.status === 'paused' || current.status === 'stalled') {
        if (!(await gate(ctx, ws, feature, 'resume', 'Resume software factory run', `Resume "${feature}" (${current.status})?`))) {
          throw new Error(`The user kept "${feature}" ${current.status}.`);
        }
      }
      if (current.checks.length === 0) notes.push(...(await ensureChecks(ctx, ws, current.mode)));
      run = await withRun(ws, feature, async latest => {
        await resumeRun(ws, latest, sessionId);
        for (const note of notes) addEvent(latest, 'autonomous', note);
        return latest;
      });
    } else {
      if (params.feature === undefined || params.source === undefined) throw new Error('A new run needs feature and source.');
      const bound = boundAt(entry);
      if (bound !== undefined && isRunning(bound)) {
        throw new Error(`Run "${bound.feature}" is still running in this repository. Finish or /factory pause it first.`);
      }
      requireAvailableModels(ws.config.models, spec => ctx.models.resolve(spec));
      requireOrchestratorSession(ws.config.models, ctx, 'start');
      const loaded = await loadSource(ctx, ws, params.source, mode);
      notes.push(...loaded.notes, ...(await ensureChecks(ctx, ws, mode)));
      run = await startRun(ws, { feature: params.feature, mode, sessionId, source: loaded.source });
      if (notes.length > 0) {
        run = await withRun(ws, run.feature, latest => {
          for (const note of notes) addEvent(latest, 'autonomous', note);
          return latest;
        });
      }
    }
    bindRun(entry.pointer, { feature: run.feature, mainId: ctx.agent.id, ws });
    await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ORCHESTRATION_TOOLS])]);
    return reply(
      `Run "${run.feature}" is ${run.status}. Checks: ${run.checks.join('; ')}. Models: ${describeModels(run.models)}. Slice budget: ${ws.config.sliceTokenBudget} tokens. Fix rounds per slice: ${run.mode === 'headless' ? HEADLESS_FIX_ROUNDS : ws.config.maxRounds}.\nNext: ${nextAction(run)}`,
      summarize(ws, run),
    );
  }

  startTool({
    caller: 'main',
    description:
      'Start a software-factory run for a loaded issue (feature + source), or resume one (resume). Resuming a stalled run asks the user whether to raise the used-up fix budget by maxRounds. Read skill://software-factory first.',
    essential: true,
    label: 'Factory: start',
    name: 'factory_start',
    schema: startSchema,
    run: ({ feature, resume, source }, target, ctx) => startOrResume({ feature, resume, source }, target, ctx),
  });

  tool({
    caller: 'main',
    description: 'Pause a headless run with a reason when the orchestrator cannot resolve something. /factory resume continues it. Works in intake or while running; refused for an interactive run and for any other status.',
    label: 'Factory: pause',
    name: 'factory_pause',
    schema: z.object({ reason: z.string().min(1).describe('Why the run cannot go on without a person') }),
    async run(params, { feature, ws }) {
      await withRun(ws, feature, run => {
        if (run.mode !== 'headless') throw new Error(`Run "${feature}" is interactive; factory_pause pauses headless runs only. The user pauses an interactive run with /factory pause.`);
        if (run.status === 'intake') {
          // Intake has no approved plan; pauseRun stays running-only, so the tool records the pause itself.
          run.status = 'paused';
          addEvent(run, 'pause', params.reason);
          return;
        }
        if (run.status !== 'running') throw new Error(`Run "${feature}" is ${run.status}; factory_pause pauses a running or intake run.`);
        pauseRun(run, params.reason);
      });
      return reply(`Run "${feature}" is paused: ${params.reason}\n/factory resume ${feature} continues it. Stop now.`);
    },
  });

  tool({
    caller: 'main',
    description:
      'Propose the tracer-bullet slices. The user approves or rejects them in a dialog. Each slice must fit the context budget and name its test seams.',
    label: 'Factory: plan',
    name: 'factory_plan',
    schema: planToolSchema,
    async run(params, { feature, ws }, ctx) {
      const base = await resolveBase(ws, { baseRef: params.baseRef, landOn: params.landOn, trunk: params.trunk });
      const slices = planSlices(ws, readRun(ws, feature), params.slices, base);
      const target = base.landOn === undefined ? `PRs target ${base.trunk}` : `/factory submit fast-forwards ${base.landOn} to the top slice; no PRs`;
      const where = `Slice 01 branches from ${base.baseRef} (${base.baseSha.slice(0, 12)}); ${target}.`;
      if (!(await gate(ctx, ws, feature, 'plan', `Approve ${slices.length} slices for "${feature}"?`, `${where}\n\n${planSummary(slices)}`))) {
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
    async run(_params, { feature, ws }) {
      return withRun(ws, feature, async run => {
        const slice = await nextSlice(ws, run);
        if (slice === undefined) return reply(`No slices left.\nNext: ${nextAction(run)}`);
        return reply(
          `Slice ${slice.id} "${slice.title}" on ${slice.branch} (phase ${slice.phase}).\nTicket: ${ticketPath(ws, run.feature, slice)}\nImplementer report file: ${reportPath(ws, run.feature, slice)}\nChecks: ${run.checks.join('; ')}\nContext budget: ${ws.config.sliceTokenBudget} tokens.\nNext: ${nextAction(run)}`,
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
    schema: resliceSchema,
    async run(params, { feature, ws }, ctx) {
      const run = readRun(ws, feature);
      const { children, slices } = planReslice(ws, run, params.slices);
      const active = activeSlice(run);
      const remaining = slices.slice(active === undefined ? 0 : run.slices.indexOf(active));
      if (!(await gate(ctx, ws, feature, 'reslice', `Split slice ${active?.id} into ${children.length} slices?`, planSummary(remaining)))) {
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
      'Record decisions (accepted tradeoffs, out-of-scope work). In an interactive run the user confirms them; in a headless run they are recorded as autonomous and marked so. Every later ticket and review data file lists them. A decision may name the slice that builds it; slices before that one mark it as built later.',
    label: 'Factory: record decisions',
    name: 'factory_decide',
    schema: decisionsSchema,
    async run(params, { feature, ws }, ctx) {
      // An unknown or done slice is refused by planDecisions, without a dialog.
      const planned = planDecisions(readRun(ws, feature), params.decisions);
      const body = planned.map(({ owner, text }) => `- ${text}${owner === undefined ? '' : ` (${builtBy(owner)})`}`).join('\n');
      if (!(await gate(ctx, ws, feature, 'decide', 'Record these decisions for reviewers?', body))) {
        return reply('The decisions were rejected. Ask how to word them.');
      }
      return withRun(ws, feature, run => {
        const { decisions, discarded } = recordDecisions(ws, run, params.decisions);
        const stop = discarded === undefined ? '' : `Stop the running reviewers and validator of review ${discarded}; their submissions are refused. `;
        return reply(`Decisions recorded (${decisions.length} in total). Reviews from now on include them.\nNext: ${stop}${nextAction(run)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description: 'Add test seams the user agreed for the active slice (tdd skill: tests only at agreed seams).',
    label: 'Factory: amend seams',
    name: 'factory_amend_seams',
    schema: seamsSchema,
    async run(params, { feature, ws }, ctx) {
      const slice = activeSlice(readRun(ws, feature));
      if (slice === undefined) throw new Error('No active slice. Call factory_next.');
      if (!(await gate(ctx, ws, feature, 'seams', `Add test seams to slice ${slice.id}?`, params.seams.map(seam => `- ${seam}`).join('\n')))) {
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
    description:
      `Run every configured check on the committed slice. Failures produce a fix file for the implementer. ${STALL_DESCRIPTION}`,
    label: 'Factory: checks',
    name: 'factory_checks',
    schema: emptySchema,
    async run(_params, { feature, ws }, ctx, signal) {
      const result = await withRun(ws, feature, run => runChecks(ws, run, signal));
      const summary = result.summary.join('\n');
      const run = readRun(ws, feature);
      const work = `Slice commits:\n${result.commits}\n${result.report}`;
      const unchanged = result.unchanged
        ? '\nNo new commits since the fix file. The implementer report should explain, for each item, why no change was needed.'
        : '';
      if (result.passed) {
        const byPath = result.pathSkipped.length === 0 ? '' : `\nPath rules skip: ${result.pathSkipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ')}. Pass a domain in factory_review_start keep when a changed file holds its subject after all.`;
        const passed = result.reused ? `All checks already passed on ${result.sha}; reusing their results, no check ran.` : 'All checks passed.';
        return reply(`${passed}\n${summary}\n${work}${unchanged}\nChanged files:\n${result.changed}${byPath}\nNext: ${nextAction(run)}`);
      }
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`Checks failed.\n${summary}\n${work}${unchanged}\nFix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: IMPLEMENTER,
    description:
      'Submit your final report for the active slice: commits, fix file items (required in fix mode), behaviors, and open items, one line per item. Call it before your final message, and again after every follow-up turn; each call replaces the stored report. The orchestrator reads the stored report file, which the factory_next and factory_checks replies name.',
    label: 'Factory: implementer report',
    name: 'factory_implementer_report',
    schema: implementerReportSchema,
    async run(params, { feature, ws }) {
      const result = await withRun(ws, feature, run => submitImplementerReport(ws, run, params));
      return reply(`${result.replaced ? 'Replaced the stored report' : 'Stored the report'}: ${result.path}`);
    },
  });

  tool({
    caller: 'main',
    description: `Freeze the reviewed state and write the review data file. Then spawn one factory-reviewer per domain. The factory skips react-ts, test-validity, and devops by changed paths unless kept; skip any other domain the diff gives nothing to review, with a reason. ${REQUIRED_REVIEW_DOMAINS.join(' and ')} always review, and testing does too for a slice with test seams.`,
    label: 'Factory: start review',
    name: 'factory_review_start',
    schema: reviewStartSchema,
    async run(params, { feature, ws }) {
      return withRun(ws, feature, async run => {
        const review = await startReview(ws, run, params.skip, params.keep);
        const byPath = review.pathSkipped.length === 0 ? '' : `\nSkipped by path: ${review.pathSkipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ')}.`;
        return reply(
          `Review ${review.reviewId} is open.${byPath}\nData file: ${review.dataFile}\nReference dir: ${review.referenceDir}\nFindings dir: ${review.findingsDir}\nRun the reviewers and the validator in one eval step (timeout 0; the software-factory skill has the snippet in section 4, step 6). Spawn one ${REVIEWER} per domain with agent(): ${review.domains.join(', ')}. Give each its domain, the review id, the data file, and the reference file <reference dir>/<domain>.md. With the kernel wait(), wait for every reviewer, then spawn one ${VALIDATOR} with the review id, the data file, the findings dir, and the reference dir, and wait for it (it may correct its validation once). Then call factory_review_record.`,
          review,
        );
      });
    },
  });

  tool({
    caller: REVIEWER,
    description:
      'Submit your domain findings for the active review, with an empty list when you found nothing; the scope domain also gives a verdict for every fix item in fixItems. Each later call replaces them with its complete list (to correct them or remove a stale finding), until validation.',
    label: 'Factory: submit review findings',
    name: 'factory_review_submit',
    schema: submitSchema,
    async run(params, { feature, ws }, ctx) {
      const count = await withRun(ws, feature, run => submitDomain(ws, run, { ...params, agentId: ctx.agent.id }));
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
    async run(params, { feature, ws }, ctx) {
      const result = await withRun(ws, feature, run => submitValidation(ws, run, { ...params, agentId: ctx.agent.id }));
      const action = result.replaced ? 'Replaced the validation' : 'Recorded the validation';
      return reply(
        `${action}: kept ${result.kept}, downgraded ${result.downgraded} to observations, escalated ${result.escalated} to high, dropped ${result.dropped}.`,
      );
    },
  });

  tool({
    caller: 'main',
    description:
      `Gate the slice on the validated review: green when no critical or high findings remain. ${STALL_DESCRIPTION}`,
    label: 'Factory: record review',
    name: 'factory_review_record',
    schema: emptySchema,
    async run(_params, { feature, ws }, ctx) {
      const result = await withRun(ws, feature, run => recordReview(ws, run));
      if (result.green) {
        const notes =
          result.observations.length > 0
            ? `\nObservations (non-blocking):\n${result.observations.join('\n\n')}\nAsk the user where each goes: fixed in this slice (factory_fix with their ids), carried into the ticket of a pending slice (factory_carry with their ids and that slice id), ${ws.config.deferred === undefined ? 'or ' : ''}queued for one follow-up slice at the end of the run (factory_carry with their ids and to "end")${ws.config.deferred === undefined ? '' : ', or sent to the deferred sink (factory_defer with their ids)'}. This slice stays green when they are carried.`
            : '';
        const bug = '\nWhen the user finds a bug in this slice before it is done, call factory_fix with the bug (and any observation ids).';
        return reply(`Review is green.${notes}${bug}\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      if (result.unresolved !== undefined) {
        return reply(
          `Review is accepted unresolved: the fix budget is used up, and a headless run does not raise it. Open:\n${result.unresolved.join('\n')}\nThe slice counts as green with these items on record.\nNext: ${nextAction(readRun(ws, feature))}`,
        );
      }
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`${result.blocking} blocking findings, ${result.open} open fix items. Fix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Mark the green slice done. HEAD must be the reviewed commit. A reopened slice rebases every later slice branch onto its fix.',
    label: 'Factory: complete slice',
    name: 'factory_complete_slice',
    schema: emptySchema,
    async run(_params, { feature, ws }) {
      const done = await withRun(ws, feature, async run => {
        const reopened = activeSlice(run)?.doneSha !== undefined;
        const slice = await completeSlice(ws, run);
        const restacked = reopened ? ' Every later slice branch is rebased onto it and earns its checks and review again.' : '';
        return `Slice ${slice.id} is done on ${slice.branch}.${restacked}`;
      });
      const submitted = await submitHeadless(ws, feature);
      return reply(`${done}${submitted}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description:
      `After a green review, send the active slice back to the fix loop for a bug the user found in it (bug), review observations the user chose to fix in this slice (observations), or both, after the user agreed. Observation ids must be in the active slice's green review; ids only a done slice's review lists are refused (use factory_reopen or factory_follow_up). Writes a tracked fix file; the round counts toward the fix budget, and the slice earns checks and a new review before factory_complete_slice. ${STALL_DESCRIPTION}`,
    label: 'Factory: fix observations or a bug',
    name: 'factory_fix',
    schema: fixSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses a call with neither a bug nor observations, a slice without a green review, an id that is not one of
      // its observations, or ids only a done slice's review lists (use factory_reopen or factory_follow_up), without a dialog.
      const planned = planFix(ws, readRun(ws, feature), params);
      const items = [
        ...(planned.bug === undefined ? [] : [`- Bug: ${evidenceHead(planned.bug, 1_000)}`]),
        ...planned.observations.map(finding => `- ${finding.id}: ${finding.title}`),
      ];
      const what = [...(planned.bug === undefined ? [] : ['the bug']), ...planned.observations.map(finding => finding.id)].join(', ');
      const body = `${params.reason}\n\n${items.join('\n')}\n\nThe green review ${planned.review.id} is dropped. The implementer fixes these in fix mode, then the slice gets checks and a new review again. The round counts toward the fix budget.`;
      const title = planned.observations.length === 0 ? 'Fix a bug' : planned.bug === undefined ? 'Fix observations' : 'Fix a bug and observations';
      if (!(await gate(ctx, ws, feature, 'fix', `${title} in slice ${planned.slice.id} "${planned.slice.title}"?`, body))) {
        return reply(`The user kept the green review. Ask how to handle the observations or the bug, or call factory_complete_slice.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const result = await withRun(ws, feature, run => fixObservations(ws, run, params, params.reason));
      const stall = result.stalled ? await decideStall(ctx, ws, feature) : '';
      return reply(`Slice ${planned.slice.id} is back in fix for ${what}. Fix file: ${result.fixPath}${stall}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description:
      'After a green review, carry review observations the user chose (observations), a free-text note (note), or both into the ticket of a pending slice (to), or with to "end" onto the run\'s queue for the next factory_follow_up slice, after the user agreed. Observation ids come from the active slice\'s green review; when it does not list them, from the one done slice whose last green review does. That slice builds them and its reviewers check them; the slice they come from keeps its green review. The retro waits until the queue is empty.',
    label: 'Factory: carry work into a pending slice',
    name: 'factory_carry',
    schema: carrySchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses empty input, a slice without a green review, an id no green review lists or several done slices list,
      // or a target that is neither "end" nor a pending slice, without a dialog.
      const planned = planCarry(ws, readRun(ws, feature), params);
      const items = [
        ...(planned.note === undefined ? [] : [`- Note: ${evidenceHead(planned.note, 1_000)}`]),
        ...planned.observations.map(finding => `- ${finding.id}: ${finding.title}`),
      ];
      const what = [...(planned.note === undefined ? [] : ['the note']), ...planned.observations.map(finding => finding.id)].join(', ');
      const target = planned.target;
      const builder =
        target === undefined
          ? 'They wait on the run: the next factory_follow_up slice builds them, and its reviewers check them. The retro waits until then.'
          : `Slice ${target.id} builds these, and its reviewers check them.`;
      const body = `${items.join('\n')}\n\nSlice ${planned.slice.id} keeps its green review. ${builder}`;
      const title = target === undefined ? 'Carry to the end of the run?' : `Carry into slice ${target.id} "${target.title}"?`;
      if (!(await gate(ctx, ws, feature, 'carry', title, body))) {
        return reply(`The user did not carry the work. Ask how to handle the observations or the note.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      return withRun(ws, feature, run => {
        const carried = carryObservations(ws, run, params).target;
        const where =
          carried === undefined
            ? `Queued ${what} for the next factory_follow_up slice (${run.waiting.length} waiting).`
            : `Carried ${what} into slice ${carried.id} "${carried.title}". Ticket: ${ticketPath(ws, run.feature, carried)}`;
        return reply(`${where}\nNext: ${nextAction(run)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description:
      `Reopen a done slice to fix a bug found in it, after the user agreed. The fix goes into that slice; completing it rebases every later slice onto the fix, and those slices earn their checks and review again. ${STALL_DESCRIPTION}`,
    label: 'Factory: reopen slice',
    name: 'factory_reopen',
    schema: reopenSchema,
    async run(params, { feature, ws }, ctx) {
      const current = readRun(ws, feature);
      requireNotStalled(current);
      const target = current.slices.find(slice => slice.id === params.slice);
      // Anything but a done slice is refused by reopenSlice, without a dialog.
      if (target?.status === 'done') {
        const body = `${params.reason}\n\nThe active slice goes back to pending with its commits. When slice ${target.id} is done again, every later slice branch is rebased onto the fix and earns its checks and review again. The run needs a new retro before /factory submit.`;
        if (!(await gate(ctx, ws, feature, 'reopen', `Reopen slice ${target.id} "${target.title}"?`, body))) {
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
    description:
      'Add one slice on top of the stack, after the user agreed, for work found after a slice was done (for example a non-blocking review observation). Every carried item waiting on the run (factory_carry to "end") goes into its ticket. The done slices and their PRs stay as reviewed; the new slice comes last and gets its own checks, review, and PR.',
    label: 'Factory: follow-up slice',
    name: 'factory_follow_up',
    schema: followUpSchema,
    async run(params, { feature, ws }, ctx) {
      const current = readRun(ws, feature);
      const planned = planFollowUp(ws, current, params);
      const carried = current.waiting.length === 0 ? '' : `\n\nThe slice also takes the carried items waiting on the run (${current.waiting.length}).`;
      const body = `${params.whatToBuild}\n\nAcceptance:\n${params.acceptance.map(item => `- ${item}`).join('\n')}${carried}\n\nThe slice branches from ${planned.parentBranch}. The slices below it are not changed. The run needs a new retro before /factory submit.`;
      if (!(await gate(ctx, ws, feature, 'followUp', `Add follow-up slice "${params.title}"?`, body))) {
        return reply('The user did not add the follow-up slice. Ask how to handle the work.');
      }
      return withRun(ws, feature, run => {
        const slice = addFollowUp(ws, run, params);
        const taken = slice.carried.length === 0 ? '' : `, with the waiting carried items (${slice.carried.length})`;
        return reply(`Slice ${slice.id} "${slice.title}" is added on ${slice.branch}${taken}.\nNext: ${nextAction(run)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description:
      'Send green-review observations (observations), a free-text note (note), or both to the deferred sink set in .omp/factory.json: one GitHub issue per item (filed at once, URL stored), or the sink file, written later from the items queued on the run. Each item names the run, slice and review. Ids already carried or deferred are refused. The slice keeps its green review. Accepted-unresolved findings go to the sink by themselves.',
    label: 'Factory: defer to the sink',
    name: 'factory_defer',
    schema: deferSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses a project without a sink, empty input, unknown ids, and ids already carried or deferred, without a dialog.
      const planned = planDefer(ws, readRun(ws, feature), params);
      const sink = ws.config.deferred?.kind === 'github' ? 'GitHub issues (gh issue create, one per item)' : `the sink file ${ws.config.deferred?.path} (queued on the run)`;
      const items = planned.map(draft => `- ${draft.id ?? 'Note'}: ${evidenceHead(draft.title, 200)}`);
      if (!(await confirmInteractive(ctx, ws, feature, `Defer ${planned.length} items to ${ws.config.deferred?.kind === 'github' ? 'GitHub issues' : 'the sink file'}?`, `${items.join('\n')}\n\nSink: ${sink}.`))) {
        return reply(`The user did not defer the work. Ask how to handle the observations or the note.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const { failure, lines, rest } = await withRun(ws, feature, async run => {
        const drafts = planDefer(ws, run, params);
        const before = run.deferred.length;
        const failed = await deferItems(ws, run, drafts);
        const filed = run.deferred.slice(before);
        if (filed.length > 0) addEvent(run, 'defer', `${filed[0]?.review}: ${filed.map(item => item.id ?? 'note').join(', ')}`);
        const rest = drafts.filter(draft => !filed.some(item => item.key === draft.key)).map(draft => draft.id ?? 'the note');
        return { failure: failed, lines: [...filed.map(item => `${item.id ?? 'note'}: ${item.location}`), `Next: ${nextAction(run)}`], rest };
      });
      if (failure !== undefined) {
        throw new Error(`The deferred sink failed: ${failure.message}. Filed items stay recorded and are refused if sent again; call factory_defer again with only the rest: ${rest.join(', ')}.\n${lines.join('\n')}`);
      }
      return reply(`Deferred:\n${lines.join('\n')}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Show the run: slices, phases, fix rounds, peak implementer context, the actual model and thinking level of each spawned agent, recent events, next action.',
    label: 'Factory: status',
    name: 'factory_status',
    schema: emptySchema,
    async run(_params, { feature, ws }) {
      const summary = summarize(ws, readRun(ws, feature));
      return reply(JSON.stringify(summary, null, 2), summary);
    },
  });

  tool({
    caller: 'main',
    description:
      'Record the retro the user agreed. apply findings become a final slice; file-issue findings become issues on the factory repository. A headless run defers every finding to the deferred sink instead (no apply slice, no issues), and adds a final Record deferred items slice when file-sink items wait.',
    label: 'Factory: retro',
    name: 'factory_retro',
    schema: retroSchema,
    async run(params, { feature, ws }, ctx) {
      const retro = parseRetro(ws, readRun(ws, feature), params.findings);
      let filed: FiledIssues = { urls: {} };
      if (readRun(ws, feature).mode === 'headless') {
        const where = ws.config.deferred === undefined ? 'nowhere: no deferred sink is configured' : ws.config.deferred.kind === 'github' ? 'GitHub issues on this repository' : `the sink file ${ws.config.deferred.path}`;
        await gate(ctx, ws, feature, 'retro', 'Record the retro and defer its findings?', `${retro.findings.length} findings go to ${where}:\n${retro.findings.map(finding => `- ${finding.title}`).join('\n')}`);
        const failure = await withRun(ws, feature, run => deferItems(ws, run, retroDrafts(run, retro)));
        if (failure !== undefined) throw new Error(`The deferred sink failed: ${failure.message}. Findings already filed stay recorded; call factory_retro again with the same findings to file the rest.`);
      } else if (retro.apply.length > 0 || retro.file.length > 0) {
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
        if (!(await gate(ctx, ws, feature, 'retro', 'Record the retro with these actions?', plan.join('\n')))) {
          throw new Error('The user declined these retro actions. Ask which to change, then call factory_retro again.');
        }
        filed = await fileFactoryIssues(ws, retro.file);
      }
      const recorded = await withRun(ws, feature, run => {
        const slice = recordRetro(ws, run, retro, filed);
        const lines = [`Retro written to ${join(ws.config.scratchDir, feature, 'retro.md')}.`];
        if (slice !== undefined) lines.push(`Added slice ${slice.id} "${slice.title}".`);
        lines.push(...Object.values(filed.urls));
        if (filed.error !== undefined) lines.push(`Filing stopped: ${filed.error}. Unfiled findings are marked in retro.md.`);
        return lines.join('\n');
      });
      const submitted = await submitHeadless(ws, feature);
      return reply(`${recorded}${submitted}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  pi.registerCommand('factory', {
    description: 'Software factory: /factory <issue> | headless <issue> | resume <feature> | pause | status | checks | submit [feature]',
    async handler(args, ctx) {
      const [verb = '', ...rest] = args.trim().split(/\s+/);
      const argument = rest.join(' ');
      // status and pause act on the active run through the workspace it started or resumed with; without one, status
      // lists the runs of the current factory.json.
      const active = await runForCwd(ctx.cwd);
      if (verb === '' || verb === 'status') {
        const ws = active?.ws ?? (await workspace(ctx.cwd));
        const runsDir = join(ws.root, ws.config.scratchDir);
        const known = existsSync(runsDir) ? readdirSync(runsDir).filter(name => existsSync(statePath(ws, name))) : [];
        const current = active === undefined ? 'none' : `${active.feature}: ${describeBound(ws, active.feature)}`;
        ctx.ui.notify(`Active run: ${current}\nRuns: ${known.join(', ') || 'none'}`, 'info');
        return;
      }
      if (verb === 'pause') {
        if (active === undefined) throw new Error(NO_ACTIVE_RUN);
        await withRun(active.ws, active.feature, run => pauseRun(run, 'user paused the run'));
        ctx.ui.notify(`Paused "${active.feature}".`, 'info');
        return;
      }
      const ws = await workspace(ctx.cwd);
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
      if (verb === 'resume') {
        const feature = requireFeatureName(argument);
        pi.sendUserMessage(`Resume software-factory run "${feature}": read skill://software-factory, call factory_start with resume "${feature}", then continue from its next action.`);
        return;
      }
      if (verb === 'submit') {
        const named = argument || active?.feature;
        if (named === undefined) throw new Error(NO_ACTIVE_RUN);
        const feature = requireFeatureName(named);
        // Without a feature argument it submits the active run, on the workspace that run started with.
        const target = argument === '' ? (active?.ws ?? ws) : ws;
        const run = readRun(target, feature);
        const ok = await ctx.ui.confirm(
          run.landOn === undefined ? 'Open draft PRs?' : `Fast-forward ${run.landOn}?`,
          run.landOn === undefined
            ? `gh stack will stack ${run.slices.length} branches onto ${run.trunk} (adding any the existing stack lacks) and open or update one draft PR per slice:\n${run.slices.map(slice => slice.branch).join('\n')}`
            : `${run.landOn} will fast-forward to ${run.slices.at(-1)?.branch} (${run.slices.length} slices). No PRs are opened and your checkout is not changed.`,
        );
        if (!ok) return;
        // The status line can be hidden in the omp settings, so each step is also a notification.
        const progress = (step: string) => {
          ctx.ui.setStatus('factory-submit', `Factory submit: ${step}…`);
          ctx.ui.notify(`Factory submit: ${step}…`, 'info');
        };
        try {
          const output = await withRun(target, feature, current => submitStack(target, current, progress));
          ctx.ui.notify(output.trim() || 'Stack submitted.', 'info');
        } finally {
          ctx.ui.setStatus('factory-submit', undefined);
        }
        return;
      }
      if (verb === 'headless') {
        if (argument === '') throw new Error('Usage: /factory headless <issue ref>');
        // The command starts the run itself, so its mode is headless whatever the model does next.
        const { feature, source } = headlessTarget(argument);
        await startOrResume({ feature, mode: 'headless', source }, { entry: await cachedRoot(ctx.cwd), ws }, ctx);
        pi.sendUserMessage(`A headless software-factory run "${feature}" is started for: ${argument}\nRead skill://software-factory and continue it from its next action (${nextAction(readRun(ws, feature))}).`);
        return;
      }
      pi.sendUserMessage(`Start a software-factory run for: ${args.trim()}\nRead skill://software-factory and follow it.`);
    },
  });

  pi.on('session_stop', async (event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    const active = await runForCwd(ctx.cwd);
    if (active === undefined) return;
    const { feature, ws } = active;
    let run: Run;
    try {
      run = readRun(ws, feature);
    } catch {
      return;
    }
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

  /** Measures each implementer's context so the retro can see slices that outgrew the budget. `found` is its active run. */
  async function trackImplementer(ctx: ExtensionContext, found: { feature: string; ws: Workspace } | undefined, compacted: boolean) {
    if (ctx.agent.kind !== 'sub' || ctx.agent.name !== IMPLEMENTER || found === undefined) return;
    const { feature, ws } = found;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    let peak: number | undefined;
    try {
      peak = activeSlice(readRun(ws, feature))?.peakContextTokens;
    } catch {
      return;
    }
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

  pi.on('turn_end', async (_event, ctx) => {
    const found = await runForCwd(ctx.cwd);
    try {
      await auditChild(ctx, pi.getThinkingLevel(), found);
    } finally {
      await trackImplementer(ctx, found, false);
    }
  });
  pi.on('auto_compaction_start', async (_event, ctx) => trackImplementer(ctx, await runForCwd(ctx.cwd), true));
  // A new implementer the orchestrator spawns starts a new report round; reviving or messaging one is not a spawn, so
  // a follow-up turn keeps its report. The run's model snapshot routes factory agent spawns from the main session, and
  // main-session spawns of any agent named `scout` (the explorer role; the event does not say whether it is omp's
  // bundled one) only while the run is in intake or running; a role without an entry inherits. The spawn event does not
  // carry a review domain, so one reviewer model covers every domain. The hook sets the model only: a `:<effort>` suffix
  // on the returned pattern does not reach the child's thinking level. Routing never reloads factory.json: it finds the
  // run through the workspace remembered when the run started or resumed, and only reads it; an implementer spawn alone
  // saves the run, to start a report round. A cwd outside any git repo has no run, so it goes unrouted. When the run
  // state cannot be read, a scout spawn goes unrouted and a factory-role spawn is blocked.
  pi.on('before_subagent_spawn', async (event, ctx) => {
    const role = ctx.agent.kind === 'main' ? SPAWN_ROLES.get(event.agent) : undefined;
    if (role === undefined) return;
    const active = await runForCwd(ctx.cwd);
    if (active === undefined) return;
    let run: Run;
    try {
      run = readRun(active.ws, active.feature);
    } catch (error) {
      if (role === 'explorer') return;
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `Software factory: models.${role}: cannot route this spawn because the run state of "${active.feature}" cannot be read (${message}), so the spawn is refused rather than run on another model.`,
      };
    }
    if (role === 'explorer' && run.status !== 'intake' && run.status !== 'running') return;
    const route = routeSpawn(role, run.models[role], spec => ctx.models.resolve(spec));
    if (role === 'implementer' && route?.block !== true) await withRun(active.ws, active.feature, latest => startImplementerSession(active.ws, latest));
    return route;
  });
}
