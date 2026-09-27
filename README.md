# Sandcastle Factory

A small issue-to-reviewed-branch loop for an existing repository. It loads one GitHub issue, asks a Sandcastle agent to implement it, gates every code-changing run with deterministic checks, processes structured review findings, and verifies the result.

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

Install Zod if needed, then edit the configuration block at the top of `main.mts`:

```sh
pnpm add --save-dev zod
```

```ts
const BASE_REF = 'origin/main';
const CHECKS = ['pnpm lint', 'pnpm typecheck', 'pnpm test'];
const MAX_ROUNDS = 3;
const SETUP_COMMAND = 'pnpm install --frozen-lockfile';
```

The provided adapter uses Docker and Claude Code. Retain the provider and agent selected by `sandcastle init` if those differ.

## Run an issue

Pass an issue number from the current repository, an explicit repository reference, or a URL:

```sh
npx tsx .sandcastle/main.mts 42
npx tsx .sandcastle/main.mts 'owner/repository#42'
npx tsx .sandcastle/main.mts https://github.com/owner/repository/issues/42
```

The terminal reports setup, implementation, every check result, repair, review findings, completion, and failure as they happen:

```text
[implement] Starting issue #42
[round 1/3] Starting
[check] pnpm lint ✓
[check] pnpm typecheck ✓
[check] pnpm test ✗
[repair] Fixing failed checks
```

## Re-run review

Check out the branch containing the work and pass `--review-only`:

```sh
git switch sandcastle/factory/EXISTING_RUN
npx tsx .sandcastle/main.mts 42 --review-only
```

Review-only skips the implementation agent. It still runs all checks, repairs failures, reviews against the issue, processes findings, and reruns checks before every re-review. The new run writes fixes to a new named branch and never merges automatically.

## Flow

1. Create one named Sandcastle branch and sandbox.
2. Load and validate the issue with `gh issue view`.
3. Implement the issue, unless `--review-only` was passed.
4. Run every configured check through `sandbox.exec()`.
5. Repair failed checks and re-run all checks; review cannot run while a check is red.
6. Run a read-only review against the issue and validate its structured findings.
7. Process findings, then return to all deterministic checks before re-reviewing.
8. Stop clean or fail when `MAX_ROUNDS` is exhausted.

## Developing this drop-in

```sh
pnpm test
pnpm typecheck
```
