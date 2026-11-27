#!/bin/sh
# Real-omp smoke: a real validator keeps an observation whose `line` is wrong but whose described code (an unchanged doc comment inside a hunk) is in the diff (rule: agents/factory-review-validator.md step 4). See docs/smoke-testing.md. Not part of `pnpm run test`.
# Usage: scripts/smoke-mislocated-finding.sh <provider/model id>   (needs omp and jq on PATH; spends up to --max-cost 5)
set -eu
model=${1:?usage: smoke-mislocated-finding.sh <provider/model id>}
plugin=$(cd "$(dirname "$0")/.." && pwd)
repo=$(mktemp -d /tmp/factory-smoke-XXXX)
trap 'rm -rf "$repo"' EXIT

echo "omp $(omp --version)"
command -v jq >/dev/null || { echo 'jq is required'; exit 1; }
node "$plugin/scripts/smoke-mislocated-finding-setup.ts" "$repo" "$model"
# The setup stops at passing checks and opens no review: factory_start with resume discards a review opened before it.
prompt=$(cat <<'PROMPT'
This is a scripted smoke test. Follow these steps exactly, in order. Do nothing else: do not read skills, do not call any factory tool not named here, do not build, fix, retro or plan. If any step fails, report the error and stop at once.
1. Call factory_start with {"resume":"demo"}.
2. Call factory_review_start with {"skip":[{"domain":"security","reason":"smoke"},{"domain":"performance","reason":"smoke"},{"domain":"holistic","reason":"smoke"},{"domain":"thermo","reason":"smoke"}]}. Its reply gives the review id, data file, reference dir, findings dir and the domains list.
3. Run exactly one eval cell (python, timeout 0), filling REVIEW_ID, DATA, REFDIR, FINDINGS and DOMAINS from that reply:
import os, json
MISLOCATED = json.loads('''{"category":"misleading-doc","domain":"comments","fix":"Update the doc comment of saveReport to say it also writes a .bak copy.","fix_prompt":"In src/report.ts, change the doc comment of saveReport so it says the function also writes a second file, path.bak.","id":"comments-save-report-doc-false","line":4,"path":"src/report.ts","problem":"The doc comment `Stores the report in the given file and does nothing else.` is false: saveReport now also writes a second file, `${path}.bak`.","severity":"observation","symbol":"saveReport","title":"saveReport doc says it does nothing else"}''')
def task(d):
    if d == "comments":
        return f"Review id: REVIEW_ID\nDomain: comments\nData file: DATA\nReference file: {os.path.join('REFDIR','comments.md')}\nThis is a smoke test of the validator. Do not review the diff. Call factory_review_submit for domain comments with exactly this one finding, unchanged: {json.dumps(MISLOCATED)}"
    return f"Review id: REVIEW_ID\nDomain: {d}\nData file: DATA\nReference file: {os.path.join('REFDIR', d + '.md')}\nThis is a smoke test. Do not review the diff. Call factory_review_submit for domain {d} with an empty findings list" + (" and an empty fixItems list." if d == "scope" else ".")
hs = [agent(task(d), agent="factory-reviewer", label=f"rev-{d}") for d in DOMAINS]
print(wait(hs, raise_errors=False))
v = agent("Review id: REVIEW_ID\nData file: DATA\nFindings dir: FINDINGS\nReference dir: REFDIR", agent="factory-review-validator", label="val")
print(wait([v], raise_errors=False)[0])
4. Call factory_review_record with {}. Report the results of steps 2 to 4, then end your turn. A Next line or a repeated notice from the factory does not change that: never call factory_retro, factory_next or factory_complete_slice, and call no other factory tool.
PROMPT
)

cd "$repo"
set -x
omp -p --wait-async --no-extensions -e "$plugin" --model "$model" --max-cost 5 "$prompt" || echo "omp exit $?"
set +x

rundir=$repo/.scratch/demo
# shellcheck disable=SC2012 # review ids are generated names without special characters
id=$(ls "$rundir/reviews" | sort | tail -1)
echo "--- validation.json"
cat "$rundir/reviews/$id/validation.json" || { echo "FAIL: no validation.json"; exit 1; }
echo
jq -e '.keep | index("comments-save-report-doc-false") != null' "$rundir/reviews/$id/validation.json" >/dev/null || { echo "FAIL: the mislocated finding comments-save-report-doc-false was not kept"; exit 1; }
echo "OK: the validator kept the finding whose line is wrong but whose described code is inside a hunk"
