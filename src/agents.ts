import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { SpawnRole } from './config.ts';
import { activeSlice, type AgentRecord, withRun, type Workspace } from './run.ts';

export const IMPLEMENTER = 'factory-implementer';
export const REVIEWER = 'factory-reviewer';
export const VALIDATOR = 'factory-review-validator';
/**
 * Spawned agent to the role whose snapshotted model routes it. Any agent named `scout` (omp's bundled explorer, or one
 * that replaces it) is the explorer. A Map, so an agent named after an Object prototype key has no role.
 */
export const SPAWN_ROLES = new Map<string, SpawnRole>([
  [IMPLEMENTER, 'implementer'],
  [REVIEWER, 'reviewer'],
  [VALIDATOR, 'validator'],
  ['scout', 'explorer'],
]);

/**
 * Child sessions whose first turn this process has audited, so only a first turn is audited. A session joins it once
 * its record is saved, or once its first turn found nothing to record; a failed write leaves it for a later turn.
 * It does not dedupe records.
 */
const turned = new Set<string>();

/**
 * Records the model and thinking level omp actually runs a factory child or scout session on (a configured fallback
 * included), under the active slice of the run, routed or not: the record states what ran. A child is recorded when
 * its name is in SPAWN_ROLES, the main session that started or resumed the run spawned it (its parentId is that
 * session's agent id), and its first audited turn in this process ends while the run exists. Once per session is
 * enforced from the run's stored records by session id, so a session resumed in a new process is not recorded again.
 * `active` is the child's active run, or undefined outside any run or git repo; `thinking` is the child session's level.
 */
export async function auditChild(
  ctx: ExtensionContext,
  thinking: string | undefined,
  active: { feature: string; mainId: string; ws: Workspace } | undefined,
) {
  const role = ctx.agent.kind === 'sub' ? SPAWN_ROLES.get(ctx.agent.name) : undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (role === undefined || turned.has(sessionId)) return;
  if (active === undefined || ctx.agent.parentId !== active.mainId) {
    turned.add(sessionId);
    return;
  }
  const model = ctx.model === undefined ? 'unset' : `${ctx.model.provider}/${ctx.model.id}`;
  const entry: AgentRecord = { agentId: ctx.agent.id, model, name: ctx.agent.name, role, sessionId, thinking: thinking ?? 'unset' };
  await withRun(active.ws, active.feature, run => {
    if (run.agents.some(agent => agent.sessionId === sessionId)) return;
    const slice = activeSlice(run)?.id;
    run.agents.push(slice === undefined ? entry : { ...entry, slice });
  });
  turned.add(sessionId);
}
