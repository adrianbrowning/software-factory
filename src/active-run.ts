import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configSchema } from './config.ts';
import { type Workspace, writeAtomic } from './run.ts';

/** The run a repository checkout is bound to, with the workspace it started or resumed with and the agent id of the main session that bound it. */
export type ActiveRun = { feature: string; mainId: string; ws: Workspace };

/** What the pointer file holds. The root is the checkout the file belongs to, so it is not stored. */
const pointerSchema = z.object({ config: configSchema, feature: z.string().min(1), mainId: z.string() });

/**
 * Binds the checkout to `active` in `pointer`, a file in its git dir: outside the configurable scratchDir, and per worktree.
 * Every extension copy of the checkout (omp loads one per worker thread) resolves the run from it, with the config the run
 * started with, so a later factory.json edit does not move the run state.
 */
export function bindRun(pointer: string, active: ActiveRun) {
  writeAtomic(pointer, JSON.stringify({ config: active.ws.config, feature: active.feature, mainId: active.mainId }));
}

/** The run bound in `pointer`, or undefined when there is no file or it is not a pointer this version wrote (`/factory resume` rebinds). */
export function boundRun(pointer: string, root: string): ActiveRun | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pointer, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = pointerSchema.safeParse(raw);
  return parsed.success ? { feature: parsed.data.feature, mainId: parsed.data.mainId, ws: { config: parsed.data.config, root } } : undefined;
}
