#!/bin/sh
# Runs one headless factory run per issue, one after the other, in the current worktree. Each run opens its own stack of
# draft PRs on the default base; merging stays manual. A run that fails or pauses does not stop the next one.
# Usage: scripts/headless-backlog.sh <issue> [<issue> ...]   (issue: 102, #102 or a GitHub issue URL)
# Env: OMP (default ,omp), PLUGIN_DIR (default the installed plugin), MAX_COST (USD, default 25),
#      MAX_TIME (seconds, default 5400), LOG_DIR (default <git dir>/headless-backlog, so no log makes the tree dirty).
# A run that exists and is not done is resumed (`/factory resume`); a done run is skipped. Run the script again to continue.
# Exits 1 when any issue did not end with a done run.
set -u
[ $# -gt 0 ] || { echo 'usage: headless-backlog.sh <issue> [<issue> ...]' >&2; exit 2; }
omp=${OMP:-,omp}
plugin=${PLUGIN_DIR:-$HOME/.omp/plugins/node_modules/software-factory}
command -v "$omp" >/dev/null || { echo "$omp is not on PATH; set OMP to the omp command" >&2; exit 2; }
command -v jq >/dev/null || { echo 'jq is required' >&2; exit 2; }
[ -d "$plugin" ] || { echo "plugin dir $plugin does not exist; set PLUGIN_DIR" >&2; exit 2; }
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
logs=${LOG_DIR:-$(git rev-parse --absolute-git-dir)/headless-backlog}
mkdir -p "$logs"
summary=''
failed=0

for ref in "$@"; do
  n=$(printf '%s\n' "$ref" | sed -nE 's@^#?([0-9]+)$@\1@p; s@^https://github\.com/[^/]+/[^/]+/issues/([0-9]+)/?$@\1@p')
  if [ -z "$n" ]; then
    summary="$summary$ref: skipped, not an issue number or GitHub issue URL\n"
    failed=1
    continue
  fi
  feature="issue-$n"
  # shortcut: assumes the default scratchDir (.scratch); read it from .omp/factory.json if a repo changes it.
  state=.scratch/$feature/state.json
  log=$logs/$feature.log
  if [ -f "$state" ] && [ "$(jq -r .status "$state")" = done ]; then
    summary="$summary#$n: skipped, run already done\n"
    continue
  fi
  if [ -f "$state" ]; then prompt="/factory resume $feature"; else prompt="/factory headless $n"; fi
  # Each run plans on the current origin/main, so it sees what merged while earlier runs worked.
  git fetch -q origin || echo "git fetch failed; #$n plans on the last fetched origin" >&2
  echo "== #$n: $prompt (log: $log)"
  "$omp" -p --wait-async --no-extensions -e "$plugin" --max-cost "${MAX_COST:-25}" --max-time "${MAX_TIME:-5400}" "$prompt" >"$log" 2>&1
  code=$?
  status=$( [ -f "$state" ] && jq -r .status "$state" || echo 'no run')
  prs=$(grep -oE 'https://github\.com/[^ )]+/pull/[0-9]+' "$log" | sort -u | tr '\n' ' ')
  summary="$summary#$n: exit $code, run $status${prs:+, PRs: $prs}\n"
  echo "== #$n: exit $code, run $status"
  [ "$status" = done ] || failed=1
done

printf '\nSummary:\n%b' "$summary"
exit $failed
