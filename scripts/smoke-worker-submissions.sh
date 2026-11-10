#!/bin/sh
# Real-omp smoke for the persisted active-run pointer: 10 concurrent factory-reviewer subagents in one eval, then the
# validator, all submitting from omp worker threads. See docs/smoke-testing.md. Not part of `pnpm run test`.
# Usage: scripts/smoke-worker-submissions.sh <provider/model id>   (needs omp on PATH; spends up to --max-cost 5)
set -eu
model=${1:?usage: smoke-worker-submissions.sh <provider/model id>}
plugin=$(cd "$(dirname "$0")/.." && pwd)
repo=$(mktemp -d /tmp/factory-smoke-XXXX)
trap 'rm -rf "$repo"' EXIT

echo "omp $(omp --version)"
node "$plugin/scripts/smoke-worker-submissions-setup.ts" "$repo" "$model"
# The run is bound by the setup (pointer in the git dir). The omp main session resumes it (which activates the factory
# tools and discards the stale review), opens the review itself, then drives the batch, the validator and the record.
prompt='Follow these steps exactly, in order, using only the tools named. Do nothing else: no retro, no plan, no checks, no completion, no reading of files.
1. Call factory_start with {"resume":"demo"}.
2. Call factory_review_start with {"skip":[{"domain":"comments","reason":"smoke: the diff has no comments"}],"keep":["react-ts","test-validity","devops"]}. Its reply gives the review id, data file, reference dir, findings dir and the domains list.
3. Run exactly one eval cell (timeout 0) with the Python below, with its last line filled in from that reply, and nothing else changed.
def run_review(review_id, domains, data, refdir, findings):
    import os
    hs = [agent(f"Review id: {review_id}\nDomain: {d}\nThe diff is trivial and sound: read the data file quickly and submit an empty findings list.\nData file: {data}\nReference file: {os.path.join(refdir, f'"'"'{d}.md'"'"')}", agent="factory-reviewer", label=f"rev-{review_id}-{d}") for d in domains]
    rs = wait(hs, raise_errors=False)
    failed = [(d, str(r)) for d, r in zip(domains, rs) if isinstance(r, BaseException)]
    if failed:
        return {"failed": failed}
    v = agent(f"Review id: {review_id}\nData file: {data}\nFindings dir: {findings}\nReference dir: {refdir}", agent="factory-review-validator", label=f"val-{review_id}")
    return wait([v], raise_errors=False)[0]
run_review("<review id>", ["<domain>", ...], "<data file>", "<reference dir>", "<findings dir>")
4. When it returns without a failed entry, call factory_review_record with {}. Then report both results and stop.'

cd "$repo"
set -x
omp -p --wait-async --no-extensions -e "$plugin" --model "$model" --max-cost 5 "$prompt" || echo "omp exit $?"
set +x

rundir=$repo/.scratch/demo
id=$(ls "$rundir/reviews" | sort | tail -1)
echo "--- reviews/$id/domains"
ls -l "$rundir/reviews/$id/domains"
echo "--- validation.json"
cat "$rundir/reviews/$id/validation.json" || { echo "FAIL: no validation.json"; exit 1; }
echo
count=$(find "$rundir/reviews/$id/domains" -name '*.json' | wc -l | tr -d ' ')
echo "--- domain files: $count (expected 10)"
[ "$count" = 10 ] || { echo "FAIL: expected 10 domain files"; exit 1; }
echo "--- events in state.json"
grep -o '"kind": *"review-[a-z]*"' "$rundir/state.json" || true
grep -A2 '"kind": *"review-green"' "$rundir/state.json" || true
grep -q '"kind": *"review-green"' "$rundir/state.json" || { echo "FAIL: no review-green event"; exit 1; }
echo "OK: 10 reviewers and the validator submitted with no 'No active factory run', and factory_review_record turned the review green"
