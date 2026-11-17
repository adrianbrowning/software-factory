#!/bin/sh
# Real-omp smoke: a real reviewer gives a category; headless factory_complete_slice places it by default. See docs/smoke-testing.md. Not part of `pnpm run test`.
# Usage: scripts/smoke-headless-placement.sh <provider/model id>   (needs omp on PATH; spends up to --max-cost 5)
set -eu
model=${1:?usage: smoke-headless-placement.sh <provider/model id>}
plugin=$(cd "$(dirname "$0")/.." && pwd)
repo=$(mktemp -d /tmp/factory-smoke-XXXX)
trap 'rm -rf "$repo"' EXIT

echo "omp $(omp --version)"
node "$plugin/scripts/smoke-headless-placement-setup.ts" "$repo" "$model"
# The setup stops at passing checks and opens no review: factory_start with resume discards a review opened before it.
prompt=$(cat <<'PROMPT'
This is a scripted smoke test. Follow these steps exactly, in order. Do nothing else: do not read skills, do not call any factory tool not named here, do not build, fix, retro, plan or start the next slice. If any step fails, report the error and stop at once.
1. Call factory_start with {"resume":"demo"}.
2. Call factory_review_start with {"skip":[{"domain":"security","reason":"smoke"},{"domain":"performance","reason":"smoke"},{"domain":"holistic","reason":"smoke"},{"domain":"comments","reason":"smoke"}]}. Its reply gives the review id, data file, reference dir, findings dir and the domains list.
3. Run exactly one eval cell (python, timeout 0), filling REVIEW_ID, DATA, REFDIR, FINDINGS and DOMAINS from that reply:
import os
def task(d):
    base = f"Review id: REVIEW_ID\nDomain: {d}\nData file: DATA\nReference file: {os.path.join('REFDIR', d + '.md')}\nThis is a smoke test; keep it short. "
    if d == "thermo":
        return base + "Submit exactly one finding: an observation that the exported name `f` at greet.ts line 1 does not say what the function does. Fill every field your agent instructions require. Submit no other finding."
    return base + "Submit an empty findings list" + (" and an empty fixItems list." if d == "scope" else ".")
hs = [agent(task(d), agent="factory-reviewer", label=f"rev-{d}") for d in DOMAINS]
print(wait(hs, raise_errors=False))
v = agent("Review id: REVIEW_ID\nData file: DATA\nFindings dir: FINDINGS\nReference dir: REFDIR", agent="factory-review-validator", label="val")
print(wait([v], raise_errors=False)[0])
4. Call factory_review_record with {}.
5. Call factory_complete_slice with {}. Report the replies of steps 2, 4 and 5 in full and stop.
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
grep -q '"kind": *"review-green"' "$rundir/state.json" || { echo "FAIL: no review-green event"; exit 1; }
grep -q '"category"' "$rundir/state.json" || { echo "FAIL: no observation category in state.json"; exit 1; }
echo "OK: a real reviewer gave a category and the headless factory_complete_slice placed it by default"
