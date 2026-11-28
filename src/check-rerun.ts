/** The rerun of a failed check: the targeted run of its failed test files, the whole-command run that decides, and the summary lines that describe them. */
import type { CheckRun } from './check-log.ts';
import { evidenceLine } from './evidence.ts';
import { type CommandResult, runShell } from './exec.ts';
import type { Workspace } from './run.ts';

const MAX_NAMED_TESTS = 10;
/** Spec entries (`test at`, `✖ name`) and `FAIL` lines longer than this are skipped: a check can print a megabyte-long whitespace line. TAP `not ok` lines are not length-limited. */
const MAX_PARSED_LINE = 2_000;

const parsable = (line: string | undefined) => (line !== undefined && line.length <= MAX_PARSED_LINE ? line : undefined);

const outputLines = ({ stderr, stdout }: CommandResult) => `${stdout}\n${stderr}`.split(/\r?\n/);

/** The `test at <location>` lines of a node:test spec `✖ failing tests:` section that a `✖ <name> (<duration>)` line follows. */
function specFailures(lines: string[]) {
  const found: { index: number; name: string; where: string }[] = [];
  const section = lines.indexOf('✖ failing tests:');
  if (section < 0) return found;
  for (let i = section + 1; i < lines.length; i++) {
    const at = parsable(lines[i])?.match(/^test at (.+)$/);
    const name = parsable(lines[i + 1])?.match(/^✖ (.*?) \([\d.]+m?s\)\s*$/);
    // The rest of the line, trimmed: a lazy group before `\s*$` backtracks quadratically on a long run of spaces.
    const where = at?.[1]?.trim();
    if (where && name) found.push({ index: i, name: name[1] ?? '', where });
  }
  return found;
}

/** What a check's first failure reported: its failing tests (node:test spec `✖ failing tests:` entries, TAP `not ok` lines), else its last non-empty output line. */
function firstFailureNames(result: CommandResult) {
  const { lastStream, stderr, stdout } = result;
  const lines = outputLines(result);
  const names = new Set<string>();
  for (const { name, where } of specFailures(lines)) names.add(evidenceLine(`${where} ${name}`));
  for (const line of lines) {
    const tap = line.match(/^\s*not ok \d+ - (.+)$/);
    if (tap) names.add(evidenceLine(tap[1] ?? ''));
  }
  if (names.size === 0) {
    for (const stream of lastStream === 'stderr' ? (['stderr', 'stdout'] as const) : (['stdout', 'stderr'] as const)) {
      const last = (stream === 'stderr' ? stderr : stdout).split(/\r?\n/).findLast(line => line.trim() !== '');
      if (last !== undefined) return `; last ${stream} line: ${evidenceLine(last, 299)}`;
    }
    return '';
  }
  const listed = [...names].slice(0, MAX_NAMED_TESTS).join(', ');
  const rest = names.size - MAX_NAMED_TESTS;
  return `; failing tests: ${listed}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** The failed test files a run's output names, first-seen order, each once: vitest/jest `FAIL <file>` lines and node:test spec `test at <file>:<line>:<col>` entries. */
export function failedTestFiles(result: CommandResult) {
  const lines = outputLines(result);
  const found: { file: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const file = parsable(line)?.match(/^\s*FAIL\s+(.+?)(?: > | \(| \[|$)/)?.[1]?.trim();
    if (file) found.push({ file, index });
  });
  for (const { index, where } of specFailures(lines)) {
    const file = where.replace(/:\d+:\d+$/, '');
    if (file !== where) found.push({ file, index });
  }
  const files = new Set(found.sort((a, b) => a.index - b.index).map(({ file }) => file));
  return [...files].filter(file => !file.startsWith('-'));
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The template with every `{files}` replaced by `"$@"`, after a `set --` prefix that holds the files single-quoted: the output text never enters the template, so it never runs as shell code whatever quoting the template puts around `{files}` (a quoted placeholder may get wrong arguments). */
export function targetedCommand(template: string, files: string[]) {
  return `set -- ${files.map(shellQuote).join(' ')}; ${template.replaceAll('{files}', () => '"$@"')}`;
}

/**
 * Runs each failed check again. A check with a `rerunFiles` template whose first run names failed test files first
 * runs only those files (up to `rerunFilesTries` runs, stopping at the first pass or at a timeout). Then every failed
 * check runs once more as a whole command, and that run decides the check. Sets `first`, `result` and, when a targeted
 * run passed, `targeted` on the entry. The targeted runs' output is kept nowhere.
 */
export async function rerunFailedChecks(ws: Workspace, results: CheckRun[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const { checkTimeoutMs, rerunFiles, rerunFilesTries } = ws.config;
  for (const entry of results) {
    if (entry.result.exitCode === 0 || entry.result.timedOut) continue;
    signal?.throwIfAborted();
    entry.first = entry.result;
    const template = Object.entries(rerunFiles).find(([key]) => key.trim() === entry.command.trim())?.[1];
    const files = template === undefined ? [] : failedTestFiles(entry.first);
    if (template !== undefined && files.length > 0) {
      const command = targetedCommand(template, files);
      for (let attempt = 1; attempt <= rerunFilesTries; attempt++) {
        signal?.throwIfAborted();
        const run = await runShell(command, ws.root, checkTimeoutMs, signal, env);
        if (run.timedOut) break;
        if (run.exitCode === 0) {
          entry.targeted = { files, passedOn: attempt, tries: rerunFilesTries };
          break;
        }
      }
    }
    signal?.throwIfAborted();
    entry.result = await runShell(entry.command, ws.root, checkTimeoutMs, signal, env);
  }
}

function describeRun(command: string, result: CommandResult) {
  if (result.timedOut) return `${command}: timed out`;
  return `${command}: ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`} in ${result.durationMs}ms`;
}

/** The summary line of a check: its single run, or its first failed run and the rerun that decided it. */
export function describeCheck({ command, first, result, targeted }: CheckRun) {
  if (first === undefined) return describeRun(command, result);
  const listed = targeted?.files.slice(0, MAX_NAMED_TESTS).map(file => evidenceLine(file)).join(', ');
  const rest = (targeted?.files.length ?? 0) - MAX_NAMED_TESTS;
  const targetedPart = targeted === undefined ? '' : `; failed test files passed on targeted try ${targeted.passedOn} of ${targeted.tries}: ${listed}${rest > 0 ? ` and ${rest} more` : ''}`;
  const firstRun = `first failed (exit ${first.exitCode}) in ${first.durationMs}ms`;
  if (result.exitCode === 0 && !result.timedOut) return `${command}: passed on rerun, flaky (${firstRun}${firstFailureNames(first)}${targetedPart})`;
  return `${describeRun(command, result)} on rerun (${firstRun}${targetedPart})`;
}
