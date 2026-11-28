import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export type GitArchHost = {
  /** Describes a binary, as `file -b` does. */
  describe: (path: string) => string;
  exists: (path: string) => boolean;
  /** True for a regular file the process may execute, as execFile's lookup requires. */
  isExecutable: (path: string) => boolean;
  /** Resolves symlinks so the binary that actually runs is described. */
  realpath: (path: string) => string;
  /** Prints `sysctl -n hw.optional.arm64`: "1" on Apple Silicon even for a Rosetta-run Node. */
  sysctlArm64: () => string;
  arch: string;
  path: string | undefined;
  platform: string;
};

const SYSTEM_GIT = '/usr/bin/git';

/**
 * The real host. `timeouts` sets the `execFileSync` timeout in milliseconds of the file probe
 * (`describeMs`, default 5000) and of the sysctl probe (`sysctlMs`, default 2000).
 */
export function defaultGitArchHost({ describeMs = 5000, sysctlMs = 2000 }: { describeMs?: number; sysctlMs?: number } = {}): GitArchHost {
  return {
    arch: process.arch,
    describe: path => execFileSync('file', ['-b', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: describeMs }),
    exists: existsSync,
    isExecutable: path => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    realpath: realpathSync,
    sysctlArm64: () => execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: sysctlMs }),
    path: process.env.PATH,
    platform: process.platform,
  };
}

function firstExecutable(name: string, host: GitArchHost): string | undefined {
  for (const dir of (host.path ?? '').split(delimiter)) {
    const candidate = dir === '' ? resolve(name) : join(dir, name);
    if (host.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Warns when the first git on PATH is x86_64-only on Apple Silicon; undefined otherwise or when detection fails. */
export function gitArchWarning(host: GitArchHost = defaultGitArchHost()): string | undefined {
  if (host.platform !== 'darwin') return undefined;
  try {
    if (host.arch !== 'arm64' && host.sysctlArm64().trim() !== '1') return undefined;
    const git = firstExecutable('git', host);
    if (git === undefined) return undefined;
    const info = host.describe(host.realpath(git));
    if (!info.includes('x86_64') || info.includes('arm64')) return undefined;
    const faster = host.exists(SYSTEM_GIT) ? ` Put ${SYSTEM_GIT} (the faster git) or an arm64 git first on PATH.` : ' Put an arm64 git first on PATH.';
    return `Warning: git on PATH (${git}) is an x86_64 build that runs under Rosetta and slows every factory git call.${faster}`;
  } catch {
    return undefined;
  }
}
