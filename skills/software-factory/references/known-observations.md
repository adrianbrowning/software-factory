# Known observations and targeted reviews

The rule for `## KNOWN OBSERVATIONS` and `## TARGETED REVIEW` in a review data file, written once for the reviewers and the validator.

## KNOWN OBSERVATIONS

The section lists the observations this run already placed (carried, deferred, fixed or left), each with its key, location and problem.

- Reviewer: a problem that matches an entry by location and problem is not new, whatever id you would give it. Leave it out, at any severity.
- Validator: drop a finding, of any severity, that matches an entry by location and problem, under any id, with the reason `same as <key>` (the entry's key, for example `01-r1:thermo-naming`). Match by what the finding says, not by its id. A left observation is never raised again in the run.
- An entry marked `carried to this slice: check it` is carried-in work this slice builds. A finding that it is unbuilt or wrong in this slice is not a repeat: the reviewer reports it and the validator keeps it as an ordinary finding. This holds for a fixed entry listed in `## FIX ITEMS` too: its remaining problem is the scope reviewer's `open` verdict, not a finding.
- An entry with the legacy placeholder text (location `unknown`, problem `Recorded before the run kept the text of handled observations.`) matches by its key only, never by location or problem. Never drop an unrelated finding as a repeat of a placeholder.

## TARGETED REVIEW

A review after a red review (or after an observation-only fix round) has a `## TARGETED REVIEW` section. It runs only the domains that blocked, plus bug, scope and (with seams) testing, and lists the fix diff: the commits since the earlier review and their changed new-side lines.

- Reviewer: report an observation only on a line the section lists. Report blocking findings (`critical` or `high`) anywhere in the slice diff.
- Validator: drop every observation whose line is not listed, with the reason `outside the fix diff`; never downgrade a blocking finding into one. The tool refuses a validation that keeps one. Blocking findings anywhere are kept as usual.
- A green targeted review is followed by a full review of the same commit.
