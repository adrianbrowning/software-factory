import { evidenceLine } from './evidence.ts';
import { addEvent, readRun, type Run, type Slice, stallNotice, withRun, type Workspace } from './run.ts';
import { doneBelow, type Stop, submitStack } from './submit.ts';
import { pauseRun } from './workflow.ts';

/** Saves `detail` as a `kind` event unless the run already has it, so a repeated submission records its choice once. */
function addOnce(ws: Workspace, feature: string, kind: string, detail: string) {
  return withRun(ws, feature, run => {
    if (!run.events.some(event => event.kind === kind && event.detail === detail)) addEvent(run, kind, detail);
  });
}

/**
 * A headless run's own submission: when the run is done, opens draft PRs for the whole stack; with `stop` (the slice a
 * paused run stopped at), opens them for the done slices below it, whose bodies say where and why the stack stopped.
 * Returns the reply text, empty when the run is not headless or not at that point. A stopped stack with no done slice
 * below the stop opens nothing and records nothing. A policy of submission "stop" opens nothing and records that once
 * as a `submission-stop` event (not an autonomous one: the policy chose it). A gh failure does not undo the work the
 * tool already saved: it is recorded as a `submit-failed` event and reported in the text, and the run stays done
 * (`/factory submit` retries) or paused. Merging stays manual.
 */
export async function submitHeadless(ws: Workspace, feature: string, stop?: Stop) {
  const run = readRun(ws, feature);
  if (run.mode !== 'headless' || run.status !== (stop === undefined ? 'done' : 'paused')) return '';
  if (run.landOn !== undefined) return `\nThis run lands on ${run.landOn}, so it opens no PRs: /factory submit fast-forwards it.`;
  if (stop !== undefined && doneBelow(run, stop.slice).length === 0) return `\nNo done slice is below slice ${stop.slice.id}, so no PRs were opened.`;
  if (ws.config.headless.submission === 'stop') {
    await addOnce(ws, feature, 'submission-stop', 'gate submission (stop): no PRs opened');
    return `\nThe headless policy sets submission to stop, so no PRs were opened. ${stop === undefined ? '/factory submit opens them.' : 'After /factory resume finishes the stack, /factory submit opens them.'}`;
  }
  // Saved before submitStack runs, so a later failure cannot discard the choice; each PR body lists it.
  await addOnce(ws, feature, 'autonomous', `gate submission (auto): opening or updating draft PRs${stop === undefined ? '' : ` for the slices below slice ${stop.slice.id}`}`);
  const retry = stop === undefined ? '/factory submit retries it' : 'after /factory resume finishes the stack, /factory submit opens the PRs';
  const failed = (message: string) => `\nSubmission failed: ${message}\nThe run is saved as ${run.status}; ${retry}.`;
  try {
    return await withRun(ws, feature, async current => {
      const { failure, output } = await submitStack(ws, current, () => {}, stop);
      if (failure === undefined) return `\nDraft PRs are open (merging stays manual):\n${output}`;
      // The PRs are on GitHub: the submit event stays with this failure.
      addEvent(current, 'submit-failed', evidenceLine(failure.message, 500));
      return failed(failure.message);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withRun(ws, feature, current => addEvent(current, 'submit-failed', evidenceLine(message, 500)));
    return failed(message);
  }
}

/**
 * A headless run never prompts to raise the fix budget: a stalled slice pauses the run, and the done slices below it are
 * submitted. `source` is where the stall came from: only the checks name the slice red. Returns the reply text.
 */
export async function pauseAtStall(ws: Workspace, feature: string, run: Run, slice: Slice, source: 'checks' | 'other') {
  const round = Math.max(...slice.fixItems.map(item => item.round));
  const failing = slice.fixItems.filter(item => item.round === round).map(item => item.summary);
  const reason = source === 'checks'
    ? `slice ${slice.id} "${slice.title}" is still red after ${slice.roundLimit} fix rounds: ${failing.join('; ')}`
    : `slice ${slice.id} "${slice.title}" used up its ${slice.roundLimit} fix rounds; open: ${failing.join('; ')}`;
  await withRun(ws, feature, current => pauseRun(current, reason));
  const submitted = await submitHeadless(ws, feature, { reason, slice });
  return `\nThe headless run is paused: ${reason}. ${stallNotice(run, slice)}${submitted} Stop now.`;
}
