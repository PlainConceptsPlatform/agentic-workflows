#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/validate-refine-output/validate-refine-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Print the deterministic Refine outcome: complete, split, questions, or invalid.
# When REFINE_REASON_FILE is set, also write there, on one line, why an invalid output was refused
# (which rule, which item), so the run says why rather than only "invalid" (#574). The reason names
# item positions, item types and the validator's own rules, never the agent's text.

set -euo pipefail

output_file="$1"
marker="$2"
comment_prefix="$3"
issue_number="$4"
draft_marker="$5"
# The sentence the prompt opens every batch of questions with, and the mark it leaves in the draft
# wherever a question is still open.
questions_line="${6:-I have some questions about this issue}"
pending_mark="${7:-_pending see questions below_}"

reason_file="${REFINE_REASON_FILE:-}"

refuse() {
  [ -z "$reason_file" ] || printf '%s\n' "$1" > "$reason_file"
  echo invalid
  exit 0
}

[ -f "$output_file" ] || refuse "no agent_output.json: the agent published nothing the validator could read"
jq -e '.' "$output_file" >/dev/null 2>&1 || refuse "agent_output.json is not valid JSON"
jq -e '.items | arrays' "$output_file" >/dev/null 2>&1 || refuse "agent_output.json has no items array"

verdict="$(jq -r --arg marker "$marker" --arg prefix "$comment_prefix" --arg issue "$issue_number" --arg draft_marker "$draft_marker"   --arg questions_line "$questions_line" --arg pending_mark "$pending_mark" '
  # gh-aw names the target issue_number on update_issue (the prompt tells the agent to) and
  # item_number on add_comment. Reading item_number alone left every update_issue untargeted, so
  # the stays-on-its-own-issue rule never saw an update aimed at another issue.
  def target: (.item_number // .issue_number);
  def on_issue: (target == null or (target | tostring | ltrimstr("#")) == $issue);
  def on_issue_explicitly: (target != null and (target | tostring | ltrimstr("#")) == $issue);

  def has_replacement_body:
    any(.items[]; .type == "update_issue" and
      on_issue and
      (.body | type == "string") and (.body | test("[^[:space:]]")));

  def has_update:
    any(.items[]; .type == "update_issue");

  # A temporal draft is a replacement body the worker still expects to grow: the draft
  # marker distinguishes it from a finished body. The gh-aw process_safe_outputs strips
  # HTML comments from the body, so the draft marker (<!-- agent-refine-draft -->) can
  # be gone by the time the validator reads it (Bots #1336, run 42214146974). When the
  # draft marker is absent but the pending mark (_pending see questions below_) is
  # present, the body is still a draft: the pending mark only appears in drafts, and a
  # finished body has none.
  def has_draft_body:
    any(.items[]; .type == "update_issue" and
      on_issue and
      (.body | type == "string") and
      ((.body | contains($draft_marker)) or (.body | contains($pending_mark))));

  # The batched questions, by the sentence that opens them. It decides the outcome on its own:
  # Bots #561, #871 and Numa #821 asked, left a draft without the draft marker, were read as
  # complete, and implement started two seconds later on a story nobody had answered.
  # The prompt asks the model to open with the exact questions_line, but models paraphrase
  # it: GLM-5-2 wrote "I have some questions that the code cannot settle on its own" and the
  # exact-line match failed, dropping a valid questions outcome (Bots #1336). Match the exact
  # line, or its opening "I have some questions" prefix, which is specific enough in a refine
  # comment to never match the complete or split messages.
  def asks_questions:
    any(.items[]; .type == "add_comment" and on_issue_explicitly and
      (.body | type == "string") and
      ((.body | contains($questions_line)) or
       (.body | test("I have some questions"; "i"))));

  def has_pending_marks:
    any(.items[]; .type == "update_issue" and
      on_issue and
      (.body | type == "string") and (.body | contains($pending_mark)));

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
        on_issue
      ) or
      (
        .type == "add_comment" and
        on_issue_explicitly
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
        on_issue
      ) or
      (
        .type == "add_comment" and
        on_issue_explicitly
      ) or
      .type == "create_issue" or
      .type == "create_pull_request");

  # The agent saying it did not finish. Survivable when it left real work behind, never
  # when all it left was a comment: a failed run must not be read as a question, or the
  # loop waits for an answer to something nobody asked.
  def reported_incomplete:
    any(.items[]; .type == "report_incomplete");

  def has_clarification:
    any(.items[]; .type == "add_comment" and on_issue_explicitly and
      (.body | type == "string") and
      (.body | split($marker) | join("") | split($prefix) | join("") |
        gsub("<[^>]*>"; "") | test("[[:alnum:]]")));

  # A completion announcement. Branch 5 (has_clarification -> questions) treats any comment
  # with content as a question the agent asked, but a "Refinement complete" comment is not a
  # question: paired with a draft body (which is how branch 5 is reached, via has_draft_body)
  # it is a self-contradiction -- the agent said complete over a body still pending -- and the
  # right outcome is invalid, not questions. Seen as a regression after has_draft_body started
  # matching the pending mark when the HTML draft marker was stripped (1.15.0): the test "a body
  # still pending with no questions asked is not complete" flipped from invalid to questions.
  def has_completion_comment:
    any(.items[]; .type == "add_comment" and on_issue_explicitly and
      (.body | type == "string") and
      (.body | test("Refinement complete"; "i")));

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
  # The item list as "update_issue x2, add_comment", for a reason a person can read.
  def item_summary:
    [.items[] | (.type // "untyped" | tostring | gsub("[^A-Za-z0-9_]"; ""))]
    | group_by(.) | map(if length > 1 then "\(.[0]) x\(length)" else .[0] end) | join(", ");

  # 1-based positions of the items matching f, as "item 2" or "items 2, 3".
  def positions(f):
    [.items | to_entries[] | select(.value | f) | .key + 1] as $p
    | if ($p | length) == 1 then "item \($p[0])" else "items \($p | map(tostring) | join(", "))" end;

  def known_type:
    .type == "update_issue" or .type == "add_comment" or .type == "create_issue"
    or .type == "create_pull_request" or is_run_signal;

  def off_issue:
    (.type == "update_issue" and (on_issue | not)) or
    (.type == "add_comment" and (on_issue_explicitly | not));

  # The body of an update_issue is applied as the whole issue body, whatever operation the call
  # named: an append replaces the story with the appended part.
  def partial_update:
    .type == "update_issue" and (.operation != null) and (.operation != "replace");

  # Questions written into the body instead of a comment: what an agent does when add_comment
  # is refused (a workflow_dispatch run with add-comment target "triggering", #574).
  def questions_in_body:
    any(.items[]; .type == "update_issue" and (.body | type == "string") and
      ((.body | contains($questions_line)) or (.body | test("I have some questions|questions for the author|open questions"; "i"))));

  def has_comment: any(.items[]; .type == "add_comment");

  def outcome:
    if child_count >= 2 and has_replacement_body and has_only_split_items and root_pr_count <= 1 then "split"
    elif child_count > 0 then "invalid"
    elif any(.items[]; partial_update) then "invalid"
    elif asks_questions and ((has_update | not) or has_replacement_body) and has_only_source_items
      and (reported_incomplete | not) then "questions"
    elif has_replacement_body and (has_draft_body | not) and (has_pending_marks | not) and has_only_source_items then "complete"
    elif has_clarification and ((has_update | not) or has_draft_body) and has_only_source_items
      and (reported_incomplete | not) and (has_completion_comment | not) then "questions"
    else "invalid"
    end;

  # Why an invalid output was refused, most specific rule first.
  def reason:
    if (.items | length) == 0 then "no items: the agent published nothing"
    elif all(.items[]; is_run_signal) then
      "only run signals (\(item_summary)): the agent published no refinement"
    elif any(.items[]; known_type | not) then
      "\(positions(known_type | not)): a type refine does not publish (\(item_summary))"
    elif any(.items[]; off_issue) then
      "\(positions(off_issue)): not aimed at #\($issue): add_comment must name item_number \($issue), update_issue may name only #\($issue)"
    elif child_count == 1 then "a split needs at least two child issues with a title and a body; found 1"
    elif child_count == 0 and any(.items[]; .type == "create_issue") then
      "\(positions(.type == "create_issue")): a child issue without a title or a body"
    elif child_count >= 2 and (has_replacement_body | not) then
      "a split also replaces the parent body, and no update_issue on #\($issue) carries one"
    elif root_pr_count > 1 then "a split opens one root pull request; found \(root_pr_count)"
    elif child_count < 2 and root_pr_count > 0 then
      "\(positions(.type == "create_pull_request")): a pull request outside a split"
    elif (has_draft_body or has_pending_marks) and (has_comment | not) and questions_in_body then
      "the body is a draft and its questions were written into the issue body, not posted with add_comment on #\($issue) (add_comment was refused or never called\(if reported_incomplete then "; the agent reported the run incomplete" else "" end))"
    elif any(.items[]; partial_update) then
      "\(positions(partial_update)): update_issue with operation \([.items[] | select(partial_update) | .operation | tostring | gsub("[^A-Za-z0-9_]"; "")] | unique | join("/")), but refine applies each body as the whole issue body, so the story would be replaced by the fragment"
    elif has_update and (has_replacement_body | not) then
      "\(positions(.type == "update_issue")): update_issue with no body text (the call delivered no body)"
    elif asks_questions and reported_incomplete then
      "self-contradictory: questions were asked and the agent also reported the run incomplete"
    elif (has_draft_body or has_pending_marks) and has_completion_comment then
      "self-contradictory: a Refinement complete comment over a body still marked pending"
    elif (has_draft_body or has_pending_marks) and (asks_questions | not) and (has_clarification | not) then
      "the body is a draft (draft marker or pending marks) but no add_comment on #\($issue) asks its questions"
    elif has_comment and (has_clarification | not) then
      "\(positions(.type == "add_comment")): add_comment with no text beyond the marker and prefix"
    elif has_comment and (has_update | not) and reported_incomplete then
      "a comment alone, with the run reported incomplete: a failed run is not read as questions"
    else "no outcome rule matched (\(item_summary))"
    end;

  outcome as $outcome
  | if $outcome == "invalid" then "invalid\t\(reason)" else $outcome end
' "$output_file")"

outcome="${verdict%%$'\t'*}"
if [ "$outcome" = invalid ]; then
  refuse "${verdict#*$'\t'}"
fi
echo "$outcome"
