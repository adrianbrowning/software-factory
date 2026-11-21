#!/bin/sh
# Runs one headless factory run per issue, one after the other, in the current worktree, chained into one stack: the first
# run starts without --base, and each later new run starts with `--base <top slice branch of the run before it>` (the last
# slice in that run's state.json), so its PRs stack on the run before. A listed issue whose run is already done with a
# submit is skipped and its top branch is the base of the next run. The batch stops at the first run that does not end
# done with a submit (paused, stalled, failed, running, or done with no PRs), names it in the summary and exits 1.
# With --separate as the first argument, no run gets --base: each opens its own stack of draft PRs on the default base,
# and a run that fails or pauses does not stop the next one. Merging stays manual.
# Usage: scripts/headless-backlog.sh [--separate] <issue> [<issue> ...]   (issue: 102, #102 or a GitHub issue URL)
# Env: OMP (default ,omp), PLUGIN_DIR (default the installed plugin), MAX_COST (USD, default 25),
#      MAX_TIME (seconds, default 5400), LOG_DIR (default <git dir>/headless-backlog, so no log makes the tree dirty).
# A run that exists and is not done is resumed (`/factory resume`, which takes no --base); a submitted done run is
# skipped. Run the script again to continue. Exits 1 when any issue did not end with a done run whose PRs are open.
set -u
separate=0
if [ "${1:-}" = --separate ]; then separate=1; shift; fi
[ $# -gt 0 ] || { echo 'usage: headless-backlog.sh [--separate] <issue> [<issue> ...]' >&2; exit 2; }
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
# The top slice branch of the last run that ended done with a submit; empty before the first run. Used only when chained.
base=''

# The run's status, or "done, no PRs (<event>)" when a done run's last submission event is not a submit.
run_status() {
  [ -f "$1" ] || { echo 'no run'; return; }
  jq -r '.status as $s | ([.events[] | select(.kind | test("^(submit|submit-failed|submission-stop)$"))] | last | .kind) as $k
    | if $s == "done" and $k != "submit" then "done, no PRs (\($k // "not submitted"); /factory submit opens them)" else $s end' "$1"
}

# The branch of the last slice in the run's state.json.
top_branch() { jq -r '.slices[-1].branch // empty' "$1"; }

# Ends a chained batch at $1, a run or issue that did not end done with a submit, so the next run has no base to stack on.
chain_stop() { summary="${summary}Stopped: $1 did not end done with a submit, so no later issue is started.\n"; }

# Sets base to the top slice branch of run $1 (state.json of the run's feature). A done run with no slice branch has none
# to stack on, so it ends the chained batch: returns 1.
next_base() {
  base=$(top_branch "$scratch/$1/state.json")
  [ -n "$base" ] && return 0
  failed=1
  summary="${summary}Stopped: $1 has no slice branch to stack the next run on, so no later issue is started.\n"
  return 1
}

for ref in "$@"; do
  n=$(printf '%s\n' "$ref" | sed -nE 's@^#?([0-9]+)$@\1@p; s@^https://github\.com/[^/]+/[^/]+/issues/([0-9]+)/?$@\1@p')
  if [ -z "$n" ]; then
    summary="$summary$ref: skipped, not an issue number or GitHub issue URL\n"
    failed=1
    [ "$separate" = 1 ] && continue
    chain_stop "$ref"
    break
  fi
  feature="issue-$n"
  state=$scratch/$feature/state.json
  log=$logs/$feature.log
  status=$(run_status "$state")
  case $status in
    done)
      summary="$summary$ref: skipped, run already done\n"
      [ "$separate" = 1 ] && continue
      next_base "$feature" || break
      continue
      ;;
    done,*)
      summary="$summary$ref: skipped, run $status\n"
      failed=1
      [ "$separate" = 1 ] && continue
      chain_stop "$feature"
      break
      ;;
    'no run') prompt="/factory headless $ref${base:+ --base $base}" ;;
    *) prompt="/factory resume $feature" ;;
  esac
  # The first run in a chain, and every run with --separate, plans on the configured base (by default origin's default
  # branch), as last fetched, so it sees what merged while earlier runs worked; a later new run in a chain branches from
  # the top branch of the run before it, and a resumed run keeps the base it started with.
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
  [ "$separate" = 1 ] && continue
  if [ "$status" != done ]; then
    chain_stop "$feature"
    break
  fi
  next_base "$feature" || break
done

printf '\nSummary:\n%b' "$summary"
exit $failed
