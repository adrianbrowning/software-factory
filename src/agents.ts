import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { ModelRole } from './config.ts';
import { activeSlice, type AgentRecord, withRun, type Workspace } from './run.ts';

export const IMPLEMENTER = 'factory-implementer';
export const REVIEWER = 'factory-reviewer';
export const VALIDATOR = 'factory-review-validator';
/** Spawned agent to the role whose snapshotted model routes it. Any agent named `scout` (omp's bundled explorer, or one that replaces it) is the explorer. */
export const SPAWN_ROLES: Partial<Record<string, Exclude<ModelRole, 'orchestrator'>>> = {
  [IMPLEMENTER]: 'implementer',
  [REVIEWER]: 'reviewer',
  [VALIDATOR]: 'validator',
  scout: 'explorer',
};

/** Child sessions in this process whose first turn the audit has handled, so later turns skip it. */
const audited = new Set<string>();
/** Spawns the routing hook routed whose child has not taken its first turn, per repository root, spawning agent and agent name. */
const routedSpawns = new Map<string, { feature: string; ws: Workspace }[]>();
const spawnKey = (root: string, parentId: string | undefined, name: string) => JSON.stringify([root, parentId, name]);

/** Notes a spawn of agent `name` by agent `parentId` that the routing hook routed under `run`, for the audit to claim. */
export function noteRoutedSpawn(parentId: string, name: string, run: { feature: string; ws: Workspace }) {
  const key = spawnKey(run.ws.root, parentId, name);
  routedSpawns.set(key, [...(routedSpawns.get(key) ?? []), run]);
}

/**
 * Records, on the first turn of each factory child and scout session, the model and thinking level omp actually runs
 * it on (a configured fallback included), under the active slice of the run it was routed in. A child is recorded
 * only by claiming a spawn the routing hook noted for its repository, parent and name, so the audit lists exactly the
 * routed children. `rootOf` gives the repository root of a cwd, or undefined outside any git repo; `thinking` is the
 * child session's level.
 */
export async function auditChild(ctx: ExtensionContext, thinking: string | undefined, rootOf: (cwd: string) => Promise<string | undefined>) {
  const role = ctx.agent.kind === 'sub' && Object.hasOwn(SPAWN_ROLES, ctx.agent.name) ? SPAWN_ROLES[ctx.agent.name] : undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (role === undefined || audited.has(sessionId)) return;
  audited.add(sessionId);
  if (routedSpawns.size === 0) return;
  const root = await rootOf(ctx.cwd);
  if (root === undefined) return;
  const key = spawnKey(root, ctx.agent.parentId, ctx.agent.name);
  const [spawn, ...rest] = routedSpawns.get(key) ?? [];
  if (spawn === undefined) return;
  if (rest.length === 0) routedSpawns.delete(key);
  else routedSpawns.set(key, rest);
  const model = ctx.model === undefined ? 'unset' : `${ctx.model.provider}/${ctx.model.id}`;
  const entry: AgentRecord = { agentId: ctx.agent.id, model, name: ctx.agent.name, role, sessionId, thinking: thinking ?? 'unset' };
  await withRun(spawn.ws, spawn.feature, run => {
    const slice = activeSlice(run)?.id;
    run.agents.push(slice === undefined ? entry : { ...entry, slice });
  });
}
