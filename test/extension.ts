import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import softwareFactory from '../src/index.ts';

type Registered = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

export type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

export type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

/** Registers the extension against a recording `pi` and returns its tools by name; `activated` collects what setActiveTools gets, `handlers` records its event hooks, `commands` its slash commands, `thinking` gives pi.getThinkingLevel. */
export function load(activated: string[] = [], handlers = new Map<string, Handler>(), commands = new Map<string, Command>(), thinking: () => string | undefined = () => 'off') {
  const tools = new Map<string, Registered>();
  const pi = {
    getActiveTools: () => [],
    getThinkingLevel: thinking,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool(tool: Registered) {
      tools.set(tool.name, tool);
    },
    setActiveTools: async (names: string[]) => {
      activated.push(...names);
    },
    setLabel() {},
  };
  softwareFactory(pi as unknown as ExtensionAPI);
  return tools;
}

export type TestContext = { agent: { depth: number; id: string; kind: 'main' | 'sub'; name: string }; cwd: string; hasUI: boolean };

export const ctx = (kind: 'main' | 'sub', name: string): TestContext => ({ agent: { depth: 1, id: `${name}-1`, kind, name }, cwd: process.cwd(), hasUI: false });
