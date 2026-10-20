import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export type CommandResult = { durationMs: number; exitCode: number; stderr: string; stdout: string; timedOut: boolean };

const MAX_CAPTURE = 1_000_000;
const KILL_GRACE_MS = 5_000;

function capture(chunks: string[], size: { bytes: number }, chunk: Buffer) {
  if (size.bytes >= MAX_CAPTURE) return;
  const text = chunk.toString('utf8').slice(0, MAX_CAPTURE - size.bytes);
  size.bytes += text.length;
  chunks.push(text);
}

/** Runs `command` through `sh -c` in its own process group so a timeout kills the whole tree. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSize = { bytes: 0 };
  const errSize = { bytes: 0 };
  let timedOut = false;
  const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group already exited.
    }
  };
  let forceKill: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    forceKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
  }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => capture(stdout, outSize, chunk));
  child.stderr.on('data', (chunk: Buffer) => capture(stderr, errSize, chunk));
  const finish = (exitCode: number, extraError = '') => {
    clearTimeout(timer);
    clearTimeout(forceKill);
    resolve({
      durationMs: Date.now() - started,
      exitCode,
      stderr: stderr.join('') + extraError,
      stdout: stdout.join(''),
      timedOut,
    });
  };
  child.on('error', error => finish(127, error.message));
  child.on('close', code => finish(code ?? 1));
  return promise;
}

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function gh(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
