import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type GitArchHost = {
  /** Describes a binary, as `file -b` does. */
  describe: (path: string) => string;
  exists: (path: string) => boolean;
  /** Resolves symlinks so the binary that actually runs is described. */
  realpath: (path: string) => string;
  arch: string;
  path: string | undefined;
  platform: string;
};

const SYSTEM_GIT = '/usr/bin/git';

export function defaultGitArchHost(): GitArchHost {
  return {
    arch: process.arch,
    describe: path => execFileSync('file', ['-b', path], { encoding: 'utf8', timeout: 5000 }),
    exists: existsSync,
    realpath: realpathSync,
    path: process.env.PATH,
    platform: process.platform,
  };
}

function firstExecutable(name: string, host: GitArchHost): string | undefined {
  for (const dir of (host.path ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (host.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Warns when the first git on PATH is x86_64-only on Apple Silicon; undefined otherwise or when detection fails. */
export function gitArchWarning(host: GitArchHost = defaultGitArchHost()): string | undefined {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return undefined;
  try {
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
