# Agent Instructions

This repository is an omp plugin: `src/` holds the extension and its gates, `skills/software-factory/` the
orchestrator workflow, and `agents/` the implementer, reviewer, and validator definitions. Gates belong in
`src/`, judgement in the skill and agents.

The plugin opens PRs only through the user-invoked `/factory submit` command, and never merges.
