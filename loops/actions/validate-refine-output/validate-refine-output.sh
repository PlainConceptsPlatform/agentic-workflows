#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-refine-output/validate-refine-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print the deterministic Refine outcome: complete, split, questions, or invalid.

set -euo pipefail

output_file="$1"
marker="$2"
comment_prefix="$3"
issue_number="$4"
draft_marker="$5"

if [ ! -f "$output_file" ] || ! jq -e '.items | arrays' "$output_file" >/dev/null 2>&1; then
  echo invalid
  exit 0
fi

jq -r --arg marker "$marker" --arg prefix "$comment_prefix" --arg issue "$issue_number" --arg draft_marker "$draft_marker" '
  def has_replacement_body:
    any(.items[]; .type == "update_issue" and
      (.item_number == null or (.item_number | tostring) == $issue) and
      (.body | type == "string") and (.body | test("[^[:space:]]")));

  def has_update:
    any(.items[]; .type == "update_issue");

  # A temporal draft is a replacement body the worker still expects to grow: the draft
  # marker distinguishes it from a finished body.
  def has_draft_body:
    any(.items[]; .type == "update_issue" and
      (.item_number == null or (.item_number | tostring) == $issue) and
      (.body | type == "string") and
      (.body | contains($draft_marker)));

  # A split writes children, which are the only items allowed to target something other than
  # the source issue: they do not exist yet, so they carry no number at all.
  def child_count:
    [.items[] | select(.type == "create_issue" and
      (.body | type == "string") and (.body | test("[^[:space:]]")) and
      (.title | type == "string") and (.title | test("[^[:space:]]")))] | length;

  # Signals about the run rather than about the issue. A worker reports these alongside
  # its real work, and they say nothing about where that work was aimed, so they are not
  # counted when deciding whether a run stayed on its own issue. Counting them meant a run
  # that refined the issue perfectly and also noted a difficulty was judged invalid and
  # its work discarded.
  def is_run_signal:
    .type == "report_incomplete" or .type == "missing_tool"
    or .type == "missing_data" or .type == "noop";

  def has_only_source_items:
    all(.items[] | select(is_run_signal | not);
      (
        .type == "update_issue" and
        (.item_number == null or (.item_number | tostring) == $issue)
      ) or
      (
        .type == "add_comment" and
        (.item_number | tostring) == $issue
      ) or
      .type == "create_issue");

  # A stack split also opens the root pull request: the one pull request refine may open, and
  # only alongside the children it integrates. Lyceum #45 emitted the parent body, two children
  # and that root, and was called invalid because a pull request is not a source item, so no
  # stack split had ever been accepted. Complete and questions keep has_only_source_items, so a
  # pull request anywhere but a split is still invalid.
  def root_pr_count:
    [.items[] | select(.type == "create_pull_request")] | length;

  def has_only_split_items:
    all(.items[] | select(is_run_signal | not);
      (
        .type == "update_issue" and
        (.item_number == null or (.item_number | tostring) == $issue)
      ) or
      (
        .type == "add_comment" and
        (.item_number | tostring) == $issue
      ) or
      .type == "create_issue" or
      .type == "create_pull_request");

  # The agent saying it did not finish. Survivable when it left real work behind, never
  # when all it left was a comment: a failed run must not be read as a question, or the
  # loop waits for an answer to something nobody asked.
  def reported_incomplete:
    any(.items[]; .type == "report_incomplete");

  def has_clarification:
    any(.items[]; .type == "add_comment" and (.item_number | tostring) == $issue and
      (.body | type == "string") and
      (.body | split($marker) | join("") | split($prefix) | join("") |
        gsub("<[^>]*>"; "") | test("[[:alnum:]]")));

  # Order matters: a run that wrote children is a split even though it also replaced the
  # parent body, and a lone child with no parent update is an incomplete split, not a
  # complete refinement. A body carrying the draft marker is a temporal draft, not a
  # finished refinement: it only counts as the questions outcome when the matching
  # batched-questions comment is also there.
  #
  # A comment with no update at all is a question asked before anything was drafted, which
  # the worker is allowed to do. A comment alongside an update that carries no draft is not:
  # that is the shape of a run that called update_issue and delivered no body, which Lyceum
  # #44 produced when the safe-outputs bridge passed 19 bytes instead of the 16,175 the
  # agent piped in. Requiring the draft unconditionally also rejected the first shape and
  # kept this branch red for eleven days; the two are told apart by has_update, not by
  # demanding a draft from both.
  if child_count >= 2 and has_replacement_body and has_only_split_items and root_pr_count <= 1 then "split"
  elif child_count > 0 then "invalid"
  elif has_replacement_body and (has_draft_body | not) and has_only_source_items then "complete"
  elif has_clarification and ((has_update | not) or has_draft_body) and has_only_source_items
    and (reported_incomplete | not) then "questions"
  else "invalid"
  end
' "$output_file"
