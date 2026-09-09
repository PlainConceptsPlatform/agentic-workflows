#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-merge-gate-output/validate-merge-gate-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print the deterministic merge-gate outcome: merge, review, remediated, or invalid.

set -euo pipefail

output_file="$1"
issue_number="$2"
ci_conclusion="$3"

if [ ! -f "$output_file" ] || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

# The agent emits exactly one comment on the source issue. Its verdict tells the
# workflow which App-token state transition to perform.
jq -r --arg issue "$issue_number" --arg conclusion "$ci_conclusion" '
  .items as $items
  | ($items
    | [.[] | select(.type == "add_comment" and (.item_number | tostring) == $issue and (.body | type == "string"))]
    | map(.body |
        if test("\\*\\*Verdict:\\*\\*\\s*(merge|review|remediated)"; "i") then
          capture("\\*\\*Verdict:\\*\\*\\s*(?<v>merge|review|remediated)"; "i").v | ascii_downcase
        else empty end
      )
    | .[0] // "invalid") as $outcome
  | ([$items[] | select(.type == "push_to_pull_request_branch")] | length) as $pushes
  # remediated used to require conclusion == "failure", which threw correct work away. The prompt
  # tells the agent to merge main in, verify and push when CI is green but the pull request
  # conflicts. That is a real and common state: a conflicting pull request has no merge ref, so
  # GitHub can never run CI on that head, and the belt falls back to the last verdict on the
  # branch, which is usually success. The agent did the job, the validator called it invalid,
  # conclude was skipped, and because this worker stages its outputs the resolved merge commit
  # was discarded. The belt then dispatched again on the same verdict, up to six times, each a
  # full run on the single-slot merge belt. A push carrying a remediated verdict is remediation
  # whatever CI last said; what still matters is that exactly one push comes with it.
  #
  # No apostrophes in here. This block sits inside the single-quoted jq program, and one
  # apostrophe closes that string and breaks the script.
  | if $outcome == "merge" and $conclusion == "success" and $pushes == 0 then "merge"
    elif $outcome == "remediated" and $pushes == 1 then "remediated"
    elif $outcome == "review" and $pushes == 0 then "review"
    else "invalid"
    end
' "$output_file"
