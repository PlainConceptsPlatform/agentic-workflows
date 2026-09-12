#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-review-output/validate-review-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print implemented, already-satisfied, needs-human, or invalid.

set -euo pipefail

output_file="$1"
pr_number="$2"
threads_file="$3"

if [ ! -f "$output_file" ] || [ ! -f "$threads_file" ] \
  || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1 \
  || ! jq -e 'type == "array"' "$threads_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

# Every jq error becomes "invalid" rather than a non-zero exit, the way the merge gate's
# validator already does it. A crash here fails the step, which skips the apply job and parks
# the issue as stalled -- while the agent's fix is already pushed and sitting on the branch.
# Output the workflow cannot read is an outcome to report, not a reason to fall over.
jq -r --arg pr "$pr_number" --slurpfile threads "$threads_file" '
  def decide:
  .items as $items
  | ($threads[0] | map(select(.isResolved == false and .isOutdated == false) | .id) | sort) as $expected
  | ($items | [.[] | select(.type == "add_comment" and (.item_number | tostring) == $pr and (.body | type == "string"))]) as $comments
  | ($comments | map(.body | if test("\\*\\*Review outcome:\\*\\*\\s*(implemented|already-satisfied|needs-human)"; "i") then capture("\\*\\*Review outcome:\\*\\*\\s*(?<v>implemented|already-satisfied|needs-human)"; "i").v | ascii_downcase else empty end) | .[0] // "invalid") as $outcome
  # `add` on an empty array is null, not [], and `unique` then dies with "Cannot iterate over
  # null". That is not an edge case: it is every pull-request-level review. Requesting changes
  # from the Files tab, or a plain review body with no inline comment, creates a review and no
  # thread, so both sides of this comparison are empty and the validator crashed instead of
  # agreeing. The agent had already read the feedback, pushed the fix and reported it; the run
  # was marked failed, the issue was labelled stalled, and the board said nothing landed while
  # the commit sat on the branch.
  | ($comments | map(.body | [scan("PRRT_[A-Za-z0-9_=-]+")]) | add // [] | unique | sort) as $reported
  | ([$items[] | select(.type == "push_to_pull_request_branch")] | length) as $pushes
  | if $expected != $reported then "invalid"
    elif $outcome == "implemented" and $pushes == 1 then "implemented"
    elif ($outcome == "already-satisfied" or $outcome == "needs-human") and $pushes == 0 then $outcome
    else "invalid"
    end;

  try decide catch "invalid"
' "$output_file"
