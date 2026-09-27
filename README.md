# Sandcastle Factory

A small issue-to-reviewed-branch loop for an existing repository. It loads one
authorized GitHub issue, asks a Sandcastle agent to implement it, gates every
code-changing run with deterministic checks, processes structured review
findings, and verifies the result.

It deliberately does not manage sub-issues, pull requests, stacks, or merges.

## Install in a repository

Initialize Sandcastle and choose the blank template:

```sh
npx @ai-hero/sandcastle init
```

Copy the three drop-in files into the generated directory:

```sh
cp /path/to/software-factory/drop-in/factory.ts .sandcastle/factory.ts
cp /path/to/software-factory/drop-in/github-issue.ts .sandcastle/github-issue.ts
cp /path/to/software-factory/drop-in/main.mts .sandcastle/main.mts
```

Install Zod if needed:

```sh
pnpm add --save-dev zod
```

Edit `DEFAULT_OPTIONS` in `main.mts`. Replace `owner/repository` with the
receiving repository. A numeric issue reference is always resolved against the
first trusted repository; explicit references are accepted only when listed.
Every loaded issue must carry the configured authorization label and be authored by a configured trusted author.

```ts
export const DEFAULT_OPTIONS = {
  baseRef: 'origin/main',
  branchPrefix: 'sandcastle/factory',
  checks: ['pnpm lint', 'pnpm typecheck', 'pnpm test'],
  checkTimeoutMs: 10 * 60 * 1_000,
  maxRounds: 3,
  setupCommand: 'pnpm install --frozen-lockfile',
  trustPolicy: {
    requiredLabel: 'factory-approved',
    trustedAuthors: ['trusted-maintainer'],
    trustedRepositories: ['owner/repository'],
  },
};
```

The checks run sequentially in the declared order. This is intentional because
lint, typecheck, and test scripts may share generated files or other mutable
state. Configure independent parallelism inside the repository's own scripts if
that repository guarantees it is safe.

Provider selection is also explicit near the executable bootstrap:

```ts
const AGENT_PROVIDER = 'claude-code';
const AGENT_MODEL = 'claude-sonnet-4-6';
```

The included adapter supports `claude-code`. Replace the adapter deliberately
if the provider selected during `sandcastle init` differs; do not rely on an
implicit provider override.

## Run an issue

Add the authorization label, then pass an issue from a trusted repository:

```sh
npx tsx .sandcastle/main.mts 42
npx tsx .sandcastle/main.mts 'owner/repository#42'
npx tsx .sandcastle/main.mts https://github.com/owner/repository/issues/42
```

Issue authorization is checked on the host before sandbox provisioning. GitHub
credentials are not passed through the issue-loading path to coding or repair
agents. Issue text, check output, and review findings are delimited as untrusted
evidence. Agent prompts forbid network tools and credential inspection.

The terminal reports setup, implementation, every check result, repair, review
findings, completion, and failure as they happen:

```text
[implement] Starting issue #42
[round 1/3] Starting
[check] pnpm lint ✓
[check] pnpm typecheck ✓
[check] pnpm test timed out after 600000ms
[repair] Fixing failed checks
```

Check evidence sent to repair agents is redacted for common credential forms
and truncated per stream. Full check logs are not persisted by this drop-in.

Reviewer isolation snapshots fail closed after 30 seconds or 1 MiB of probe
output. Dirty-file hashing is bounded to 10,000 paths, 10 MiB per file, and
50 MiB total; exceeding a bound aborts the run instead of accepting the review.

## Re-run review

Check out the branch containing the work and pass `--review-only`:

```sh
git switch sandcastle/factory/EXISTING_RUN
npx tsx .sandcastle/main.mts 42 --review-only
```

Review-only skips implementation but still runs all checks, repairs failures,
reviews against the issue, processes findings, and reruns checks before every
re-review. The new run writes fixes to a new named branch and never merges
automatically.

## Flow

1. Load, validate, and authorize the issue against the configured trust policy.
2. Create one named Sandcastle branch and sandbox.
3. Implement the issue unless `--review-only` was passed.
4. Run every configured check sequentially with an active timeout.
5. Repair failed checks and rerun all checks; review cannot run while a check is red.
6. Capture repository state and run the nominally read-only review.
7. Reject the run if the reviewer changed tracked or untracked repository state.
8. Process validated findings, then return to all deterministic checks.
9. After a clean review, rerun every deterministic check before declaring success.
10. Stop clean or fail when `maxRounds` is exhausted.
11. Close the sandbox on every success and failure path.

## Developing this drop-in

```sh
pnpm test
pnpm typecheck
git diff --check
```

The test suite exercises `runMain` through fakes, including issue-load,
agent/review, malformed-output, final-failure, exit-code, output, and cleanup
paths. A real Docker/agent smoke test additionally requires local Sandcastle
credentials and a working configured provider.
