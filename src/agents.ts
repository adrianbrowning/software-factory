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

/** Child sessions in this process whose turn the audit has handled, so later turns skip the run state. */
const audited = new Set<string>();

/**
 * Records, on the first turn of each factory child and scout session, the model and thinking level omp actually runs
 * it on (a configured fallback included), under the active slice. Only a direct child of the main session that runs
 * the factory is recorded, as only its spawns are routed; a scout only while the run is in intake or running, the
 * states in which its spawn is routed. `findRun` locates the child's run; `thinking` is the child session's level.
 */
export async function auditChild(
  ctx: ExtensionContext,
  thinking: string | undefined,
  findRun: (ctx: ExtensionContext) => Promise<{ feature: string; mainId: string; ws: Workspace } | undefined>,
) {
  const role = ctx.agent.kind === 'sub' && Object.hasOwn(SPAWN_ROLES, ctx.agent.name) ? SPAWN_ROLES[ctx.agent.name] : undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (role === undefined || audited.has(sessionId)) return;
  const found = await findRun(ctx);
  if (found === undefined || ctx.agent.parentId !== found.mainId) return;
  const model = ctx.model === undefined ? 'unset' : `${ctx.model.provider}/${ctx.model.id}`;
  const entry: AgentRecord = { agentId: ctx.agent.id, model, name: ctx.agent.name, role, sessionId, thinking: thinking ?? 'unset' };
  await withRun(found.ws, found.feature, run => {
    if (role === 'explorer' && run.status !== 'intake' && run.status !== 'running') return;
    if (run.agents.some(agent => agent.sessionId === sessionId)) return;
    const slice = activeSlice(run)?.id;
    run.agents.push(slice === undefined ? entry : { ...entry, slice });
  });
  audited.add(sessionId);
}
