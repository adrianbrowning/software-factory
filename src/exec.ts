import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export type CommandResult = { durationMs: number; exitCode: number; stderr: string; stdout: string; timedOut: boolean };

/** Bytes kept per stream. The tail is kept because failure summaries print last. */
const MAX_CAPTURE_BYTES = 1_000_000;
const KILL_GRACE_MS = 5_000;
/** After the shell exits, how long a background process may keep its pipes open before they are closed. */
const PIPE_DRAIN_MS = 1_000;

/** Keeps the last `MAX_CAPTURE_BYTES` of a stream. Decoding happens once at the end, so no character is split. */
class Tail {
  #chunks: Buffer[] = [];
  #bytes = 0;

  push(chunk: Buffer) {
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes - (this.#chunks[0]?.byteLength ?? 0) >= MAX_CAPTURE_BYTES) {
      this.#bytes -= this.#chunks.shift()?.byteLength ?? 0;
    }
  }

  text() {
    const all = Buffer.concat(this.#chunks);
    return all.subarray(Math.max(0, all.byteLength - MAX_CAPTURE_BYTES)).toString('utf8');
  }
}

/**
 * Runs `command` through `sh -c` (with `env`, default the process environment) in its own process group, so a timeout or `signal` abort kills the whole tree.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  const stdout = new Tail();
  const stderr = new Tail();
  let timedOut = false;
  let settled = false;
  const child = spawn('sh', ['-c', command], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const killGroup = (killSignal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, killSignal);
    } catch {
      // The group already exited.
    }
  };
  let forceKill: NodeJS.Timeout | undefined;
  let drain: NodeJS.Timeout | undefined;
  const stop = () => {
    killGroup('SIGTERM');
    forceKill ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const finish = (exitCode: number, extraError = '') => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceKill);
    clearTimeout(drain);
    signal?.removeEventListener('abort', stop);
    resolve({ durationMs: Date.now() - started, exitCode, stderr: stderr.text() + extraError, stdout: stdout.text(), timedOut });
  };
  child.on('error', error => finish(127, error.message));
  child.on('exit', () => {
    drain = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_DRAIN_MS);
  });
  child.on('close', code => finish(code ?? 1));
  if (signal?.aborted) stop();
  return promise;
}

const execFileAsync = promisify(execFile);
/** git and gh never wait on a credential or confirmation prompt. */
const NON_INTERACTIVE = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: NON_INTERACTIVE, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return stdout;
}

export async function gh(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('gh', args, { cwd, env: NON_INTERACTIVE, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  return stdout;
}
