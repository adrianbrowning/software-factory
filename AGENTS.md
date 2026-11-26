# Agent Instructions

This repository is an omp plugin: `src/` holds the extension and its gates, `skills/software-factory/` the
orchestrator workflow, and `agents/` the implementer, reviewer, and validator definitions. Gates belong in
`src/`, judgement in the skill and agents.

The plugin opens PRs through the user-invoked `/factory submit` command and, for a headless run, by itself as draft PRs when the run is done (or paused on red checks, for the done slices below the red one) and `headless.submission` allows it. It never merges: merging stays manual.

The /factory submit wording sits in four places. When you change it, change all four together:
- `src/index.ts`: the submit confirm dialog, key phrase "open or update one draft PR per slice".
- `src/submit.ts`: the progress line and the `submit` event, key phrase "opening or updating draft PRs".
- `src/headless-submit.ts`: the gate event and the reply, key phrase "opening or updating draft PRs".
- `skills/software-factory/SKILL.md`: section 6 (Hand over) and the headless Hand over line, key phrase "opens or updates one draft PR per slice".

The implementer test-scope wording (the implementer runs only the typecheck, the test files it touched, the test files that assert on output it changed, and the test files the repository names for its kind of change) sits in five places. When you change it, change all five together:
- `agents/factory-implementer.md`: the Running checks section.
- `src/index.ts`: the factory_next reply.
- `src/workflow.ts`: the ticket Checks section and the fix-file header.
- `skills/software-factory/SKILL.md`: section 4 step 2.
- `README.md`: the config table `checks` row.

Writing or reviewing omp event hooks, or tests that share module state: follow CODING_STANDARDS.md.

Prove hook or child-session behavior with a real omp run, see docs/smoke-testing.md.

A change to a `factory_*` tool reply or to documented behavior also updates `skills/software-factory/SKILL.md`, and the README section when the README describes that command or behavior, in the same slice.

Tests run on node:test, not vitest; run one test file with `sh scripts/test.sh <file>` or `pnpm run test <file>`.

A `src/` function is often tested in more than one test file. Its unit tests sit in its own file, for example test/workflow.test.ts for a `src/workflow.ts` function. Tool tests of the `factory_*` tool that calls it sit in test/index.test.ts and in other test/*.test.ts files. When you change a `src/` function, also run the test files of the factory tools that call it. Find them: search test/ for the quoted tool name, for example `'factory_start'`.

Lint with `pnpm run lint`, which runs shellcheck on `scripts/*.sh`; no ESLint config exists, so do not run eslint directly.

When a change makes a `src/` file longer, adds a `src/` file, or moves code between `src/` modules, run `sh scripts/test.sh test/structure.test.ts` before committing. It enforces the 1000-line limit per `src/` file, no ticket decision citations in comments, no runtime import cycles, and no re-export shims between `src/` modules. It also checks that the backticked `src/` paths and camelCase names of CODING_STANDARDS.md still exist; paragraphs marked "past history" are exempt.

`test/structure.test.ts` also checks the implementer test-scope wording places: each file listed above must hold "test files that assert on output", and no other git-tracked file outside `test/` and `AGENTS.md` may. When you add or remove a place, edit the list above; the test reads it.

`test/structure.test.ts` also checks that each file in the submit list above holds the key phrase its bullet gives, so a wording change that drops a phrase in one place fails the test.
