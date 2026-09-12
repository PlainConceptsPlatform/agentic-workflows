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
# The shape rules are strict on purpose. Every permissive default in here is a way for a
# malformed report to merge code nobody assessed, and the shapes that matter are near misses
# rather than nonsense: `"verified": "true"` as a string, a severity spelled `blocker`, an
# `acceptanceCriteriaMet` of `"false"`. Each of those read as the permissive value once. A
# report that does not match the contract is `invalid`, which parks the pull request; only a
# report that does match gets to decide anything.
#
# Usage:
#   validate-merge-gate-output.sh OUTPUT_FILE ISSUE CI_CONCLUSION \
#                                 BLAST_LEVEL PROTECTED_HIT OWNER_HIT CONFIDENCE_THRESHOLD

set -euo pipefail

output_file="$1"
issue_number="$2"
ci_conclusion="$3"
# `${4-low}`, not `${4:-low}`: the colon form substitutes the default for an argument that was
# passed as an empty string, which is exactly the case that has to be caught. A skipped or
# failed `protected_changes` reaches this script as empty arguments, and reading those as
# "low, nothing protected" is how an unmeasured pull request would merge.
blast_level="${4-low}"
protected_hit="${5-false}"
owner_hit="${6-false}"
confidence_threshold="${7-0.8}"

# An empty measured level is not a low-risk pull request, it is a job that did not report. The
# defaults above exist for a caller that genuinely has nothing to say; an empty string arriving
# from a skipped or failed `protected_changes` must not read as the most permissive value.
[ -n "$blast_level" ] || blast_level=unmeasured
[ -n "$protected_hit" ] || protected_hit=unmeasured
[ -n "$owner_hit" ] || owner_hit=unmeasured
[ -n "$confidence_threshold" ] || confidence_threshold=0.8

if [ ! -f "$output_file" ] || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

# Every jq error becomes `invalid` rather than a non-zero exit. A report shaped so badly that it
# crashes the program used to fail the step, which skipped `conclude` and left the belt to spend
# up to six full agent runs on what was a formatting mistake the first time.
jq -r \
  --arg issue "$issue_number" \
  --arg conclusion "$ci_conclusion" \
  --arg blast "$blast_level" \
  --arg protected "$protected_hit" \
  --arg owner "$owner_hit" \
  --arg threshold "$confidence_threshold" '

  def level_rank: {"low": 0, "medium": 1, "high": 2}[.];
  def is_bool: type == "boolean";
  def known_severity: type == "string" and (ascii_downcase | . == "critical" or . == "high" or . == "medium" or . == "low");

  # A finding the rules can act on. Anything else means the report is not the contract, and the
  # whole report is refused rather than the finding being quietly dropped to the safe side.
  def well_formed_finding:
    (has("verified") and (.verified | is_bool))
    and (has("severity") and (.severity | known_severity));

  def blocks: .verified == true and (.severity | ascii_downcase | . == "critical" or . == "high");

  def decide:
    .items as $items

    | [$items[] | select(.type == "add_comment"
        and (.item_number | tostring) == $issue
        and (.body | type == "string"))] as $comments

    # Exactly one comment may carry a verdict. Taking the first of several let a second comment
    # reporting a verified critical finding be discarded, and let a comment with no verdict at
    # all supply the report for a verdict written in another.
    | [$comments[] | select(.body | test("\\*\\*Verdict:\\*\\*\\s*(assessed|remediated)"; "i"))] as $verdicts
    | if ($verdicts | length) != 1 then "invalid" else

      ($verdicts[0].body) as $body
      | ($body | capture("\\*\\*Verdict:\\*\\*\\s*(?<v>assessed|remediated)"; "i").v | ascii_downcase) as $verdict
      | ([$items[] | select(.type == "push_to_pull_request_branch")] | length) as $pushes

      # The LAST fenced json block in that comment, because the prompt puts the report last and
      # the prose above it routinely quotes json from the diff under review. Reading the first
      # fence handed the decision to whatever the agent happened to quote, and PROTECTED_PATHS
      # names package.json and global.json, so the reviewed diff is often json.
      | ([$body | scan("```json\\s*(.*?)```"; "m") | .[0]] | last) as $fence

      # remediated used to require conclusion == "failure", which threw correct work away. The
      # prompt tells the agent to merge main in, verify and push when CI is green but the pull
      # request conflicts. That is a real and common state: a conflicting pull request has no
      # merge ref, so GitHub can never run CI on that head, and the belt falls back to the last
      # verdict on the branch, which is usually success. The agent did the job, the validator
      # called it invalid, conclude was skipped, and because this worker stages its outputs the
      # resolved merge commit was discarded. The belt then dispatched again on the same verdict,
      # up to six times, each a full run on the single-slot merge belt.
      #
      # No apostrophes in here. This block sits inside the single-quoted jq program, and one
      # apostrophe closes that string and breaks the script.
      | if $verdict == "remediated" and $pushes == 1 then "remediated"
        elif $verdict != "assessed" or $pushes != 0 then "invalid"
        elif $fence == null then "invalid"
        else
          ($fence | fromjson) as $report
          | if ($report | type) != "object" then "invalid" else

            ($report.findings // []) as $findings
            | (($report.blastRadiusRaise // {}) | if type == "object" then (.to // $blast) else null end) as $raise

            # Every field the decision reads is checked before any of it is read. A near miss
            # here is not a small problem: each one of these used to resolve to the permissive
            # value and merge.
            | if ($findings | type) != "array" then "invalid"
              elif ([$findings[] | select(well_formed_finding | not)] | length) > 0 then "invalid"
              elif ($report | has("recoverability")) and (($report.recoverability | type != "string") or (($report.recoverability | ascii_downcase) | level_rank) == null) then "invalid"
              elif ($report | has("acceptanceCriteriaMet")) and (($report.acceptanceCriteriaMet | is_bool) | not) then "invalid"
              elif ($report | has("confidence")) and (($report.confidence | type) != "number") then "invalid"
              elif $raise == null or ($raise | type != "string") or (($raise | ascii_downcase) | level_rank) == null then "invalid"
              elif ($blast | level_rank) == null then "invalid"
              else
                ([$findings[] | select(blocks)] | length) as $blockers

                # The agent may raise the measured blast radius when it finds something the path
                # rules could not see. It may never lower it.
                | ([($blast | level_rank), ($raise | ascii_downcase | level_rank)] | max) as $level

                # The same rule the findings live by, applied to the one judgement field that
                # can park a pull request on its own. An unevidenced "low" is the old category
                # escalation wearing a new name: replayed against a consumer, a model that rated
                # everything low dropped the auto-merge rate straight back to 27%, which is
                # where it started. Saying a change cannot be undone means naming what cannot.
                | (($report.recoverability // "medium") | ascii_downcase) as $claimed
                | ((($report.recoverabilitySignals // []) | (type == "array") and (length > 0))) as $evidenced
                | (if $claimed == "low" and ($evidenced | not) then "medium" else $claimed end) as $recoverability
                | (($report.confidence // 0)) as $confidence

                | if $conclusion != "success" then "blocked"
                  elif $blockers > 0 then "blocked"
                  elif $protected == "true" or $owner == "true" or $level == 2 then "owner-review"
                  # A fact the workflow could not measure is not a fact. Anything other than a
                  # clean true or false here means protected_changes did not report, and the
                  # pull request goes to a person rather than through on a default.
                  elif $protected != "false" or $owner != "false" then "human-review"
                  elif $level == 1 and $recoverability == "low" then "human-review"
                  elif ($report | has("acceptanceCriteriaMet")) and $report.acceptanceCriteriaMet == false then "human-review"
                  elif $confidence < ($threshold | tonumber) then "human-review"
                  else "auto-merge"
                  end
              end
            end
        end
      end;

  try decide catch "invalid"
' "$output_file"
