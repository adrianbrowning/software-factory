# Coding Standards

Reviewers check every change against these rules.

## omp event hooks

The handlers for `before_subagent_spawn`, `turn_end` and `session_stop` run in every omp session, not only in a factory run.

- Outside a factory run, a hook does nothing and never throws. Outside a factory run means the repo has no remembered run: a cwd outside any git repo, a missing or broken factory.json, or no factory_start or resume. A paused or done run is still a factory run. `turn_end` still records a child's actual model and thinking level on its first turn while the run is remembered (decision 14), and `before_subagent_spawn` still routes or blocks factory-role spawns from the run snapshot. Only `scout` (explorer) spawns go unrouted unless the run is in intake or running (decisions 5 and 12).
- A hook finds the active run through the workspace the run remembers from factory_start or resume. It never reloads factory.json, so a mid-run edit cannot change a running run.
- When a factory-role spawn cannot be routed (its model no longer resolves, or the run state cannot be read), the hook blocks the spawn with a reason that names the role. It never drops the routing in silence.

## Module state in tests

`src/index.ts` and `src/agents.ts` keep run state at module level, and every test in a file shares it. Every test file that loads the extension calls `resetModuleState()` in a `beforeEach` hook, so each test starts with no runs, stop attempts, cached roots or audited sessions, and passes or fails on its own state alone. Never reset inside a fixture: a second fixture call in the same test must keep the runs the first one started.

## Refusal messages

A refusal or error message that names a next step must name a step that works in the state that produced the refusal, and a test runs that step once after the refusal. Example: the ambiguity refusal in `resolveObservations` told the orchestrator to carry the items as a free-text note, but a note-only `factory_carry` needs an active slice with a green review, and the refusal happened with no active slice.

## Review data sections in tests

Tests that assert on a section of a review data file extract it with `dataSection` or `fixItems` from `test/helpers.ts`, not with an inline regex that names the next section. Adding a section then breaks no test.

## Reply lines in tests

A test outside the feature that owns a reply or summary line matches only that line's stable part, for example the command and the exit code. Only the owning feature's tests pin the full wording, so a wording change breaks one test file.

## Tests for a changed branch

When a change alters a default or a branch condition, search the tests for the input that the changed branch reads. Check each test that sets that input. Each such test must still prove the behavior its name gives, or you update it. Example: `defaultChoice` changed so that a correctness observation on a `fromEndQueue` slice defaults to fix. Three sibling follow-up tests moved to `missing-test`, but the re-sliced follow-up test was missed, and it then passed for the wrong reason.

## Script env in tests

A test that spawns a script with `process.env` controls every variable the script reads. Otherwise the result depends on the developer's or CI's shell.

- Pin every external binary that has an env variable (for example `OMP`) through that variable, set to the fake's absolute path. Never reach such a fake through the script's default lookup (a fake under the default name on `PATH`): if the default changes, the real binary runs (#409).
- A binary the script has no env variable for (for example `gh` in `scripts/headless-backlog.sh`) is reached through a `PATH` the test builds with the fake dir first. A test that must never run the real binary uses a `PATH` that holds only the fake dir and linked tools. The rule above stays for binaries that have an env variable (`OMP`).
- Test a binary's default in its own test, with a `PATH` that holds only the fake dir and linked tools. A wrong default then fails as not found instead of running the real binary.
- Remove every other variable the script reads from the inherited env, unless the test sets it on purpose. Do not set a variable whose default is the behavior under test, because the value masks the default.

Example: `test/headless-backlog.test.ts` spawns `scripts/headless-backlog.sh`, which reads `OMP` and `LOG_DIR`. It sets `OMP` to `join(bin, ',omp')`, the fake's absolute path, so a local `OMP` or a changed script default can never start the real omp. It removes `LOG_DIR` from the env it passes, so the script's default log dir stays under test.

## One-line agent text

Free text that an agent wrote (a reviewer, validator, implementer or issue) and that a one-line field shows (a location, a title, a `Symbol` line) goes through `evidenceLine` from `src/evidence.ts`. It redacts credential shapes, collapses all whitespace to one line and clips to a limit. Never pass such text through `evidence`, `evidenceHead` or `redact` alone, and never show it raw: each leaves newlines or unbounded length in a field that must stay on one line.

Every rendering of one field uses one shared helper, not its own `evidence` or `evidenceLine` call. A finding's location is `findingLocation` in `src/ledger.ts`. A second rendering that formats the same field on its own drifts from the first.

Example (issue #589, past history): slice 01 put the reviewer-written symbol into location lines without redact, clip or single-line. Slice 04 fixed `findingLocation` with `evidenceLine(symbol, 200)`, and the review then found `filedLocation` in `src/finding-text.ts` still used `evidence(symbol, 500)`, so the same field rendered two ways.

## Event order in tests

A test that needs one event before another (stdout before stderr, one callback before another) orders them by a handshake or backpressure: the test or script waits until the first event is observed, then triggers the next. Never order events with a fixed sleep or timer. A fixed sleep passes on an idle machine and fails under load, for example parallel reviewer agents (issue 348).

A sleep that bounds a duration, not an order, is allowed: a check that must outlast a timeout (`sleep 5` with a smaller `checkTimeoutMs` in `test/review-gates-checks.test.ts`) or a process that must be killed (`sleep 30` in `test/units.test.ts`).

Example (forbidden): the `runShell` cases in `test/units.test.ts` run `echo out; sleep 0.2; echo err >&2` to get stdout before stderr. Under load the 0.2 s gap can pass before the first chunk is read, and the order is no longer guaranteed. Handshake alternative: the script writes `out`, then blocks on a FIFO or a file that the test creates only after its stdout callback has seen `out`, and only then writes `err` to stderr.
