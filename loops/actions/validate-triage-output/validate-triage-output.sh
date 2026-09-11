#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-triage-output/validate-triage-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print the deterministic triage outcome: pass, needs-info, needs-maintainer, block, or invalid.
#
# needs-maintainer and block are both refusals of product-owner intake, and they part company on what
# happens next: needs-maintainer keeps the issue open with the review label so a maintainer can take it
# on, block closes it. Neither value is a substring of another, so the alternation order below is free.

set -euo pipefail

output_file="$1"
issue_number="$2"

if [ ! -f "$output_file" ] || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

# The agent emits exactly one add_comment on the source issue. The comment body
# must contain a verdict line matching **Verdict:** pass|needs-info|needs-maintainer|block.
# capture() returns an object — use a named group (?<v>...) to extract the value.
# test() before capture() avoids jq errors on non-matching bodies.
jq -r --arg issue "$issue_number" '
  def extract_verdict:
    [.items[] | select(.type == "add_comment" and (.item_number | tostring) == $issue and (.body | type == "string"))]
    | map(.body |
      if test("\\*\\*Verdict:\\*\\*\\s*(pass|needs-info|needs-maintainer|block)"; "i") then
        capture("\\*\\*Verdict:\\*\\*\\s*(?<v>pass|needs-info|needs-maintainer|block)"; "i").v | ascii_downcase
      else empty end
    )
    | .[0] // "none";

  extract_verdict as $verdict |
  if $verdict == "pass" or $verdict == "needs-info" or $verdict == "needs-maintainer" or $verdict == "block" then
    $verdict
  else
    "invalid"
  end
' "$output_file"

