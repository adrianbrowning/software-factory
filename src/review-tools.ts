import { REVIEWER, VALIDATOR } from './agents.ts';
import { deferItems, describeSink, itemKey, requireSink } from './deferred.ts';
import { evidenceHead, evidenceLine } from './evidence.ts';
import { confirmInteractive, gate } from './gates.ts';
import { placeObservations } from './ledger.ts';
import { defaultChoice, describeChoice, describePlan, placeObservationBatch, placementSchema, planPlace } from './place.ts';
import { carryObservations, fixObservations, leaveObservations, planCarry, planDefer, planFix, planLeave } from './observations.ts';
import { renderFinding } from './finding-text.ts';
import { completeSlice, recordReview, startReview, submitDomain, submitValidation } from './review.ts';
import { validationSchema } from './review-record.ts';
import { activeSlice, addEvent, findingSchema, fixVerdictSchema, readRun, REQUIRED_REVIEW_DOMAINS, REVIEW_DOMAINS, skippedDomainsSchema, ticketPath, withRun } from './run.ts';
import { submitHeadless } from './headless-submit.ts';
import type { RunTool } from './tool-scope.ts';
import { nextAction } from './workflow.ts';
import { decideStall, emptySchema, reply, STALL_DESCRIPTION } from './tool-replies.ts';
import { recordSelfHostWarning } from './self-host.ts';
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
    .describe('Ids of unplaced observations of any review of the active slice, red ones too, that the user chose to fix in this slice, for example "thermo-naming" (or "<review>:<id>" when two reviews kept the same id)'),
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
    .describe('Ids of observations from the active slice\'s green review, that the user chose to carry, for example "thermo-naming". Refused until the slice\'s last green review is a full one; a note alone is not'),
  to: z
    .union([z.string().regex(/^\d{2}$/), z.literal('end')])
    .describe('Id of the pending slice whose ticket takes the work, for example "03"; or "end": the work waits on the run for the next factory_follow_up slice'),
});
const placeSchema = z.object({
  placements: z
    .array(placementSchema)
    .describe('The exceptions: a placement for each observation the user wants placed other than by default. Every unplaced observation not listed gets its default; [] accepts all defaults'),
});
const deferSchema = z.object({
  note: z.string().optional().describe('Work to send to the deferred sink in full. Give it, observations, or both'),
  observations: z
    .array(z.string().min(1))
    .optional()
    .describe('Ids of observations from the active slice\'s green review, to send to the deferred sink, for example "thermo-naming". Ids the run already placed (carried, deferred, fixed or left) are refused, and so are all ids until the slice\'s last green review is a full one'),
});
const leaveSchema = z.object({
  observations: z
    .array(z.string().min(1))
    .min(1)
    .describe('Ids of observations from the active slice\'s green review, that the user chose to leave as they are, for example "thermo-naming". Ids the run already placed (carried, deferred, fixed or left) are refused, and so are all ids until the slice\'s last green review is a full one'),
});

/** Registers the review, completion and observation-placement tools. `submit` is a headless run's own submission; tests replace it. */
export function registerReviewTools(tool: RunTool, submit: typeof submitHeadless = submitHeadless) {
  tool({
    caller: 'main',
    description: `Freeze the reviewed state and write the review data file. Then spawn one factory-reviewer per domain. The factory skips react-ts, test-validity, and devops by changed paths unless kept; skip any other domain the diff gives nothing to review, with a reason. ${REQUIRED_REVIEW_DOMAINS.join(' and ')} always review, and testing does too for a slice with test seams. After a red review the review is targeted: the factory picks the domains, call it with no skips; skip and keep apply to a full review only.`,
    label: 'Factory: start review',
    name: 'factory_review_start',
    schema: reviewStartSchema,
    async run(params, { feature, ws }) {
      return withRun(ws, feature, async run => {
        const review = await startReview(ws, run, params.skip, params.keep);
        const warned = recordSelfHostWarning(run, ws.root);
        const byPath = review.pathSkipped.length === 0 ? '' : `\nSkipped by path: ${review.pathSkipped.map(entry => `${entry.domain} (${entry.reason})`).join('; ')}.`;
        return reply(
          `Review ${review.reviewId} is open.${byPath}${warned}\nData file: ${review.dataFile}\nReference dir: ${review.referenceDir}\nFindings dir: ${review.findingsDir}\nRun the reviewers and the validator in one eval step (timeout 0; the software-factory skill has the snippet in section 4, step 6). Spawn one ${REVIEWER} per domain with agent(): ${review.domains.join(', ')}. Give each its domain, the review id, the data file, and the reference file <reference dir>/<domain>.md. With the kernel wait(), wait for every reviewer, then spawn one ${VALIDATOR} with the review id, the data file, the findings dir, and the reference dir, and wait for it (it may correct its validation once). Then call factory_review_record.`,
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
        const bug = '\nWhen the user finds a bug in this slice before it is done, call factory_fix with the bug (and any observation ids).';
        const run = readRun(ws, feature);
        const slice = activeSlice(run);
        if (result.final && slice !== undefined && slice.unplaced.length > 0) {
          const listed = slice.unplaced.map(entry => `${renderFinding(entry.finding, run.decisions)}\n- Category: ${entry.category}\n- Review: ${entry.review}\n- Default placement: ${describeChoice(defaultChoice(ws, run, slice, entry))}`).join('\n\n');
          if (run.mode === 'headless') {
            return reply(
              `Review is green, and it is the slice's final review.\nUnplaced observations of slice ${slice.id} (every review's, with the default placement of each); factory_complete_slice places them by default, so there is nothing to ask the user:\n${listed}${bug}\nNext: ${nextAction(run)}`,
            );
          }
          return reply(
            `Review is green, and it is the slice's final review.\nUnplaced observations of slice ${slice.id} (every review's, with the default placement of each):\n${listed}\nShow the user one ask with these defaults preselected, then call factory_place once with only the exceptions (placements [] takes every default): fix in this slice, carry to a pending slice (to), end (the queue for one follow-up slice), defer to the sink, or leave. factory_complete_slice refuses while any is unplaced.${bug}\nNext: ${nextAction(run)}`,
          );
        }
        const notes = result.observations.length > 0 ? `\nObservations (non-blocking), placed after the slice's final full review:\n${result.observations.join('\n\n')}` : '';
        return reply(`Review is green.${notes}${bug}\nNext: ${nextAction(run)}`);
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
    description:
      'After the slice\'s final full green review, place every unplaced observation of the slice in one batch, after the user agreed to the defaults and exceptions: fix (back to the fix loop, no fix budget used), carry to a pending slice (to), end (the queue for the next factory_follow_up slice), defer (the deferred sink) or leave. List only the exceptions; each other unplaced observation gets its default by category (correctness, missing-test to end, except correctness on a follow-up slice built from end-queue items, which is fixed in this slice like misleading-doc; misleading-doc to fix in this slice, unless the slice already had an observation placed as fixed, then to end; naming, structure, style to leave). One confirm asks in an interactive run. Refuses an id already placed or not unplaced on the slice.',
    label: 'Factory: place observations',
    name: 'factory_place',
    schema: placeSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses a slice without a final green review, unknown or already placed ids, without a dialog.
      const planned = planPlace(ws, readRun(ws, feature), params);
      if (planned.items.length === 0) return reply(`Slice ${planned.slice.id} has no unplaced observations.\nNext: ${nextAction(readRun(ws, feature))}`);
      if (!(await confirmInteractive(ctx, ws, feature, `Place ${planned.items.length} observations of slice ${planned.slice.id}?`, `${describePlan(planned.items)}\n\nSlice ${planned.slice.id} keeps its green review unless a fix is chosen, which sends it back to the fix loop.`))) {
        return reply(`The user did not place the observations. Ask how to handle them.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const { failure, fixed, lines, rest } = await withRun(ws, feature, async run => {
        const plan = planPlace(ws, run, params);
        const chosen = plan.items.filter(item => item.choice === 'fix').map(item => itemKey(item.entry.review, item.entry.finding.id));
        // Validate the fix round before anything is filed: a refusal after a deferral would roll the state back and keep the issue.
        if (chosen.length > 0) planFix(ws, run, { observations: chosen });
        const placed = await placeObservationBatch(ws, run, plan);
        const fixed = placed.fixes.length === 0 ? undefined : fixObservations(ws, run, { observations: placed.fixes }, 'Chosen in the batched placement after the slice\'s final review.');
        // Only what the ledger holds now was placed: a failed deferral and the fix round that waits on it are not.
        const done = plan.items.filter(item => run.observations.some(entry => entry.key === itemKey(item.entry.review, item.entry.finding.id)));
        return { failure: placed.failure, fixed, lines: done.map(item => `${item.entry.finding.id}: ${describeChoice(item.choice, item.target?.id)}`), rest: placed.slice.unplaced.map(entry => entry.finding.id) };
      });
      if (failure !== undefined) {
        throw new Error(`The deferred sink failed: ${evidenceLine(failure.message, 500)}. Placed so far:\n${lines.join('\n')}\nStill unplaced: ${rest.join(', ')}. No fix round started; call factory_place again for them.`);
      }
      const back = fixed === undefined ? '' : `\nSlice ${planned.slice.id} is back in fix. Fix file: ${fixed.fixPath}`;
      return reply(`Placed:\n${lines.join('\n')}${back}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description: 'Mark the green slice done. Refuses while the slice has unplaced observations (factory_place); a headless run places them by default first, and when a default is a fix (misleading-doc, or correctness on a follow-up slice built from end-queue items) it starts the observation-only fix round, leaves the slice active in fix and names the fix file. HEAD must be the reviewed commit. A reopened slice rebases every later slice branch onto its fix.',
    label: 'Factory: complete slice',
    name: 'factory_complete_slice',
    schema: emptySchema,
    async run(_params, { feature, ws }) {
      const { finished, message: done } = await withRun(ws, feature, async run => {
        const reopened = activeSlice(run)?.doneSha !== undefined;
        const slice = await completeSlice(ws, run);
        if (slice.status !== 'done') {
          if (slice.fixPath === undefined) throw new Error(`Slice ${slice.id} is back in fix without a fix file.`);
          return { finished: false, message: `Slice ${slice.id} is back in fix: its default placement fixes observations in this slice. Fix file: ${slice.fixPath}` };
        }
        const restacked = reopened ? ' Every later slice branch is rebased onto it and earns its checks and review again.' : '';
        return { finished: true, message: `Slice ${slice.id} is done on ${slice.branch}.${restacked}` };
      });
      const submitted = finished ? await submit(ws, feature) : '';
      return reply(`${done}${submitted}\nNext: ${nextAction(readRun(ws, feature))}`);
    },
  });

  tool({
    caller: 'main',
    description:
      `After a green review, send the active slice back to the fix loop for a bug the user found in it (bug), review observations the user chose to fix in this slice (observations), or both, after the user agreed. Observation ids are unplaced observations of any review of the active slice, red ones too (\`<review>:<id>\` when two reviews kept the same id). Writes a tracked fix file; a round with a bug counts toward the fix budget, an observation-only round does not and never stalls the slice. The slice earns checks and a new review before factory_complete_slice. ${STALL_DESCRIPTION}`,
    label: 'Factory: fix observations or a bug',
    name: 'factory_fix',
    schema: fixSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses a call with neither a bug nor observations, a slice without a green review, an id that is not one of
      // its observations, without a dialog.
      const planned = planFix(ws, readRun(ws, feature), params);
      const items = [
        ...(planned.bug === undefined ? [] : [`- Bug: ${evidenceHead(planned.bug, 1_000)}`]),
        ...planned.observations.map(finding => `- ${finding.id}: ${finding.title}`),
      ];
      const what = planned.labels.join(', ');
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
      'After a green review, carry review observations the user chose (observations), a free-text note (note), or both into the ticket of a pending slice (to), or with to "end" onto the run\'s queue for the next factory_follow_up slice, after the user agreed. Observation ids come from the active slice\'s green review and are refused until its last green review is a full one (a note alone is not). The target slice builds them and its reviewers check them; the slice they come from keeps its green review. The retro waits until the queue is empty.',
    label: 'Factory: carry work into a pending slice',
    name: 'factory_carry',
    schema: carrySchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses empty input, a slice without a green review, an id its green review does not list,
      // or a target that is neither "end" nor a pending slice, without a dialog.
      const planned = planCarry(ws, readRun(ws, feature), params);
      const items = [
        ...(planned.note === undefined ? [] : [`- Note: ${evidenceHead(planned.note, 1_000)}`]),
        ...planned.observations.map(finding => `- ${finding.id}: ${finding.title}`),
      ];
      const what = planned.labels.join(', ');
      const { destination } = planned;
      const builder =
        destination.kind === 'end'
          ? 'They wait on the run: the next factory_follow_up slice builds them, and its reviewers check them. The retro waits until then.'
          : `Slice ${destination.slice.id} builds these, and its reviewers check them.`;
      const body = `${items.join('\n')}\n\nSlice ${planned.slice.id} keeps its green review. ${builder}`;
      const title = destination.kind === 'end' ? 'Carry to the end of the run?' : `Carry into slice ${destination.slice.id} "${destination.slice.title}"?`;
      if (!(await gate(ctx, ws, feature, 'carry', title, body))) {
        return reply(`The user did not carry the work. Ask how to handle the observations or the note.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      return withRun(ws, feature, run => {
        const carried = carryObservations(ws, run, params).destination;
        const where =
          carried.kind === 'end'
            ? `Queued ${what} for the next factory_follow_up slice (${run.waiting.length} waiting).`
            : `Carried ${what} into slice ${carried.slice.id} "${carried.slice.title}". Ticket: ${ticketPath(ws, run.feature, carried.slice)}`;
        return reply(`${where}\nNext: ${nextAction(run)}`);
      });
    },
  });

  tool({
    caller: 'main',
    description:
      'Send green-review observations (observations), a free-text note (note), or both to the deferred sink set in .omp/factory.json: one GitHub issue per item (filed at once, URL stored), or the sink file, written later from the items queued on the run. Each item names the run, slice and review. Ids the run already placed (carried, deferred, fixed or left) are refused, and so are all ids until the slice\'s last green review is a full one (a note alone is not). The slice keeps its green review. Accepted-unresolved findings go to the sink by themselves.',
    label: 'Factory: defer to the sink',
    name: 'factory_defer',
    schema: deferSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses a project without a sink, empty input, unknown ids, and ids the run already placed, without a dialog.
      const planned = planDefer(ws, readRun(ws, feature), params);
      const sink = describeSink(requireSink(ws));
      const items = planned.drafts.map(draft => `- ${draft.id ?? 'Note'}: ${evidenceHead(draft.title, 200)}`);
      if (!(await confirmInteractive(ctx, ws, feature, `Defer ${planned.drafts.length} items to ${sink.name}?`, `${items.join('\n')}\n\nSink: ${sink.line}.`))) {
        return reply(`The user did not defer the work. Ask how to handle the observations or the note.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      const { failure, lines, rest } = await withRun(ws, feature, async run => {
        const { drafts, observations, review, slice } = planDefer(ws, run, params);
        const before = run.deferred.length;
        const failed = await deferItems(ws, run, drafts);
        const filed = run.deferred.slice(before);
        placeObservations(run, review, slice, observations.filter(finding => filed.some(item => item.key === itemKey(review.id, finding.id))), 'deferred');
        if (filed.length > 0) addEvent(run, 'defer', `${filed[0]?.review}: ${filed.map(item => item.id ?? 'note').join(', ')}`);
        const rest = drafts.filter(draft => !filed.some(item => item.key === draft.key)).map(draft => draft.id ?? 'the note');
        return { failure: failed, lines: [...filed.map(item => `${item.id ?? 'note'}: ${item.location}`), `Next: ${nextAction(run)}`], rest };
      });
      if (failure !== undefined) {
        throw new Error(`The deferred sink failed: ${evidenceLine(failure.message, 500)}. Filed items stay recorded and are refused if sent again; call factory_defer again with only the rest: ${rest.join(', ')}.\n${lines.join('\n')}`);
      }
      return reply(`Deferred:\n${lines.join('\n')}`);
    },
  });

  tool({
    caller: 'main',
    description:
      'Record green-review observations the user chose to leave as they are (observations), after the user agreed. Nothing builds them and no sink gets them, and no later review of the run raises them again: the validator drops a finding that repeats one. Observation ids come from the active slice\'s green review and are refused until its last green review is a full one. Ids the run already placed (carried, deferred, fixed or left) are refused. The slice keeps its green review.',
    label: 'Factory: leave observations',
    name: 'factory_leave',
    schema: leaveSchema,
    async run(params, { feature, ws }, ctx) {
      // Refuses empty input, unknown ids, and ids the run already placed, without a dialog.
      const planned = planLeave(ws, readRun(ws, feature), params);
      const items = planned.observations.map(finding => `- ${finding.id}: ${evidenceHead(finding.title, 200)}`);
      const body = `${items.join('\n')}\n\nNo slice builds these and no sink gets them, and no later review of the run raises them again. Slice ${planned.slice.id} keeps its green review.`;
      if (!(await confirmInteractive(ctx, ws, feature, `Leave ${planned.observations.length} observations?`, body))) {
        return reply(`The user did not leave the observations. Ask how to handle them.\nNext: ${nextAction(readRun(ws, feature))}`);
      }
      return withRun(ws, feature, run => {
        const left = leaveObservations(ws, run, params);
        return reply(`Left ${left.observations.map(finding => finding.id).join(', ')}.\nNext: ${nextAction(run)}`);
      });
    },
  });
}
