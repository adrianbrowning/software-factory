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

3. Run omp in print mode with only this plugin loaded. `--wait-async` keeps omp alive until background children finish. `--max-cost 2` caps the spend:

   ```sh
   omp -p --wait-async --no-extensions -e <this repo> --model <id> --thinking <level> --max-cost 2 '<prompt>'
   ```

4. In the prompt, spawn children with the `task` tool, or with `agent()` inside `eval`.

5. Read each child session file at `~/.omp/agent/sessions/<cwd-slug>/<session>/<agent>.jsonl`. It shows the model the child ran on, and its `thinking_level_change` event shows the thinking level.

6. Delete the throwaway repo afterwards: `rm -rf "$repo"`.
