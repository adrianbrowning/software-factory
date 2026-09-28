import { exec as execCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';

import {
  parseTaggedReview,
  runFactory,
  type ExecResult,
  type FactoryResult,
  type GitHubIssue,
} from './factory.ts';
import {
  fileIssueSlug,
  githubIssueCommand,
  parseArguments,
  parseFileIssue,
  parseGitHubIssue,
  type IssueTrustPolicy,
} from './github-issue.ts';

export type MainOptions = {
  baseRef: string;
  branchPrefix: string;
  checks: string[];
  checkTimeoutMs: number;
  maxRounds: number;
  setupCommand: string;
  trustPolicy: IssueTrustPolicy;
};

type SandboxRunInput<Agent> = {
  agent: Agent;
  name: 'fix' | 'implement' | 'review';
  prompt: string;
};

export type MainSandbox<Agent> = {
  close: () => Promise<unknown>;
  exec: (command: string) => Promise<ExecResult>;
  run: (input: SandboxRunInput<Agent>) => Promise<{ stdout: string }>;
};

export type MainDependencies<Agent> = {
  buildAgent: Agent;
  createSandbox: (input: { branch: string; setupCommand: string }) => Promise<MainSandbox<Agent>>;
  loadIssue: (command: string) => Promise<ExecResult>;
  now: () => number;
  output: {
    error: (message: string) => void;
    log: (message: string) => void;
  };
  readFile: (path: string) => Promise<string>;
  reviewAgent: Agent;
  setExitCode: (code: number) => void;
};

export type MainOutcome =
  | { result: FactoryResult; status: 'completed' }
  | { error: Error; status: 'error' };

export const DEFAULT_OPTIONS: MainOptions = {
  baseRef: 'origin/main',
  branchPrefix: 'sandcastle/factory',
  checks: ['pnpm lint', 'pnpm typecheck', 'pnpm test'],
  checkTimeoutMs: 10 * 60 * 1_000,
  maxRounds: 3,
  setupCommand: [
    'pnpm install --frozen-lockfile',
    'pnpm dlx skills add adrianbrowning/agent-skills -s cc-pr-review-ci -a claude-code -y',
    'printf \'.claude/skills/\\nskills-lock.json\\n\' >> "$(git rev-parse --git-path info/exclude)"',
  ].join(' && '),
  trustPolicy: {
    requiredLabel: 'factory-approved',
    trustedAuthors: ['owner'],
    trustedRepositories: ['owner/repository'],
  },
};

function errorFrom(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function boundedErrorEvidence(value: string) {
  const limit = 1_000;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

const SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_OUTPUT = 1_000_000;

export async function captureRepositoryState<Agent>(sandbox: MainSandbox<Agent>) {
  const dirtyFiles = `set -euo pipefail
    manifest="$(mktemp)"
    trap 'rm -f "$manifest"' EXIT
    git diff --name-only -z HEAD > "$manifest"
    git ls-files --others --exclude-standard -z >> "$manifest"
    sort -zu "$manifest" -o "$manifest"
    count=0
    total=0
    while IFS= read -r -d '' path; do
      count=$((count + 1))
      (( count <= 10000 )) || exit 65
      if [[ -L "$path" ]]; then
        printf 'link %s %s\\n' "$path" "$(readlink -- "$path")"
      elif [[ -f "$path" ]]; then
        size=$(stat -c %s -- "$path" 2>/dev/null || stat -f %z -- "$path")
        (( size <= 10485760 )) || exit 65
        total=$((total + size))
        (( total <= 52428800 )) || exit 65
        sha256sum -- "$path"
        stat -c 'mode %a %n' -- "$path" 2>/dev/null || stat -f 'mode %Lp %N' -- "$path"
      elif [[ -e "$path" ]]; then
        stat -c 'special %F %a %n' -- "$path" 2>/dev/null || stat -f 'special %HT %Lp %N' -- "$path"
      else
        printf 'deleted %s\\n' "$path"
      fi
    done < "$manifest"`;

  const commands = [
    `set -euo pipefail
      metadata="$(mktemp)"
      trap 'rm -f "$metadata"' EXIT
      git rev-parse HEAD > "$metadata"
      git status --porcelain=v2 --untracked-files=all >> "$metadata"
      git ls-files -s >> "$metadata"
      git config --local --list --show-origin >> "$metadata"
      sha256sum "$metadata"`,
    dirtyFiles,
    'set -euo pipefail; hooks="$(git rev-parse --git-path hooks)"; info="$(git rev-parse --git-path info)"; paths=(); [[ -e "$hooks" ]] && paths+=("$hooks"); [[ -e "$info" ]] && paths+=("$info"); if (( ${#paths[@]} )); then find "${paths[@]}" -maxdepth 2 \\( -type f -o -type l \\) -print0 | sort -z | xargs -0 -r sha256sum; fi',
    'set -euo pipefail; if [[ -d node_modules/.bin ]]; then find node_modules/.bin \\( -type f -o -type l \\) -print0 | sort -z | xargs -0 -r sha256sum; fi',
  ];

  const parts: string[] = [];
  for (const command of commands) {
    const snapshot = await sandbox.exec(
      commandWithTimeout(`bash -lc ${shellQuote(command)}`, SNAPSHOT_TIMEOUT_MS),
    );
    if (snapshot.exitCode !== 0 || snapshot.stdout.length > MAX_SNAPSHOT_OUTPUT) {
      throw new Error('Unable to capture bounded repository state around review');
    }
    parts.push(snapshot.stdout);
  }
  return parts.join('\n');
}

export async function runMain<Agent>(
  dependencies: MainDependencies<Agent>,
  arguments_: string[],
  options: MainOptions = DEFAULT_OPTIONS,
): Promise<MainOutcome> {
  let sandbox: MainSandbox<Agent> | undefined;
  let outcome: MainOutcome;

  try {
    const parsed = parseArguments(arguments_);
    const { reviewOnly } = parsed;

    let issue: GitHubIssue;
    let branch: string;
    if ('filePath' in parsed) {
      dependencies.output.log(`[setup] Loading issue from file ${parsed.filePath}`);
      let fileContents: string;
      try {
        fileContents = await dependencies.readFile(parsed.filePath);
      } catch (value) {
        throw new Error(`Unable to read issue file: ${errorFrom(value).message}`);
      }
      issue = parseFileIssue(fileContents, parsed.filePath);
      dependencies.output.log(`[setup] Loaded issue "${issue.title}" from file`);
      branch = `${options.branchPrefix}/file-${fileIssueSlug(parsed.filePath)}-${dependencies.now()}`;
    } else {
      const loadIssueCommand = githubIssueCommand(parsed.issueReference, options.trustPolicy);

      dependencies.output.log(`[setup] Loading GitHub issue ${parsed.issueReference}`);
      const loadedIssue = await dependencies.loadIssue(loadIssueCommand);
      if (loadedIssue.exitCode !== 0) {
        throw new Error(
          `Unable to load GitHub issue: ${boundedErrorEvidence(loadedIssue.stderr)}`,
        );
      }
      issue = parseGitHubIssue(loadedIssue.stdout, options.trustPolicy);
      dependencies.output.log(`[setup] Loaded issue #${issue.number}: ${issue.title}`);
      branch = `${options.branchPrefix}/${dependencies.now()}`;
    }

    dependencies.output.log(`[setup] Creating sandbox branch ${branch}`);
    sandbox = await dependencies.createSandbox({
      branch,
      setupCommand: options.setupCommand,
    });

    const activeSandbox = sandbox;
    const result = await runFactory({
      baseRef: options.baseRef,
      captureRepositoryState: () => captureRepositoryState(activeSandbox),
      checks: options.checks,
      checkTimeoutMs: options.checkTimeoutMs,
      execute: async (command, { timeoutMs }) => {
        const result = await activeSandbox.exec(commandWithTimeout(command, timeoutMs));
        return { ...result, timedOut: isTimeoutExitCode(result.exitCode) };
      },
      fix: async prompt => {
        await activeSandbox.run({
          agent: dependencies.buildAgent,
          name: 'fix',
          prompt,
        });
      },
      implement: async prompt => {
        await activeSandbox.run({
          agent: dependencies.buildAgent,
          name: 'implement',
          prompt,
        });
      },
      issue,
      maxRounds: options.maxRounds,
      mode: reviewOnly ? 'review-only' : 'implement',
      onStatus: message => dependencies.output.log(message),
      review: async prompt => {
        const review = await activeSandbox.run({
          agent: dependencies.reviewAgent,
          name: 'review',
          prompt,
        });
        return parseTaggedReview(review.stdout);
      },
    });

    dependencies.output.log(JSON.stringify({ branch, issue: issue.url, ...result }, null, 2));
    if (result.status === 'failed') dependencies.setExitCode(1);
    outcome = { result, status: 'completed' };
  } catch (value) {
    const error = errorFrom(value);
    dependencies.setExitCode(1);
    dependencies.output.error(error.message);
    outcome = { error, status: 'error' };
  }

  if (sandbox !== undefined) {
    dependencies.output.log('[setup] Closing sandbox');
    try {
      await sandbox.close();
    } catch (value) {
      const error = errorFrom(value);
      dependencies.setExitCode(1);
      dependencies.output.error(`Unable to close sandbox: ${error.message}`);
      outcome = { error, status: 'error' };
    }
  }

  return outcome;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function commandWithTimeout(command: string, timeoutMs: number) {
  return `timeout --signal=TERM --kill-after=5s ${timeoutMs / 1_000}s sh -lc ${shellQuote(command)}`;
}

export function isTimeoutExitCode(exitCode: number) {
  return exitCode === 124 || exitCode === 137;
}

const exec = promisify(execCallback);
const AGENT_PROVIDER = 'claude-code';
const BUILD_MODEL = 'claude-opus-5-5';
const REVIEW_MODEL = 'claude-opus-5-5';
if (AGENT_PROVIDER !== 'claude-code') throw new Error('Unsupported agent provider');
const configuredBuildAgent = sandcastle.claudeCode(BUILD_MODEL);
const configuredReviewAgent = sandcastle.claudeCode(REVIEW_MODEL);

async function defaultLoadIssue(command: string) {
  try {
    const result = await exec(command);
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (value) {
    if (typeof value !== 'object' || value === null) {
      return { exitCode: 1, stderr: '', stdout: '' };
    }
    const error = value as Record<string, unknown>;
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
    };
  }
}

const defaultDependencies: MainDependencies<sandcastle.AgentProvider> = {
  buildAgent: configuredBuildAgent,
  createSandbox: async ({ branch, setupCommand }) => {
    const sandbox = await sandcastle.createSandbox({
      branch,
      hooks: {
        sandbox: { onSandboxReady: [{ command: setupCommand }] },
      },
      sandbox: docker(),
    });
    return {
      close: () => sandbox.close(),
      exec: command => sandbox.exec(command),
      run: input => sandbox.run({
        agent: input.agent,
        maxIterations: 1,
        name: input.name,
        prompt: input.prompt,
      }),
    };
  },
  loadIssue: defaultLoadIssue,
  now: Date.now,
  output: {
    error: message => console.error(message),
    log: message => console.log(message),
  },
  readFile: path => readFile(path, 'utf8'),
  reviewAgent: configuredReviewAgent,
  setExitCode: code => {
    process.exitCode = code;
  },
};

async function bootstrap() {
  await runMain(defaultDependencies, process.argv.slice(2));
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  await bootstrap();
}
