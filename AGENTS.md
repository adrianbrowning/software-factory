# Agent Instructions

This repository is an omp plugin: `src/` holds the extension and its gates, `skills/software-factory/` the
orchestrator workflow, and `agents/` the implementer, reviewer, and validator definitions. Gates belong in
`src/`, judgement in the skill and agents.

The plugin opens PRs through the user-invoked `/factory submit` command and, for a headless run, by itself as draft PRs when the run is done (or paused on red checks, for the done slices below the red one) and `headless.submission` allows it. It never merges: merging stays manual.

The /factory submit wording sits in four places. When you change it, change all four together:
- `src/index.ts`: the submit confirm dialog.
- `src/submit.ts`: the progress line and the `submit` event.
- `src/headless-submit.ts`: the gate event and the reply.
- `skills/software-factory/SKILL.md`: section 6 (Hand over) and the headless Hand over line.

The implementer test-scope wording (the implementer runs only the typecheck, the test files it touched, the test files that assert on output it changed, and the test files the repository names for its kind of change) sits in five places. When you change it, change all five together:
- `agents/factory-implementer.md`: the Running checks section.
- `src/index.ts`: the factory_next reply.
- `src/workflow.ts`: the ticket Checks section and the fix-file header.
- `skills/software-factory/SKILL.md`: section 4 step 2.
- `README.md`: the config table `checks` row.

Writing or reviewing omp event hooks, or tests that share module state: follow CODING_STANDARDS.md.

Prove hook or child-session behavior with a real omp run, see docs/smoke-testing.md.

Tests run on node:test, not vitest; run one test file with `sh scripts/test.sh <file>` or `pnpm run test <file>`.

When a change makes a `src/` file longer, adds a `src/` file, or moves code between `src/` modules, run `sh scripts/test.sh test/structure.test.ts` before committing. It enforces the 1000-line limit per `src/` file, no ticket decision citations in comments, no runtime import cycles, and no re-export shims between `src/` modules.
