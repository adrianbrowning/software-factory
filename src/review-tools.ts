import { REVIEWER, VALIDATOR } from './agents.ts';
import { deferItems, describeSink, requireSink } from './deferred.ts';
import { evidenceHead } from './evidence.ts';
import { confirmInteractive, gate } from './gates.ts';
import { carryObservations, fixObservations, planCarry, planDefer, planFix } from './observations.ts';
import { completeSlice, recordReview, startReview, submitDomain, submitValidation, validationSchema } from './review.ts';
import { activeSlice, addEvent, findingSchema, fixVerdictSchema, readRun, REQUIRED_REVIEW_DOMAINS, REVIEW_DOMAINS, skippedDomainsSchema, ticketPath, withRun } from './run.ts';
import { submitHeadless } from './headless-submit.ts';
import type { RunTool } from './tool-scope.ts';
import { nextAction } from './workflow.ts';
import { decideStall, emptySchema, reply, STALL_DESCRIPTION } from './tool-replies.ts';
import { z } from 'zod';

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

/** Registers the review, completion and observation-placement tools. */
export function registerReviewTools(tool: RunTool) {
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
      if (result.kind === 'green') {
        const [orLead, sinkTail] = ws.config.deferred === undefined ? ['or ', ''] : ['', ', or sent to the deferred sink (factory_defer with their ids)'];
        const notes =
          result.observations.length > 0
            ? `\nObservations (non-blocking):\n${result.observations.join('\n\n')}\nAsk the user where each goes: fixed in this slice (factory_fix with their ids), carried into the ticket of a pending slice (factory_carry with their ids and that slice id), ${orLead}queued for one follow-up slice at the end of the run (factory_carry with their ids and to "end")${sinkTail}. This slice stays green when they are carried.`
            : '';
        const bug = '\nWhen the user finds a bug in this slice before it is done, call factory_fix with the bug (and any observation ids).';
        return reply(`Review is green.${notes}${bug}\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      if (result.kind === 'accepted-unresolved') {
        return reply(
          `Review is accepted unresolved: the fix budget is used up, and a headless run does not raise it. Open:\n${result.unresolved.join('\n')}\nThe slice counts as green with these items on record.\nNext: ${nextAction(readRun(ws, feature))}`,
        );
      }
      const stall = result.stalled ? await decideStall(ctx, ws, feature, 'other') : '';
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
      `After a green review, send the active slice back to the fix loop for a bug the user found in it (bug), review observations the user chose to fix in this slice (observations), or both, after the user agreed. Observation ids must be in the active slice's green review; ids only a done slice's review lists are refused (use factory_reopen or factory_follow_up). Writes a tracked fix file; a round with a bug counts toward the fix budget, an observation-only round does not and never stalls the slice. The slice earns checks and a new review before factory_complete_slice. ${STALL_DESCRIPTION}`,
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
      const body = `${params.reason}\n\n${items.join('\n')}\n\nThe green review ${planned.review.id} is dropped. The implementer fixes these in fix mode, then the slice gets checks and a new review again.${planned.bug === undefined ? '' : ' The round counts toward the fix budget.'}`;
      const title = planned.observations.length === 0 ? 'Fix a bug' : planned.bug === undefined ? 'Fix observations' : 'Fix a bug and observations';
      if (!(await gate(ctx, ws, feature, 'fix', `${title} in slice ${planned.slice.id} "${planned.slice.title}"?`, body))) {
        return reply(`The user kept the green review. Ask how to handle the observations or the bug, or call factory_complete_slice.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const result = await withRun(ws, feature, run => fixObservations(ws, run, params, params.reason));
      const stall = result.stalled ? await decideStall(ctx, ws, feature, 'other') : '';
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
}

/** Registers factory_defer. Separate so index.ts keeps the tool's original place in the registration order. */
export function registerDeferTool(tool: RunTool) {
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
      const sink = describeSink(requireSink(ws));
      const items = planned.map(draft => `- ${draft.id ?? 'Note'}: ${evidenceHead(draft.title, 200)}`);
      if (!(await confirmInteractive(ctx, ws, feature, `Defer ${planned.length} items to ${sink.name}?`, `${items.join('\n')}\n\nSink: ${sink.line}.`))) {
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
}
