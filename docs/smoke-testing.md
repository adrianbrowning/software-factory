# Smoke testing with a real omp run

Unit tests fake omp. To prove what omp itself does with a hook or a child session, run real omp against a throwaway repo.

1. Make a throwaway repo under `/tmp`. Commit with a repo-local git identity, so your own config is not used:

   ```sh
   repo=$(mktemp -d /tmp/factory-smoke-XXXX)
   git -C "$repo" init -q -b main
   git -C "$repo" -c user.email=s@s -c user.name=s commit -q --allow-empty -m base
   ```

2. Write a minimal `.omp/factory.json` in it, with only the keys the run needs:

   ```json
   { "baseRef": "main", "checks": ["true"], "models": { "explorer": { "model": "<provider/id>" } } }
   ```

3. Run omp in print mode from inside the throwaway repo, with only this plugin loaded. omp must start there: the factory reads `.omp/factory.json` and keeps its run state in the repo of omp's cwd. `--wait-async` keeps omp alive until background children finish. `--max-cost 5` caps the spend. Set the provider environment on the command (see the traps below):

   ```sh
   cd "$repo"
   AWS_PROFILE=<profile> omp -p --wait-async --no-extensions -e <absolute path of this plugin checkout> --model <id> --thinking <level> --max-cost 5 '<prompt>'
   ```

4. In the prompt, spawn children with the `task` tool, or with `agent()` inside `eval`.

5. Read each child session file at `~/.omp/agent/sessions/<cwd-slug>/<session>/<agent>.jsonl`, where `<cwd-slug>` is the slug of the throwaway repo path. It shows the model the child ran on, and its `thinking_level_change` event shows the thinking level.

6. Leave the throwaway repo and delete it: `cd - && rm -rf "$repo"`.

## Worker-thread submissions (persisted active-run pointer)

`scripts/smoke-worker-submissions.sh <provider/model id>` proves that reviewers on omp worker threads can submit. It is not part of `pnpm run test`; it runs real omp and spends up to `--max-cost 5`.

It builds the throwaway repo (`scripts/smoke-worker-submissions-setup.ts` starts a run through the extension tools and passes the checks of its slice), then runs omp in print mode from that repo where the main session resumes the run, opens a 10-domain review with `factory_review_start`, and runs one eval cell that spawns 10 `factory-reviewer` subagents at once and then the `factory-review-validator`, then `factory_review_record`. Afterwards it lists `reviews/<id>/domains` and prints `validation.json`, and fails unless there are 10 domain files, `validation.json` exists, and state.json holds a `review-green` event. A `No active factory run` refusal on a worker thread shows up as a missing domain file.

## Traps that lost live smoke runs

- **Resume discards an open review.** `factory_start` with `resume` discards a review the setup opened before it ("resumed in a new session"). The setup must stop at passing checks; the live session calls `factory_review_start` itself.
- **Print mode keeps running the loop.** A print-mode session that gets a `Next:` line carries on with the factory loop (further reviews, then a retro). End the prompt by telling the session to stop after the last named step, to call no other factory tool, and to stop at the first error.
- **Provider environment.** Set it on the omp command itself, for example `AWS_PROFILE=Labs_Claude omp -p ...` after `aws sso login`. `--max-cost 2` is too low for an opus orchestrator; use 5 or more.

## Known observations and headless placement

Both scripts take a `<provider/model id>`, build a throwaway repo with a setup `.ts` file, run real omp, and assert on `validation.json` and `state.json` with `jq`, so they need omp and jq on PATH. They are not part of `pnpm run test` and spend up to `--max-cost 5`.

Prefix the script command with the provider environment, for example `AWS_PROFILE=<profile> scripts/smoke-known-observations.sh <provider/model id>`; the script's omp call inherits it.

- `scripts/smoke-known-observations.sh`: a real validator drops a repeat observation (same location and problem, new id) as `same as <key>`, the review data has a `KNOWN OBSERVATIONS` section, and the session stops after `factory_review_record` (no `retro.md`) (setup: `scripts/smoke-known-observations-setup.ts`).
- `scripts/smoke-headless-placement.sh`: a real reviewer gives an observation a category, and headless `factory_complete_slice` places it by default, to the file sink the setup configures (setup: `scripts/smoke-headless-placement-setup.ts`).
