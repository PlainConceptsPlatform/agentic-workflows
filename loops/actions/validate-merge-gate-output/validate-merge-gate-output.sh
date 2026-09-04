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
  | if $outcome == "merge" and $conclusion == "success" and $pushes == 0 then "merge"
    elif $outcome == "remediated" and $conclusion == "failure" and $pushes == 1 then "remediated"
    elif $outcome == "review" and $pushes == 0 then "review"
    else "invalid"
    end
' "$output_file"
