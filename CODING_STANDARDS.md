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

## Tests for a changed branch

When a change alters a default or a branch condition, search the tests for the input that the changed branch reads. Check each test that sets that input. Each such test must still prove the behavior its name gives, or you update it. Example: `defaultChoice` changed so that a correctness observation on a `fromEndQueue` slice defaults to fix. Three sibling follow-up tests moved to `missing-test`, but the re-sliced follow-up test was missed, and it then passed for the wrong reason.

## Script env in tests

A test that spawns a script with `process.env` removes from the inherited env every variable the script reads, unless the test sets that variable on purpose. Otherwise the result depends on the developer's or CI's shell. A test reaches fake external binaries through the script's default lookup (for example a fake under the default name on `PATH`) or through an env variable the test sets on purpose, never through whatever the inherited env holds. A test does not set a variable whose default is the behavior under test, because the value masks the default. Example: `test/headless-backlog.test.ts` spawns `scripts/headless-backlog.sh`, which reads `OMP` and `LOG_DIR`. An inherited `OMP` or `LOG_DIR` changed what the script ran and where it logged, so the test removes `LOG_DIR` from the env it passes, and the script's default log dir stays under test. It sets `OMP` on purpose to the fake omp, so a local `OMP` can never start the real one (fixed in 678b124).
