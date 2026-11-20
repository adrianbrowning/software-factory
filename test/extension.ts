import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { submitHeadless } from '../src/headless-submit.ts';
import softwareFactory from '../src/index.ts';

type Registered = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
};

export type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

export type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

type LoadOptions = { activated?: string[]; commands?: Map<string, Command>; handlers?: Map<string, Handler>; sent?: string[]; sentOptions?: unknown[]; thinking?: () => string | undefined; checkGit?: () => string | undefined; submit?: typeof submitHeadless | undefined };

/** Registers the extension against a recording `pi` and returns its tools by name; `activated` collects what setActiveTools gets, `handlers` records its event hooks, `commands` its slash commands, `sent` the messages passed to pi.sendUserMessage, `thinking` gives pi.getThinkingLevel, `submit` replaces the headless submission. */
export function load({ activated = [], commands = new Map(), handlers = new Map(), sent = [], sentOptions = [], thinking = () => 'off', checkGit, submit }: LoadOptions = {}) {
  const tools = new Map<string, Registered>();
  const pi = {
    getActiveTools: () => [],
    getThinkingLevel: thinking,
    sendUserMessage(message: string, options?: unknown) {
      sentOptions.push(options);
      sent.push(message);
    },
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
  softwareFactory(pi as unknown as ExtensionAPI, checkGit, submit);
  return tools;
}

export type TestContext = { agent: { depth: number; id: string; kind: 'main' | 'sub'; name: string }; cwd: string; hasUI: boolean };

export const ctx = (kind: 'main' | 'sub', name: string): TestContext => ({ agent: { depth: 1, id: `${name}-1`, kind, name }, cwd: process.cwd(), hasUI: false });
