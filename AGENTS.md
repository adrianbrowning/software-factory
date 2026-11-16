# Agent Instructions

This repository is an omp plugin: `src/` holds the extension and its gates, `skills/software-factory/` the
orchestrator workflow, and `agents/` the implementer, reviewer, and validator definitions. Gates belong in
`src/`, judgement in the skill and agents.

The plugin opens PRs through the user-invoked `/factory submit` command and, for a headless run, by itself as draft PRs when the run is done (or paused on red checks, for the done slices below the red one) and `headless.submission` allows it. It never merges: merging stays manual.

Writing or reviewing omp event hooks, or tests that share module state: follow CODING_STANDARDS.md.

Prove hook or child-session behavior with a real omp run, see docs/smoke-testing.md.
