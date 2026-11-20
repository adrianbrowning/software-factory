#!/bin/sh
# Runs one headless factory run per issue, one after the other, in the current worktree. Each run opens its own stack of
# draft PRs on the default base; merging stays manual. A run that fails or pauses does not stop the next one.
# Usage: scripts/headless-backlog.sh <issue> [<issue> ...]   (issue: 102, #102 or a GitHub issue URL)
# Env: OMP (default ,omp), PLUGIN_DIR (default the installed plugin), MAX_COST (USD, default 25),
#      MAX_TIME (seconds, default 5400), LOG_DIR (default <git dir>/headless-backlog, so no log makes the tree dirty).
# A run that exists and is not done is resumed (`/factory resume`); a submitted done run is skipped. Run the script again
# to continue. Exits 1 when any issue did not end with a done run whose PRs are open.
set -u
[ $# -gt 0 ] || { echo 'usage: headless-backlog.sh <issue> [<issue> ...]' >&2; exit 2; }
omp=${OMP:-,omp}
plugin=${PLUGIN_DIR:-$HOME/.omp/plugins/node_modules/software-factory}
command -v "$omp" >/dev/null || { echo "$omp is not on PATH; set OMP to the omp command" >&2; exit 2; }
command -v jq >/dev/null || { echo 'jq is required' >&2; exit 2; }
[ -d "$plugin" ] || { echo "plugin dir $plugin does not exist; set PLUGIN_DIR" >&2; exit 2; }
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
scratch=.scratch
[ -f .omp/factory.json ] && scratch=$(jq -r '.scratchDir // ".scratch"' .omp/factory.json)
logs=${LOG_DIR:-$(git rev-parse --absolute-git-dir)/headless-backlog}
mkdir -p "$logs"
summary=''
failed=0

# The run's status, or "done, no PRs (<event>)" when a done run's last submission event is not a submit.
run_status() {
  [ -f "$1" ] || { echo 'no run'; return; }
  jq -r '.status as $s | ([.events[] | select(.kind | test("^(submit|submit-failed|submission-stop)$"))] | last | .kind) as $k
    | if $s == "done" and $k != "submit" then "done, no PRs (\($k // "not submitted"); /factory submit opens them)" else $s end' "$1"
}

for ref in "$@"; do
  n=$(printf '%s\n' "$ref" | sed -nE 's@^#?([0-9]+)$@\1@p; s@^https://github\.com/[^/]+/[^/]+/issues/([0-9]+)/?$@\1@p')
  if [ -z "$n" ]; then
    summary="$summary$ref: skipped, not an issue number or GitHub issue URL\n"
    failed=1
    continue
  fi
  feature="issue-$n"
  state=$scratch/$feature/state.json
  log=$logs/$feature.log
  status=$(run_status "$state")
  case $status in
    done) summary="$summary$ref: skipped, run already done\n"; continue ;;
    done,*) summary="$summary$ref: skipped, run $status\n"; failed=1; continue ;;
    'no run') prompt="/factory headless $ref" ;;
    *) prompt="/factory resume $feature" ;;
  esac
  # Each run plans on the current origin/main, so it sees what merged while earlier runs worked.
  git fetch -q origin || echo "git fetch failed; $ref plans on the last fetched origin" >&2
  echo "== $ref: $prompt (log: $log)"
  "$omp" -p --wait-async --no-extensions -e "$plugin" --max-cost "${MAX_COST:-25}" --max-time "${MAX_TIME:-5400}" "$prompt" >"$log" 2>&1
  code=$?
  status=$(run_status "$state")
  prs=$(grep -oE 'https://github\.com/[^ )]+/pull/[0-9]+' "$log" | sort -u | tr '\n' ' ')
  summary="$summary$ref: exit $code, run $status${prs:+, PRs: $prs}\n"
  echo "== $ref: exit $code, run $status"
  [ "$status" = done ] || failed=1
  # A run left running (omp hit --max-time or --max-cost) blocks every new run in this worktree.
  if [ "$status" = running ]; then
    summary="${summary}Stopped: $feature is still running; run the script again to resume it.\n"
    break
  fi
done

printf '\nSummary:\n%b' "$summary"
exit $failed
