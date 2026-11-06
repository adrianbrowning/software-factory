# Coding Standards

Reviewers check every change against these rules.

## omp event hooks

The handlers for `before_subagent_spawn`, `turn_end` and `session_stop` run in every omp session, not only in a factory run.

- Outside a factory run, a hook does nothing and never throws. That includes a cwd outside any git repo, a missing or broken factory.json, and a run that is paused or done.
- A hook finds the active run through the workspace the run remembers from factory_start or resume. It never reloads factory.json, so a mid-run edit cannot change a running run.
- When a factory-role spawn cannot be routed (its model no longer resolves, or the run state cannot be read), the hook blocks the spawn with a reason that names the role. It never drops the routing in silence.

## Module state in tests

`src/index.ts` and `src/agents.ts` keep run state at module level, and every test in a file shares it. A test fixture that starts runs calls `resetModuleState()` first, so a test passes or fails on its own state alone.
