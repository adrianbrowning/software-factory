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
