# Sandcastle Factory

A small issue-to-reviewed-branch loop for an existing repository. It loads one
authorized GitHub issue, asks a Sandcastle agent to implement it, gates every
code-changing run with deterministic checks, processes structured review
findings, and verifies the result.

It deliberately does not manage sub-issues, pull requests, stacks, or merges.

## Install in a repository

Initialize Sandcastle and choose the blank template:

```sh
pnpm dlx @ai-hero/sandcastle init
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
  setupCommand: [
    'pnpm install --frozen-lockfile',
    'pnpm dlx skills add adrianbrowning/agent-skills -s cc-pr-review-ci -a claude-code -y',
    'printf \'.claude/skills/\\nskills-lock.json\\n\' >> "$(git rev-parse --git-path info/exclude)"',
  ].join(' && '),
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

`setupCommand` also installs the `cc-pr-review-ci` skill (from
`adrianbrowning/agent-skills`, tracking `HEAD`, no pinning) at the project level
and appends its installed paths (`.claude/skills/`, `skills-lock.json`) to
`info/exclude` so the implementer agent cannot commit them. Known risk: because
those paths are ignored, the implementer can edit the skill before review without
it showing in the diff; a prompt-injected issue could weaken the reviewer.

Provider selection is also explicit near the executable bootstrap:

```ts
const AGENT_PROVIDER = 'claude-code';
const BUILD_MODEL = 'claude-opus-5-5';
const REVIEW_MODEL = 'claude-opus-5-5';
```

The included adapter supports `claude-code`. Replace the adapter deliberately
if the provider selected during `sandcastle init` differs; do not rely on an
implicit provider override. `BUILD_MODEL` drives implement/fix runs and
`REVIEW_MODEL` drives the review run; change either independently.

## Run an issue

Add the authorization label, then pass an issue from a trusted repository:

```sh
node .sandcastle/main.mts 42
node .sandcastle/main.mts 'owner/repository#42'
node .sandcastle/main.mts https://github.com/owner/repository/issues/42
```

Issue authorization is checked on the host before sandbox provisioning. GitHub
credentials are not passed through the issue-loading path to coding or repair
agents. Issue text, check output, and review findings are delimited as untrusted
evidence. Agent prompts forbid network tools and credential inspection.

The review round runs the `cc-pr-review-ci` skill as a local run (no PR
number) against `${baseRef}...HEAD`; the issue is still passed as
`<untrusted-issue>` evidence of intended scope. The reviewer follows only the
skill's own instructions and prints the skill's `review.json` inside
`<review>...</review>`. Only `critical` and `high` findings block completion
and drive repair; `observation` findings are reported but non-blocking and are
still included in the final result.

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

## Run from a file

Paste an issue from elsewhere (Jira, a doc, a chat thread) into a text file and
pass it with `--file` instead of an issue reference. Exactly one of the two is
required.

```sh
node .sandcastle/main.mts --file ./issue.md
node .sandcastle/main.mts --file ./issue.md --review-only
```

The file is read on the host, never in the sandbox, and skips the GitHub
label/author trust gate entirely — the operator supplied the file directly.
The first non-empty line (leading `#`s and whitespace stripped) becomes the
title; the rest of the file, trimmed, becomes the body. The issue is still
wrapped as `<untrusted-issue>` evidence for every agent prompt. The branch
name includes the file name, e.g. `sandcastle/factory/file-issue-<timestamp>`.

## Re-run review

Check out the branch containing the work and pass `--review-only`:

```sh
git switch sandcastle/factory/EXISTING_RUN
node .sandcastle/main.mts 42 --review-only
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
6. Capture repository state and run the nominally read-only `cc-pr-review-ci`
   skill review.
7. Reject the run if the reviewer changed tracked or untracked repository state.
8. Process validated `critical`/`high` findings, then return to all deterministic
   checks; `observation` findings are reported but do not block.
9. After a clean review (no `critical`/`high` findings), rerun every
   deterministic check before declaring success.
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
