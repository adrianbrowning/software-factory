#!/bin/sh
# Real-omp smoke: decision 15, a real validator drops a repeat observation under a new id as "same as <key>". See docs/smoke-testing.md. Not part of `pnpm run test`.
# Usage: scripts/smoke-known-observations.sh <provider/model id>   (needs omp on PATH; spends up to --max-cost 5)
set -eu
model=${1:?usage: smoke-known-observations.sh <provider/model id>}
plugin=$(cd "$(dirname "$0")/.." && pwd)
repo=$(mktemp -d /tmp/factory-smoke-XXXX)
trap 'rm -rf "$repo"' EXIT

echo "omp $(omp --version)"
node "$plugin/scripts/smoke-known-observations-setup.ts" "$repo" "$model"
# The setup stops at passing checks and opens no review: factory_start with resume discards a review opened before it.
prompt=$(cat <<'PROMPT'
This is a scripted smoke test. Follow these steps exactly, in order. Do nothing else: do not read skills, do not call any factory tool not named here, do not build, fix, retro or plan. If any step fails, report the error and stop at once.
1. Call factory_start with {"resume":"demo"}.
2. Call factory_review_start with {"skip":[{"domain":"security","reason":"smoke"},{"domain":"performance","reason":"smoke"},{"domain":"holistic","reason":"smoke"},{"domain":"comments","reason":"smoke"}]}. Its reply gives the review id, data file, reference dir, findings dir and the domains list.
3. Run exactly one eval cell (python, timeout 0), filling REVIEW_ID, DATA, REFDIR, FINDINGS and DOMAINS from that reply:
import os, json
REPEAT = json.loads('''{"domain":"thermo","fix":"Rename f to greet.","fix_prompt":"Rename f to greet in greet.ts and its callers.","id":"thermo-vague-function-name","line":1,"path":"greet.ts","problem":"The exported function name `f` does not say what it does: a reader of a call site cannot tell that it returns a greeting.","severity":"observation","title":"Function name f is vague"}''')
def task(d):
    if d == "thermo":
        return f"Review id: REVIEW_ID\nDomain: thermo\nData file: DATA\nReference file: {os.path.join('REFDIR','thermo.md')}\nThis is a smoke test of the validator. Do not review the diff. Call factory_review_submit for domain thermo with exactly this one finding, unchanged: {json.dumps(REPEAT)}"
    return f"Review id: REVIEW_ID\nDomain: {d}\nData file: DATA\nReference file: {os.path.join('REFDIR', d + '.md')}\nThis is a smoke test. Do not review the diff. Call factory_review_submit for domain {d} with an empty findings list" + (" and an empty fixItems list." if d == "scope" else ".")
hs = [agent(task(d), agent="factory-reviewer", label=f"rev-{d}") for d in DOMAINS]
print(wait(hs, raise_errors=False))
v = agent("Review id: REVIEW_ID\nData file: DATA\nFindings dir: FINDINGS\nReference dir: REFDIR", agent="factory-review-validator", label="val")
print(wait([v], raise_errors=False)[0])
4. Call factory_review_record with {}. Report the results of steps 2 to 4 and stop.
PROMPT
)

cd "$repo"
set -x
omp -p --wait-async --no-extensions -e "$plugin" --model "$model" --max-cost 5 "$prompt" || echo "omp exit $?"
set +x

rundir=$repo/.scratch/demo
id=$(ls "$rundir/reviews" | sort | tail -1)
echo "--- validation.json"
cat "$rundir/reviews/$id/validation.json" || { echo "FAIL: no validation.json"; exit 1; }
echo
grep -rq 'KNOWN OBSERVATIONS' "$rundir/reviews/$id" || { echo "FAIL: no KNOWN OBSERVATIONS section in the review data"; exit 1; }
grep -q 'same as 01-r1:thermo-unclear-name' "$rundir/reviews/$id/validation.json" || { echo "FAIL: the repeat was not dropped as 'same as 01-r1:thermo-unclear-name'"; exit 1; }
state=$rundir/state.json
jq -e '[.. | objects | select(.key? != null and (.key | endswith("thermo-unclear-name")) and .placement == "left")] | length == 1' "$state" >/dev/null || { echo "FAIL: state.json lacks the left ledger entry for thermo-unclear-name"; exit 1; }
if jq -e '[.. | objects | select(.unplaced? != null) | .unplaced[] | select(.finding.id == "thermo-vague-function-name")] | length > 0' "$state" >/dev/null; then echo "FAIL: the repeat was kept as an unplaced observation"; exit 1; fi
echo "OK: the validator dropped the repeat under a new id as 'same as 01-r1:thermo-unclear-name'"
