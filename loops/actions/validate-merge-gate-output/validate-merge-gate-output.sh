#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-merge-gate-output/validate-merge-gate-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print the merge-gate disposition: auto-merge, human-review, owner-review, blocked,
# remediated, or invalid.
#
# This file used to read one word out of the agent's prose and call it the decision. It now
# computes the decision from two sources that cannot be confused with each other: facts the
# workflow measured before the agent ran (CI, protected and owner paths, blast radius), and
# structured evidence the agent produced (verified findings, recoverability, confidence). The
# agent no longer names the outcome. It reports what it found; the rules below decide.
#
# Usage:
#   validate-merge-gate-output.sh OUTPUT_FILE ISSUE CI_CONCLUSION \
#                                 BLAST_LEVEL PROTECTED_HIT OWNER_HIT CONFIDENCE_THRESHOLD

set -euo pipefail

output_file="$1"
issue_number="$2"
ci_conclusion="$3"
blast_level="${4:-low}"
protected_hit="${5:-false}"
owner_hit="${6:-false}"
confidence_threshold="${7:-0.8}"

if [ ! -f "$output_file" ] || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

jq -r \
  --arg issue "$issue_number" \
  --arg conclusion "$ci_conclusion" \
  --arg blast "$blast_level" \
  --arg protected "$protected_hit" \
  --arg owner "$owner_hit" \
  --argjson threshold "$confidence_threshold" '

  def rank: {"low": 0, "medium": 1, "high": 2}[.] // 0;

  .items as $items

  | [$items[] | select(.type == "add_comment"
      and (.item_number | tostring) == $issue
      and (.body | type == "string"))] as $comments

  # The one word the agent still writes. "remediated" pairs with a push and says it repaired CI
  # or a conflict; "assessed" says it did the review and the rules below decide. Anything else,
  # including the old merge/review vocabulary, is output from a version that no longer matches
  # this validator, and applying it would be worse than parking the pull request.
  | ($comments
     | map(.body
       | if test("\\*\\*Verdict:\\*\\*\\s*(assessed|remediated)"; "i") then
           capture("\\*\\*Verdict:\\*\\*\\s*(?<v>assessed|remediated)"; "i").v | ascii_downcase
         else empty end)
     | .[0] // "invalid") as $verdict

  | ([$items[] | select(.type == "push_to_pull_request_branch")] | length) as $pushes

  # The structured block. A missing or malformed one is not a reason to merge: it falls through
  # to invalid, which the incomplete job already handles by parking or retrying.
  | ($comments
     | map(.body
       | if test("```json"; "") then
           (capture("```json\\s*(?<j>.*?)```"; "m").j | try fromjson catch empty)
         else empty end)
     | .[0]) as $report

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
  | if $verdict == "remediated" and $pushes == 1 then "remediated"
    elif $verdict != "assessed" or $pushes != 0 then "invalid"
    elif $report == null then "invalid"
    else
      ($report.findings // []) as $findings

      # A finding blocks only when the agent proved it. An unverified finding is a warning
      # whatever severity it claims, which is what stops the gate failing on "this might be
      # wrong" and what removes any payoff in inventing one.
      | ([$findings[]
          | select((.verified == true)
              and ((.severity // "low") | ascii_downcase | . == "high" or . == "critical"))]
         | length) as $blockers

      # The agent may raise the measured blast radius when it finds something the path rules
      # could not see. It may never lower it.
      | ([($blast | rank), (($report.blastRadiusRaise.to // $blast) | rank)] | max) as $level

      # The same rule the findings live by, applied to the one judgement field that can park a
      # pull request on its own. An unevidenced "low" is the old category escalation wearing a
      # new name: replayed against a consumer, a model that rated everything low dropped the
      # auto-merge rate straight back to 27%, which is where it started. Saying a change cannot
      # be undone means naming what cannot be undone.
      | (($report.recoverability // "medium") | ascii_downcase) as $claimed
      | (($report.recoverabilitySignals // []) | length > 0) as $evidenced
      | (if $claimed == "low" and ($evidenced | not) then "medium" else $claimed end) as $recoverability
      | (($report.confidence // 0) | tonumber) as $confidence

      | if $conclusion != "success" then "blocked"
        elif $blockers > 0 then "blocked"
        elif $protected == "true" or $owner == "true" or $level == 2 then "owner-review"
        elif $level == 1 and $recoverability == "low" then "human-review"
        # jq: `false // true` is `true`, because // treats false as absent. A flat // here
        # silently ignored every unmet acceptance criterion the agent reported.
        elif ($report | has("acceptanceCriteriaMet")) and $report.acceptanceCriteriaMet == false
          then "human-review"
        elif $confidence < $threshold then "human-review"
        else "auto-merge"
        end
    end
' "$output_file"
