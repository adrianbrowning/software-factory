# Prose claims about named code

Applies to every diff, docs-only diffs included.

## Scope

A prose line the diff adds or changes in a tracked Markdown file (for example `CODING_STANDARDS.md`, `README.md`, `docs/`, `skills/`, `agents/`) that states how named code behaves: what a function returns or throws for an input, what a mismatch of inputs gives, how it pairs or stores data. Code comments are not covered; the comments domain owns them.

## Check

1. For each such line, read the cited code. Read it outside the diff too: the claim is about the code as it is, not about the lines the diff touches.
2. Compare the claim with what the code does.
3. When the code contradicts the claim, report it. When the code confirms it, report nothing.

## Report

- `severity`: `observation` with `category` `misleading-doc`. Use `high` instead when the false claim makes the slice miss an acceptance criterion or recorded decision (the reviewer rule "Report gaps, not preferences" in `agents/factory-reviewer.md`).
- `path` and `line`: the prose line in the diff.
- `problem`: names the cited code (path and symbol) and says what it actually does.
