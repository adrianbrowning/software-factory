import { z } from 'zod';

/** The run's check commands that count as typecheck commands: those whose text matches /\btypecheck\b/. */
export function typecheckCommands(checks: string[]) {
  return checks.filter(check => /\btypecheck\b/.test(check));
}

const EXIT_SUFFIX = '; echo "exit $?"';

const bashResult = z.object({
  content: z.array(z.object({ text: z.string().optional(), type: z.string() }).loose()).default([]),
  details: z.object({ async: z.object({ state: z.unknown().optional() }).optional(), exitCode: z.unknown().optional(), timedOut: z.unknown().optional() }).loose().nullish(),
  input: z.object({ command: z.string() }).loose(),
  isError: z.boolean().optional(),
  toolName: z.literal('bash'),
});

/**
 * The typecheck command and exit code of an unfiltered run in a bash tool_result event, or undefined when it does not count.
 * It counts when the trimmed input.command is exactly a typecheck command of `checks`, or exactly one followed by
 * `; echo "exit $?"`; a result that came back before the command finished (a background job) or timed out never counts.
 * The exact form's exit code is details.exitCode when it is a number, else 0 (omp's bash tool sets it only for a non-zero
 * exit); the suffix form's is the N of the last output line matching /^exit (\d+)$/, and without such a line the run does not count.
 * A suffix-form result with isError true never counts: a completed suffix-form run exits 0 through the echo, so an error
 * result is a cancelled, timed-out or unfinished run whose partial output may still hold an exit line.
 */
export function observeTypecheck(event: unknown, checks: string[]) {
  const parsed = bashResult.safeParse(event);
  if (!parsed.success) return undefined;
  const { content, details, input, isError } = parsed.data;
  if (details?.timedOut === true) return undefined;
  if (details?.async !== undefined && details.async.state !== 'completed') return undefined;
  const command = input.command.trim();
  const commands = typecheckCommands(checks);
  const exact = commands.find(candidate => candidate === command);
  if (exact !== undefined) {
    if (typeof details?.exitCode === 'number') return { command: exact, exit: details.exitCode };
    return { command: exact, exit: 0 };
  }
  const suffixed = commands.find(candidate => command === `${candidate}${EXIT_SUFFIX}`);
  if (suffixed === undefined || isError === true) return undefined;
  const text = content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
  const last = text.split(/\r?\n/).map(line => /^exit (\d+)$/.exec(line)).filter(match => match !== null).at(-1);
  return last === undefined ? undefined : { command: suffixed, exit: Number(last[1]) };
}

/** The Factory-observed typecheck section lines for `checks`, one per typecheck command, and the commands with no counted run. */
export function observedTypecheck(checks: string[], runs: Record<string, number> | undefined) {
  const lines: string[] = [];
  const missing: string[] = [];
  for (const command of typecheckCommands(checks)) {
    const exit = runs?.[command];
    if (exit === undefined) {
      lines.push(`no unfiltered run of \`${command}\` seen in this implementer session`);
      missing.push(command);
    } else {
      lines.push(`\`${command}\` → exit ${exit} (last unfiltered run the factory saw in this implementer session)`);
    }
  }
  return { lines, missing };
}

/** The reply line for a typecheck command the factory saw no unfiltered run of. */
export function missingTypecheckLine(command: string) {
  return `The factory saw no unfiltered run of \`${command}\` in this implementer session: run it as its own bash call with no filter, read its exit code, and call factory_implementer_report again.`;
}
