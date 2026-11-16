import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { z } from 'zod';
import { pauseAtStall } from '../headless-submit.ts';
import { activeSlice, readRun, stallNotice, withRun, type Workspace } from '../run.ts';
import { resolveStall } from '../workflow.ts';
import type { Reply } from '../tool-scope.ts';

export const STALL_DESCRIPTION =
  'A used-up fix budget asks the user to continue or pause; a paused run stalls until /factory resume, which asks whether to raise the budget.';

export const emptySchema = z.object({});

export function reply(text: string, details?: unknown): Reply {
  return { content: [{ text, type: 'text' }], details };
}

/** Asks the user how to continue once a slice's fix budget is used up. Without a UI the run pauses. `source` is where the stall came from: only the checks name it red; a stalled fix or review reads the same. */
export async function decideStall(ctx: ExtensionContext, ws: Workspace, feature: string, source: 'checks' | 'other') {
  const run = readRun(ws, feature);
  const slice = activeSlice(run);
  if (slice === undefined || !slice.stalled) return '';
  if (run.mode === 'headless') return pauseAtStall(ws, feature, run, slice, source);
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
