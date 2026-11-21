import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { bindRun } from './active-run.ts';
import { auditChild, IMPLEMENTER, resetAudit, SPAWN_ROLES } from './agents.ts';
import { CONFIG_PATH, describeModels, loadConfig, requireAvailableModels, requireOrchestrator, type RoleModels, routeSpawn } from './config.ts';
import { gitArchWarning } from './git-arch.ts';
import { deferItems } from './deferred.ts';
import { chooseChecks, ensureChecks, gate, loadSource } from './gates.ts';
import {
  activeSlice,
  addEvent,
  builtBy,
  forgetRun,
  readRun,
  reportPath,
  requireNotStalled,
  type Run,
  resliceItemSchema,
  sliceInputSchema,
  statePath,
  ticketPath,
  stallNotice,
  withRun,
  type Workspace,
} from './run.ts';
import { implementerReportSchema, startImplementerSession, submitImplementerReport } from './report.ts';
import { boundAt, cachedRoot, NO_ACTIVE_RUN, resetRoots, type RootEntry, toolRegistrar } from './tool-scope.ts';
import { submitHeadless } from './headless-submit.ts';
import { submitStack } from './submit.ts';
import { decisionInputSchema, planDecisions, recordDecisions, runChecks } from './review.ts';
import { recordSelfHostWarning, setLoadedPlugin } from './self-host.ts';
import { registerReviewTools } from './review-tools.ts';
import { decideStall, emptySchema, reply, STALL_DESCRIPTION } from './tool-replies.ts';
import {
  addFollowUp,
  amendSeams,
  applyReslice,
  approvePlan,
  headlessTarget,
  markPaused,
  nextAction,
  nextSlice,
  pauseRun,
  planFollowUp,
  planReslice,
  planSlices,
  reopenSlice,
  repoChecks,
  requireFeatureName,
  resolveBase,
  resolveStall,
  resumeRun,
  saveChecks,
  startRun,
  summarize,
  HEADLESS_FIX_ROUNDS,
} from './workflow.ts';
import { fileFactoryIssues, type FiledIssues, parseRetro, recordRetro, retroDrafts, retroIssueBody, retroSchema } from './retro.ts';
import { sourceInputSchema } from './source.ts';

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
  'factory_leave',
  'factory_place',
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
    .describe('Decisions recorded for the run (a headless run records them as autonomous), each one self-contained sentence; give { text, slice } when the plan assigns the work to one pending or active slice'),
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
const reopenSchema = z.object({
  reason: z.string().min(1).describe('The bug found in the done slice, as the fix file for its implementer'),
  slice: z.string().regex(/^\d{2}$/).describe('Id of the done slice, for example "04"'),
});
const followUpSchema = sliceInputSchema.omit({ blockedBy: true, ownsDecisions: true });
const resliceSchema = z.object({ slices: z.array(resliceItemSchema) });

/**
 * Per-process caches, shared by the main session and its subagents in one process. The active run itself is not kept
 * here: omp loads a separate copy of this extension on each worker thread, so the run binding lives in a pointer file
 * in the checkout's git dir (see ./active-run.ts), the one place every copy resolves it from.
 */
const stopAttempts = new Map<string, { count: number; events: number }>();
/** Test-only: clears the module-level run state (stop attempts, cached roots and pointer paths, audited sessions), so tests do not share it. */
export function resetModuleState() {
  stopAttempts.clear();
  setLoadedPlugin();
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

function planSummary(slices: Run['slices']) {
  return slices
    .map(
      slice =>
        `${slice.id}. ${slice.title}\n   blocked by: ${slice.blockedBy.join('; ') || 'none'}\n   seams: ${slice.seams.join('; ') || `none (${slice.noTestReason})`}\n${slice.ownsDecisions.length > 0 ? `   builds decisions: ${slice.ownsDecisions.join(', ')}\n` : ''}   ~${slice.estimateTokens} tokens`,
    )
    .join('\n');
}

/** The name of the last tool call in the latest assistant message that has one; undefined when there is none. */
function latestToolCallName(messages: readonly unknown[] | undefined) {
  for (const message of (messages ?? []).toReversed()) {
    const { content, role } = message as { content?: unknown; role?: string };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    const calls = (content as { name?: string; type?: string }[]).filter(part => part.type === 'toolCall');
    if (calls.length > 0) return calls.at(-1)?.name;
  }
  return undefined;
}

/** Whether the latest tool call in the session is the omp `ask` tool: the orchestrator waits on the user's answer. */
function waitingOnAsk(messages: readonly unknown[] | undefined) {
  return latestToolCallName(messages) === 'ask';
}

/** Why a session stopped idle: the name of its latest tool call and a snippet (whitespace collapsed, at most 200 characters) of its last assistant text, each 'none' when absent. */
function describeStop(messages: readonly unknown[] | undefined) {
  let text: string | undefined;
  for (const message of (messages ?? []).toReversed()) {
    const { content, role } = message as { content?: unknown; role?: string };
    if (role !== 'assistant') continue;
    const parts = typeof content === 'string' ? [{ text: content, type: 'text' }] : Array.isArray(content) ? (content as { text?: string; type?: string }[]) : [];
    text = parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ').replaceAll(/\s+/g, ' ').trim().slice(0, 200) || undefined;
    if (text !== undefined) break;
  }
  return `latest tool: ${latestToolCallName(messages) ?? 'none'}; last assistant text: ${text ?? 'none'}`;
}

/** Stop gate: block a stop while the owner session's run is running, and pause it after repeated idle stops. An interactive run waiting on an ask is allowed to stop. */
export function stopDecision(run: Run, sessionId: string, previous: { count: number; events: number } | undefined, messages?: readonly unknown[]) {
  if (run.ownerSessionId !== sessionId || run.status !== 'running') return { action: 'allow' as const };
  if (run.mode !== 'headless' && waitingOnAsk(messages)) return { action: 'wait' as const };
  const count = previous?.events === run.events.length ? previous.count + 1 : 1;
  if (count >= MAX_IDLE_STOP_ATTEMPTS) return { action: 'pause' as const };
  return { action: 'block' as const, attempts: { count, events: run.events.length } };
}

/** `checkGit` is the git-architecture check and `submit` a headless run's own submission; tests replace them. */
export default function softwareFactory(pi: ExtensionAPI, checkGit: () => string | undefined = gitArchWarning, submit: typeof submitHeadless = submitHeadless) {
  // Under omp -p a bare sendUserMessage from a command handler is dropped before dispatch; an explicit steer starts the turn (smoke-tested: only it fires agent_start/turn_start).
  const sendContinuation = (text: string) => pi.sendUserMessage(text, { deliverAs: 'steer', attribution: 'agent' });
  pi.setLabel('Software Factory');
  const { startTool, tool } = toolRegistrar(pi);

  /** The orchestrator check on this session's live model (omp's current one, else ctx.model) and thinking level. */
  function requireOrchestratorSession(models: RoleModels, ctx: ExtensionContext, when: 'resume' | 'start') {
    if (models.orchestrator === undefined) return;
    requireOrchestrator(models, { model: ctx.models.current() ?? ctx.model, thinking: pi.getThinkingLevel() }, spec => ctx.models.resolve(spec), when);
  }

  /** Shared by `factory_start` and `/factory headless`; only the command passes `mode`, because factory_start always creates interactive runs. */
  async function startOrResume(params: z.infer<typeof startSchema> & { mode?: Run['mode'] }, { entry, ws }: { entry: RootEntry; ws: Workspace }, ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    let run: Run;
    const notes: string[] = [];
    let warned = '';
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
          throw new Error(`The headless fix budget is fixed at ${slice.roundLimit} rounds so resume does not raise it. "${feature}" stays stalled. ${stallNotice(current, slice)}`);
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
        warned = recordSelfHostWarning(latest, ws.root);
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
      run = await startRun(ws, {
        annotate: created => {
          for (const note of notes) addEvent(created, 'autonomous', note);
          warned = recordSelfHostWarning(created, ws.root);
        },
        feature: params.feature,
        mode,
        sessionId,
        source: loaded.source,
      });
    }
    bindRun(entry.pointer, { feature: run.feature, mainId: ctx.agent.id, ws });
    await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ORCHESTRATION_TOOLS])]);
    const summary = summarize(ws, run);
    const open = summary.openReview;
    const openText =
      open === undefined
        ? ''
        : `\nOpen review ${open.reviewId}: Data file: ${open.dataFile}; Reference dir: ${open.referenceDir}; Findings dir: ${open.findingsDir}; domains with no submission: ${open.missingDomains.length === 0 ? 'none' : open.missingDomains.join(', ')}; validation submitted: ${open.validated ? 'yes' : 'no'}`;
    return reply(
      `Run "${run.feature}" is ${run.status}. Checks: ${run.checks.join('; ')}. Models: ${describeModels(run.models)}. Slice budget: ${ws.config.sliceTokenBudget} tokens. Fix rounds per slice: ${run.mode === 'headless' ? HEADLESS_FIX_ROUNDS : ws.config.maxRounds}.${warned}\nNext: ${nextAction(run)}${openText}`,
      summary,
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
    run: async ({ feature, resume, source }, target, ctx) => {
      const started = await startOrResume({ feature, resume, source }, target, ctx);
      let gitWarning: string | undefined;
      try {
        gitWarning = checkGit();
      } catch {
        gitWarning = undefined;
      }
      if (gitWarning === undefined) return started;
      return reply(`${started.content[0]?.text ?? ''}\n${gitWarning}`, started.details);
    },
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
        if (run.status !== 'intake' && run.status !== 'running') throw new Error(`Run "${feature}" is ${run.status}; factory_pause pauses a running or intake run.`);
        markPaused(run, params.reason);
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
          `Slice ${slice.id} "${slice.title}" on ${slice.branch} (phase ${slice.phase}).\nTicket: ${ticketPath(ws, run.feature, slice)}\nImplementer report file: ${reportPath(ws, run.feature, slice)}\nChecks that factory_checks runs in full after the implementer commits (the implementer runs only the typecheck, the test files it touched, and the test files that assert on output it changed): ${run.checks.join('; ')}\nContext budget: ${ws.config.sliceTokenBudget} tokens.\nNext: ${nextAction(run)}`,
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
        const first = await applyReslice(ws, current, planReslice(ws, current, params.slices));
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
      const stall = result.stalled ? await decideStall(ctx, ws, feature, 'checks') : '';
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

  registerReviewTools(tool, submit);

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
      const stall = result.stalled ? await decideStall(ctx, ws, feature, 'other') : '';
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
      const submitted = await submit(ws, feature);
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
        sendContinuation(`Resume software-factory run "${feature}": read skill://software-factory, call factory_start with resume "${feature}", then continue from its next action.`);
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
          const { failure, output } = await withRun(target, feature, current => submitStack(target, current, progress));
          // The run saved its submit event with the PRs; a failed step after the push is still the command's error.
          if (failure !== undefined) throw failure;
          ctx.ui.notify(output.trim() || 'Stack submitted.', 'info');
        } finally {
          ctx.ui.setStatus('factory-submit', undefined);
        }
        return;
      }
      if (verb === 'headless') {
        if (argument === '') throw new Error('Usage: /factory headless <issue ref> [--related <ref>,<ref>,...]');
        // The command starts the run itself, so its mode is headless whatever the model does next.
        const target = headlessTarget(argument);
        const feature = target.feature;
        const source = target.source;
        await startOrResume({ feature, mode: 'headless', source }, { entry: await cachedRoot(ctx.cwd), ws }, ctx);
        sendContinuation(`A headless software-factory run "${feature}" is started for: ${argument}\nRead skill://software-factory and continue it from its next action (${nextAction(readRun(ws, feature))}).`);
        return;
      }
      sendContinuation(`Start a software-factory run for: ${args.trim()}\nRead skill://software-factory and follow it.`);
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
    const decision = stopDecision(run, event.session_id, stopAttempts.get(feature), event.messages);
    if (decision.action === 'allow') return;
    if (decision.action === 'wait') {
      stopAttempts.delete(feature);
      return;
    }
    if (decision.action === 'pause') {
      stopAttempts.delete(feature);
      await withRun(ws, feature, current => pauseRun(current, `no progress after ${MAX_IDLE_STOP_ATTEMPTS} stop attempts; ${describeStop(event.messages)}`));
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
