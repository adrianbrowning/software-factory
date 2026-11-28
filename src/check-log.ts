import { join } from 'node:path';
import type { CommandResult } from './exec.ts';
import { redact } from './evidence.ts';
import { runDir, type Run, type Slice, type Workspace, writeAtomic } from './run.ts';

/** A check command and its runs: `first` is the failed first attempt of a check that ran again, `result` the last run. */
export type CheckRun = { command: string; first?: CommandResult; result: CommandResult; targeted?: { files: string[]; passedOn: number; tries: number } };

/**
 * Keeps the first attempt's output of each check that failed and then passed on its rerun, in
 * `<run dir>/checks/<slice id>-f<N>-check<K>-attempt1.log` (N: the slice's fixFiles count, K: the 1-based position of the
 * command in the run's checks). Call it only for a run whose checks all passed: the first attempt output of a flaky check is kept when the checks pass, and a run that ends failed keeps none. The output is redacted, not truncated. Returns the log paths relative to the run dir, in check order.
 */
export function writeFirstAttemptLogs(ws: Workspace, run: Run, slice: Slice, results: CheckRun[]) {
  const dir = runDir(ws, run.feature);
  const written: string[] = [];
  results.forEach(({ command, first, result }, index) => {
    if (first === undefined || result.exitCode !== 0 || result.timedOut) return;
    const relative = join('checks', `${slice.id}-f${slice.fixFiles}-check${index + 1}-attempt1.log`);
    const content = `# First attempt of a check that passed on rerun\n\nCommand: ${redact(command)}\nExit code: ${first.exitCode}\nDuration: ${first.durationMs}ms\n\n## stdout\n\n${redact(first.stdout)}\n\n## stderr\n\n${redact(first.stderr)}\n`;
    writeAtomic(join(dir, relative), content);
    written.push(relative);
  });
  return written;
}
