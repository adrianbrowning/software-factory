import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { resolve } from 'node:path';
import { z } from 'zod';
import { boundRun } from './active-run.ts';
import type { IMPLEMENTER, REVIEWER, VALIDATOR } from './agents.ts';
import { loadConfig } from './config.ts';
import { git } from './exec.ts';
import type { Workspace } from './run.ts';
import { repoRoot } from './workflow.ts';

const POINTER_FILE = 'software-factory-active-run.json';

export const NO_ACTIVE_RUN = 'No active factory run. Start one with /factory <issue>, or /factory resume <feature>.';

type Caller = 'main' | typeof IMPLEMENTER | typeof REVIEWER | typeof VALIDATOR;

function callerOf(ctx: Pick<ExtensionContext, 'agent'>) {
  return ctx.agent.kind === 'main' ? 'main' : ctx.agent.name;
}

/** The repository root and its checkout's pointer file, which lives in its own git dir so each worktree binds its own run. */
export type RootEntry = { pointer: string; root: string };
const roots = new Map<string, RootEntry>();

export async function cachedRoot(cwd: string) {
  let entry = roots.get(cwd);
  if (entry === undefined) {
    const root = await repoRoot(cwd);
    entry = { pointer: resolve(root, (await git(root, 'rev-parse', '--git-dir')).trim(), POINTER_FILE), root };
    roots.set(cwd, entry);
  }
  return entry;
}

/** Test-only: clears the cached roots and pointer paths. */
export function resetRoots() {
  roots.clear();
}

/** The run the checkout at `root` is bound to, with the workspace it started or resumed with, so it never reloads factory.json. */
export const boundAt = ({ pointer, root }: RootEntry) => boundRun(pointer, root);

export type Reply = { content: { text: string; type: 'text' }[]; details: unknown };

type ToolDefinition<S extends z.ZodType, Scope> = {
  caller: Caller;
  description: string;
  essential?: boolean;
  label: string;
  name: string;
  run: (input: z.infer<S>, scope: Scope, ctx: ExtensionContext, signal: AbortSignal | undefined) => Promise<Reply>;
  schema: S;
};

export function toolRegistrar(pi: ExtensionAPI) {
  /** Registers a tool whose parameters are the JSON Schema of `schema`; `schema` is also the only runtime parse. `scopeOf` builds what `run` receives from the checkout's cache entry. */
  function register<S extends z.ZodType, Scope>(
    definition: Omit<ToolDefinition<S, Scope>, 'run'>,
    scopeOf: (entry: RootEntry) => Scope,
    run: ToolDefinition<S, Scope>['run'],
  ) {
    pi.registerTool({
      defaultInactive: definition.essential !== true,
      description: definition.description,
      label: definition.label,
      loadMode: 'essential',
      name: definition.name,
      parameters: z.toJSONSchema(definition.schema) as Record<string, unknown>,
      async execute(_id, raw, signal, _onUpdate, ctx) {
        const caller = callerOf(ctx);
        if (caller !== definition.caller) throw new Error(`Only the ${definition.caller} agent may call this tool (caller: ${caller}).`);
        const parsed = definition.schema.safeParse(raw);
        if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
        return run(parsed.data, scopeOf(await cachedRoot(ctx.cwd)), ctx, signal);
      },
    });
  }

  /** A tool that works on the bound run. `scope.feature` and `scope.ws` are read from the pointer once per call; the run keeps the workspace it started with, so a mid-run factory.json edit does not move its state. */
  function tool<S extends z.ZodType>(definition: ToolDefinition<S, { feature: string; ws: Workspace }>) {
    register(
      definition,
      entry => {
        const bound = boundAt(entry);
        if (bound === undefined) throw new Error(NO_ACTIVE_RUN);
        return bound;
      },
      definition.run,
    );
  }

  /** A tool that binds the run itself: it gets the cache entry and the current factory.json instead of the workspace a bound run started with. */
  function startTool<S extends z.ZodType>(definition: ToolDefinition<S, { entry: RootEntry; ws: Workspace }>) {
    register(definition, entry => ({ entry, ws: { config: loadConfig(entry.root), root: entry.root } }), definition.run);
  }

  return { startTool, tool };
}
