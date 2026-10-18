#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/merge-train/merge-train.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Move the merge train: look at every open pull request, oldest first, and do for each the one
# thing it needs, with merges one at a time and repairs in parallel.
#
# The belt this replaces dispatched the gate for every eligible pull request at once. Each gate
# then resolved its branch against a default branch the gate ahead of it was about to move, so a
# night of ten pull requests became ten repairs, ten CI runs and ten more gates after every merge,
# and a verdict that parked a pull request held it however stale it went.
#
# What races is a merge, because it moves the default branch under everyone else. A repair (a gate
# handed red CI) pushes to its own branch and can never merge, so it races nothing. So:
#   merge    one at a time, the oldest ready pull request first; nothing behind a pull request that
#            is waiting on its CI, or behind a gate that may merge, merges or is brought up to date
#   repair   a red or conflicting pull request goes to the gate at once, up to MAX_REPAIRS together
#   approve  its CI is waiting for approval and a trusted bot opened it
#   update   it is green but behind the default branch: merge the default branch in, CI reruns
# A pull request a person has to decide on, or that carries the hold label, is skipped, so it never
# blocks the line. Ticks come from every merge, every CI completion, every finished gate, and the
# hourly schedule as the fallback.
#
# `train_move` is pure, so the route matrix sources this file and exercises the same decision the
# train runs. Everything below it reads GitHub and acts.

set -euo pipefail

# Facts in, one move out. Every input is a plain string the I/O layer measured:
#   HOLD               true when the pull request carries the hold label
#   REVIEW_DECISION    GitHub's review decision (CHANGES_REQUESTED holds it for its author)
#   PARK               none, or held when a standing gate verdict covers this head
#   ATTEMPTS           failed gate attempts on this head; MAX_ATTEMPTS is the budget. Counts the
#                      larger of the attempt comments and the gate runs, so a gate that fails
#                      without a comment still spends it
#   SILENT_GATE        true when a gate already ran on this head and left no verdict and no attempt
#                      comment: it declined, or died before it could say so. Handing it the same
#                      pull request again reproduces that, a hot loop with every tick
#   MERGEABLE          MERGEABLE, CONFLICTING or UNKNOWN
#   CI_STATUS          none, or the latest CI run's status (queued, in_progress, completed, ...)
#   CI_CONCLUSION      that run's conclusion when it completed
#   CI_STUCK           true when that run has been pending longer than the train waits
#   SAME_AS_MAIN       true when every check that failed on the head also fails on the base branch
#                      tip: the failure is the base's, and repairing the pull request spends its
#                      attempts on code that is not at fault (Pliny-Bot, 2026-10-17: a red main
#                      cost every open pull request its repairs for seven hours)
#   BEHIND_BY          commits on the base branch the head does not have
#   TRUSTED_AUTHOR     true when a trusted bot opened it (only those runs are approved)
train_move() {
  local move="" reason=""

  if [ "${HOLD:-false}" = true ]; then
    move=skip; reason="it carries the hold label"
  elif [ "${REVIEW_DECISION:-}" = CHANGES_REQUESTED ]; then
    move=skip; reason="a reviewer requested changes"
  elif [ "${PARK:-none}" = held ]; then
    move=skip; reason="a gate verdict on this head is waiting for a person"
  elif [ "${ATTEMPTS:-0}" -ge "${MAX_ATTEMPTS:-6}" ]; then
    move=skip; reason="its gate attempt budget on this head is spent"
  elif [ "${SILENT_GATE:-false}" = true ]; then
    move=skip; reason="its gate already ran on this head and left no verdict or attempt"
  elif [ "${MERGEABLE:-UNKNOWN}" = CONFLICTING ]; then
    # A conflicting pull request has no merge ref, so CI can never run on it: waiting for a
    # verdict would wait forever. Resolving the conflict is the gate's job.
    move=gate; reason="it conflicts with its base branch"
  else
    case "${CI_STATUS:-none}" in
      none)
        move=skip; reason="no CI run on its head, nothing to gate on" ;;
      completed)
        case "${CI_CONCLUSION:-}" in
          success)
            if [ "${BEHIND_BY:-0}" -gt 0 ]; then
              move=update; reason="green but ${BEHIND_BY} commit(s) behind its base branch"
            else
              move=gate; reason="green and up to date"
            fi
            ;;
          failure)
            if [ "${SAME_AS_MAIN:-false}" = true ]; then
              move="wait"; reason="CI failed, but only on checks that fail on the base branch too; waiting for the base to be fixed"
            else
              move=gate; reason="CI failed"
            fi
            ;;
          action_required)
            if [ "${TRUSTED_AUTHOR:-false}" = true ]; then
              move=approve; reason="CI is waiting for approval"
            else
              move=skip; reason="CI is waiting for a person to approve it"
            fi
            ;;
          *) move=skip; reason="CI concluded '${CI_CONCLUSION:-none}', which is no verdict" ;;
        esac
        ;;
      *)
        if [ "${CI_STUCK:-false}" = true ]; then
          move=skip; reason="CI has been '${CI_STATUS}' for longer than the train waits"
        else
          move="wait"; reason="CI is ${CI_STATUS}"
        fi
        ;;
    esac
  fi

  printf 'move=%s\nreason=%s\n' "$move" "$reason"
}

# A standing verdict holds the pull request when it is newer than the head commit. Two verdicts
# never hold: `remediated` is the gate saying it pushed and wants the next CI, and its comment is
# always newer than the commit it pushed. `blocked` and a merge that did not happen expire once
# the base branch moves, a bounded number of times: the failure may have been the base's, and a
# repair attempt on a newer base is cheap next to a weekend of waiting.
#   VERDICT            the latest gate verdict word, or empty
#   VERDICT_NEWER      true when that verdict is newer than the head commit
#   BASE_MOVED         true when the base branch has a commit newer than the verdict
#   RETRIES            blocked or failed-merge verdicts already given on this head
#   MAX_RETRIES        how many of those the train retries before leaving it to a person
#   STACK_ROOT         true for a stack's root pull request, which a person merges unless it is ready
#   STACK_ROOT_READY   true for a root whose stack was announced complete after the last verdict, with
#                      STACK_ROOT_AUTOMERGE on: the train gives it one more gate run, which merges it
#                      unless the blast radius or a finding says a person must
train_park() {
  local park=none
  if [ "${VERDICT_NEWER:-false}" = true ]; then
    case "${VERDICT:-}" in
      remediated | "") park=none ;;
      blocked | auto-merge)
        if [ "${STACK_ROOT:-false}" = true ] && [ "${STACK_ROOT_READY:-false}" = true ]; then
          park=none
        elif [ "${STACK_ROOT:-false}" = true ]; then
          park=held
        elif [ "${BASE_MOVED:-false}" = true ] && [ "${RETRIES:-0}" -lt "${MAX_RETRIES:-3}" ]; then
          park=none
        else
          park=held
        fi
        ;;
      *) park=held ;;
    esac
  fi
  echo "$park"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

: "${REPO:?}" "${DEFAULT_BRANCH:?}" "${CI_WORKFLOW_NAME:?}"
TRUSTED_BOTS="${TRUSTED_BOTS:-}"
HOLD_LABEL="${HOLD_LABEL:-hold}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
MAX_RETRIES="${MAX_RETRIES:-3}"
MAX_REPAIRS="${MAX_REPAIRS:-1}"
case "$MAX_REPAIRS" in ''|*[!0-9]*|0) MAX_REPAIRS=1 ;; esac
MAIN_RED_WAIT_HOURS="${MAIN_RED_WAIT_HOURS:-2}"
STUCK_HOURS="${STUCK_HOURS:-3}"
DRY_RUN="${DRY_RUN:-false}"
SELF_RUN_ID="${GITHUB_RUN_ID:-0}"
GATE_TITLE_PREFIX="Agent: Merge Gate - PR #"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

now_epoch=$(date -u +%s)
iso_epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }

summary() { printf '%s\n' "$*" >>"$SUMMARY"; }

# Every write goes through this, so a dry run is honest: there is no second path that forgets.
act() {
  local what="$1"
  shift
  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] $what"
    summary "**Next move (dry run):** $what"
    return 0
  fi
  echo "$what"
  summary "**Next move:** $what"
  "$@"
}

is_trusted_bot() {
  case " $TRUSTED_BOTS " in *" $1 "*) return 0 ;; esac
  return 1
}

# Who may ride the train: a trusted bot, or a person with write access. Asked once per login.
declare -A WRITE_ACCESS=()
can_ride() {
  local login="$1" permission
  is_trusted_bot "$login" && return 0
  if [ -z "${WRITE_ACCESS[$login]+set}" ]; then
    permission=$(gh api "repos/$REPO/collaborators/$login/permission" --jq '.permission' 2>/dev/null || echo none)
    case "$permission" in admin | maintain | write) WRITE_ACCESS[$login]=true ;; *) WRITE_ACCESS[$login]=false ;; esac
  fi
  [ "${WRITE_ACCESS[$login]}" = true ]
}

# The gates on the belt, one title per line. A gate handed red CI repairs and pushes and cannot
# merge, so run-name gives it a " (repair)" suffix and the router queues it per pull request;
# every other gate may merge, and there is one of those at a time across the repository. The run
# this tick belongs to is excluded: the tick after a gate runs inside the gate's own router run.
live_gates() {
  local status
  for status in queued in_progress waiting pending requested; do
    gh api "repos/$REPO/actions/workflows/work-router.yml/runs?status=$status&per_page=100"       --jq ".workflow_runs[]
        | select(.id != $SELF_RUN_ID)
        | select(.display_title | startswith(\"$GATE_TITLE_PREFIX\"))
        | .display_title" 2>/dev/null
  done | sort -u
}

# GitHub works mergeability out on demand: the first read of a pull request nobody has opened
# recently answers UNKNOWN while it computes. Ask until it settles.
mergeable_state() {
  local pr="$1" state=UNKNOWN
  for _ in 1 2 3 4 5 6; do
    state=$(gh pr view "$pr" --repo "$REPO" --json mergeable --jq '.mergeable' 2>/dev/null || echo UNKNOWN)
    [ "$state" = UNKNOWN ] || break
    sleep 5
  done
  echo "$state"
}

# Gate comments carry the marker and a Verdict line, on the pull request or on its issue. The
# agent's own report says `assessed` and is always followed by the disposition the workflow
# computed from it, so it is not a verdict of its own.
verdict_comments() {
  local number="$1"
  gh api --paginate "repos/$REPO/issues/$number/comments?per_page=100" \
    --jq '.[] | select((.body | contains("<!-- agent-merge-gate -->")) and (.body | test("Verdict:[*]+ [a-z-]+")))
      | [.created_at, (.body | capture("Verdict:[*]+ (?<v>[a-z-]+)").v)]
      | select(.[1] != "assessed") | @tsv' 2>/dev/null || true
}

# shellcheck disable=SC2317 # called through act
approve_runs() {
  local branch="$1" id
  gh api "repos/$REPO/actions/runs?status=action_required&branch=$branch" --jq '.workflow_runs[].id' |
    while IFS= read -r id; do
      gh api "repos/$REPO/actions/runs/$id/approve" --method POST >/dev/null
    done
}

# shellcheck disable=SC2317 # called through act
update_branch() {
  local pr="$1" head_sha="$2"
  gh api "repos/$REPO/pulls/$pr/update-branch" --method PUT -f expected_head_sha="$head_sha" >/dev/null
}

# How many gate runs were started for a pull request since a moment, whatever became of them. A
# run is titled by the router's run-name; this is the one count that does not depend on the gate
# having written anything.
gate_run_count() {
  local pr="$1" since="$2"
  gh api --paginate "repos/$REPO/actions/workflows/work-router.yml/runs?event=workflow_dispatch&per_page=100"     --jq "[.workflow_runs[] | select(.display_title == \"$GATE_TITLE_PREFIX$pr\") | select(.created_at > \"$since\")] | length"     2>/dev/null | awk '{ n += $1 } END { print n + 0 }'
}

attempt_count() {
  local number="$1" since="$2"
  gh api --paginate "repos/$REPO/issues/$number/comments?per_page=100" \
    --jq "[.[] | select(.body | contains(\"<!-- agent-merge-gate-attempt -->\")) | select(.created_at > \"$since\")] | length" \
    2>/dev/null | awk '{ n += $1 } END { print n + 0 }'
}

# shellcheck disable=SC2317 # called through act
dispatch_gate() {
  local pr="$1" conclusion="$2" run_id="$3" attempts="$4" since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh api "repos/$REPO/actions/workflows/work-router.yml/dispatches" --method POST \
    -f ref="$DEFAULT_BRANCH" \
    -f "inputs[operation]=merge-gate" \
    -f "inputs[pr-number]=$pr" \
    -f "inputs[ci-conclusion]=$conclusion" \
    -f "inputs[ci-run-id]=$run_id" \
    -f "inputs[attempts_so_far]=$attempts" >/dev/null
  # The next tick waits behind this one and must see the gate it started, or it starts a second.
  for _ in $(seq 1 12); do
    if gh api "repos/$REPO/actions/workflows/work-router.yml/runs?event=workflow_dispatch&created=>=$since&per_page=20" \
      --jq ".workflow_runs[] | select(.display_title | startswith(\"$GATE_TITLE_PREFIX$pr\")) | .id" 2>/dev/null | grep -q .; then
      return 0
    fi
    sleep 5
  done
  echo "::warning::Dispatched the gate for #$pr but its run did not appear within a minute."
}

summary "### Merge train"
summary ""

live_titles="$(live_gates)"
live_repairs=$(printf '%s
' "$live_titles" | grep -c ' (repair)$' || true)
live_merge=$(printf '%s
' "$live_titles" | grep -v ' (repair)$' | grep -c . || true)
live_for_pr() { printf '%s
' "$live_titles" | grep -qE "PR #$1( \(repair\))?$"; }
echo "On the belt: ${live_merge} merging gate(s), ${live_repairs} repair(s). Up to ${MAX_REPAIRS} repair(s) at once."
summary "On the belt: ${live_merge} merging gate(s), ${live_repairs} repair(s); up to ${MAX_REPAIRS} repair(s) at once."
summary ""

# Once a pull request ahead is waiting on its CI, or a gate that may merge is on the belt, nothing
# behind it may merge or be brought up to date: the oldest merges first, and one at a time.
merge_blocked=false
[ "$live_merge" -eq 0 ] || merge_blocked=true

base_head_date=""
base_head_date_for() {
  local base="$1"
  gh api "repos/$REPO/commits/$base" --jq '.commit.committer.date' 2>/dev/null || echo ""
}

summary "| PR | Author | Move | Why |"
summary "|---|---|---|---|"

mapfile -t candidates < <(
  gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" |
    jq -r --arg repo "$REPO" --arg hold "$HOLD_LABEL" '
      .[]
      | select(.draft == false and (.head.repo.full_name // "") == $repo)
      | [.number, .user.login, .head.sha, .head.ref, .base.ref,
         ([.labels[].name] | index($hold) != null)] | @tsv' |
    sort -n
)

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "No open pull request on this repository; the train is empty."
  summary "| - | - | empty | no open pull request |"
  exit 0
fi

for line in "${candidates[@]}"; do
  IFS=$'\t' read -r pr author head_sha head_ref base_ref hold <<<"$line"

  if ! can_ride "$author"; then
    echo "#$pr: opened by $author, who has no write access; not on the train."
    continue
  fi

  meta=$(gh pr view "$pr" --repo "$REPO" --json reviewDecision,commits,closingIssuesReferences 2>/dev/null || echo '{}')
  review_decision=$(jq -r '.reviewDecision // ""' <<<"$meta")
  head_committed=$(jq -r '[.commits[]?.committedDate] | max // ""' <<<"$meta")
  linked_issue=$(jq -r '.closingIssuesReferences[0].number // ""' <<<"$meta")

  # The latest verdict on the pull request or its issue, and how many retries it has had.
  verdicts=$(
    {
      verdict_comments "$pr"
      [ -z "$linked_issue" ] || verdict_comments "$linked_issue"
    } | sort
  )
  verdict_line=$(tail -1 <<<"$verdicts")
  verdict_at=$(cut -f1 <<<"$verdict_line")
  verdict=$(cut -f2 <<<"$verdict_line")
  verdict_newer=false
  if [ -n "$verdict_at" ] && { [ -z "$head_committed" ] || [ "$verdict_at" \> "$head_committed" ]; }; then
    verdict_newer=true
  fi
  retries=$(awk -F'\t' -v since="$head_committed" '$1 > since && ($2 == "blocked" || $2 == "auto-merge")' <<<"$verdicts" | grep -c . || true)

  base_moved=false
  if [ "$verdict_newer" = true ]; then
    base_head_date=$(base_head_date_for "$base_ref")
    if [ -n "$base_head_date" ] && [ "$base_head_date" \> "$verdict_at" ]; then
      base_moved=true
    fi
  fi

  stack_root=false
  stack_root_ready=false
  if [ "$verdict_newer" = true ] && [ -n "$linked_issue" ]; then
    if gh issue view "$linked_issue" --repo "$REPO" --json body --jq '.body // ""' 2>/dev/null |
      grep -q "<!-- stack-root-pr: $pr -->"; then
      stack_root=true
      if [ "${STACK_ROOT_AUTOMERGE:-false}" = true ]; then
        announced_at=$(gh api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" \
          --jq '.[] | select(.body | contains("<!-- stack-complete -->")) | .created_at' 2>/dev/null | sort | tail -1)
        if [ -n "$announced_at" ] && [ "$announced_at" \> "$verdict_at" ]; then
          stack_root_ready=true
        fi
      fi
    fi
  fi

  park=$(VERDICT="$verdict" VERDICT_NEWER="$verdict_newer" BASE_MOVED="$base_moved" \
    RETRIES="$retries" MAX_RETRIES="$MAX_RETRIES" STACK_ROOT="$stack_root" STACK_ROOT_READY="$stack_root_ready" train_park)

  attempts=0
  silent_gate=false
  if [ "$park" = none ]; then
    horizon="${head_committed:-1970-01-01T00:00:00Z}"
    # A retried verdict starts a fresh budget from the verdict it retries, not from the head.
    [ "$verdict_newer" = true ] && horizon="$verdict_at"
    attempts=$(attempt_count "$pr" "$horizon")
    if [ -n "$linked_issue" ]; then
      attempts=$((attempts + $(attempt_count "$linked_issue" "$horizon")))
    fi
    gate_runs=$(gate_run_count "$pr" "$horizon")
    # Comments say what the gate decided. Runs say it was asked. A run on this head that left no
    # attempt comment and no verdict is a gate that did nothing, and the next tick must not ask
    # again: that is the loop.
    if [ "$gate_runs" -gt 0 ] && [ "$attempts" -eq 0 ]; then silent_gate=true; fi
    [ "$gate_runs" -le "$attempts" ] || attempts="$gate_runs"
  fi

  ci=$(gh api "repos/$REPO/actions/runs?head_sha=$head_sha&per_page=100" \
    --jq '[.workflow_runs[] | select(.name == env.CI_WORKFLOW_NAME)] | sort_by(.created_at) | last // empty
      | [.id, .status, (.conclusion // ""), .created_at] | @tsv' 2>/dev/null || true)
  IFS=$'\t' read -r ci_run_id ci_status ci_conclusion ci_created <<<"${ci:-}"
  ci_status="${ci_status:-none}"
  # A CI run hands its verdict over from its last job, so the run itself is still in progress
  # when this tick reads it. Its own word stands in for the conclusion GitHub has not written yet.
  if [ -n "${HINT_RUN_ID:-}" ] && [ "${ci_run_id:-}" = "$HINT_RUN_ID" ] && [ "$ci_status" != completed ]; then
    case "${HINT_CONCLUSION:-}" in
      success | failure) ci_status=completed; ci_conclusion="$HINT_CONCLUSION" ;;
    esac
  fi
  ci_stuck=false
  if [ "$ci_status" != none ] && [ "$ci_status" != completed ] && [ -n "${ci_created:-}" ]; then
    [ $((now_epoch - $(iso_epoch "$ci_created"))) -lt $((STUCK_HOURS * 3600)) ] || ci_stuck=true
  fi

  mergeable=UNKNOWN
  behind_by=0
  if [ "$park" = none ] && [ "$hold" != true ] && [ "$review_decision" != CHANGES_REQUESTED ]; then
    mergeable=$(mergeable_state "$pr")
    if [ "$ci_status" = completed ] && [ "$ci_conclusion" = success ]; then
      behind_by=$(gh api "repos/$REPO/compare/$base_ref...$head_sha" --jq '.behind_by' 2>/dev/null || echo 0)
    fi
  fi

  # What failed on the head, compared with what is failing on the base branch tip. Names are
  # compared after the last " / ": a check that a reusable workflow runs is "CI / backend" on the
  # base branch and "backend" on a pull request. Only when every failed check is also failing on
  # the base is the pull request left alone.
  same_as_main=false
  if [ "$ci_status" = completed ] && [ "$ci_conclusion" = failure ] && [ "$park" = none ]; then
    failed_here=$(gh api "repos/$REPO/commits/$head_sha/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.conclusion == "failure") | (.name | sub("^.* / "; ""))] | unique | .[]' 2>/dev/null || true)
    failed_base=$(gh api "repos/$REPO/commits/$base_ref/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.conclusion == "failure") | (.name | sub("^.* / "; ""))] | unique | .[]' 2>/dev/null || true)
    # How long the base has been red: the oldest failing check on its tip. The wait is bounded,
    # because waiting for a base nobody fixes starves every pull request behind it. Pliny-Bot's
    # main was red from 19:30 and the train waited until morning, ten hours, saying nothing.
    red_since=$(gh api "repos/$REPO/commits/$base_ref/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.conclusion == "failure") | .completed_at] | min // empty' 2>/dev/null || true)
    red_for_hours=0
    if [ -n "$red_since" ]; then
      red_for_hours=$(( (now_epoch - $(iso_epoch "$red_since")) / 3600 ))
    fi
    if [ -n "$failed_here" ] && [ -n "$failed_base" ] &&
      [ -z "$(comm -23 <(sort <<<"$failed_here") <(sort <<<"$failed_base"))" ]; then
      if [ "$red_for_hours" -lt "${MAIN_RED_WAIT_HOURS:-2}" ]; then
        same_as_main=true
      else
        echo "::warning::$base_ref has been red for ${red_for_hours}h on the same checks as #$pr; the train no longer waits for it and repairs #$pr."
      fi
    fi
  fi

  trusted_author=false
  is_trusted_bot "$author" && trusted_author=true

  decision=$(HOLD="$hold" REVIEW_DECISION="$review_decision" PARK="$park" \
    ATTEMPTS="$attempts" MAX_ATTEMPTS="$MAX_ATTEMPTS" SILENT_GATE="$silent_gate" MERGEABLE="$mergeable" \
    CI_STATUS="$ci_status" CI_CONCLUSION="$ci_conclusion" CI_STUCK="$ci_stuck" SAME_AS_MAIN="$same_as_main" \
    BEHIND_BY="${behind_by:-0}" TRUSTED_AUTHOR="$trusted_author" train_move)
  move=$(sed -n 's/^move=//p' <<<"$decision")
  reason=$(sed -n 's/^reason=//p' <<<"$decision")

  # A repair gate dispatched for red CI is moot once CI on the head is green: its job was to make
  # that run pass. Left alone it keeps the pull request marked as having a gate, so the train
  # skipped four green Pliny-Bot pull requests with "a gate is already on it" until it was cancelled
  # by hand. Cancel it and let the pull request move.
  if { [ "$move" = gate ] || [ "$move" = update ]; } && [ "$ci_status" = completed ] && [ "$ci_conclusion" = success ] &&
    printf '%s\n' "$live_titles" | grep -qE "PR #${pr} \(repair\)$"; then
    for run_id in $(gh api "repos/$REPO/actions/workflows/work-router.yml/runs?per_page=100" \
      --jq ".workflow_runs[] | select(.status != \"completed\" and (.display_title | endswith(\"PR #${pr} (repair)\"))) | .id" 2>/dev/null); do
      act "Cancelling the repair gate $run_id on #$pr: its CI is green." \
        gh api -X POST "repos/$REPO/actions/runs/$run_id/cancel" --silent
    done
    live_titles=$(printf '%s\n' "$live_titles" | grep -vE "PR #${pr} \(repair\)$" || true)
  fi

  # A gate is already on this pull request, whatever kind: offering it another would run the same
  # work twice. It does not hold the line up for the repair kind; a merging gate already does.
  if [ "$move" != skip ] && live_for_pr "$pr"; then
    move=skip
    reason="a gate is already on it"
  fi

  echo "#$pr ($author): $move, $reason."
  summary "| #$pr | $author | $move | $reason |"

  case "$move" in
    skip) continue ;;
    wait)
      # Its CI is running: nothing behind it may merge or be brought up to date first, but the
      # pull requests behind it that need repair do not wait for anyone.
      merge_blocked=true
      continue
      ;;
    approve)
      act "Approving the CI runs waiting on #$pr." approve_runs "$head_ref"
      merge_blocked=true
      continue
      ;;
    update)
      if [ "$merge_blocked" = true ]; then
        echo "  #$pr waits for the pull request ahead of it before it is brought up to date."
        continue
      fi
      # Merge, never rebase: the gate's pushes are fast-forward only, and so are a person's.
      if act "Merging $base_ref into #$pr so CI judges it against what it will land on." \
        update_branch "$pr" "$head_sha"; then
        merge_blocked=true
        continue
      fi
      echo "::warning::GitHub could not update #$pr from $base_ref; handing it to the gate."
      act "Dispatching the merge gate for #$pr to bring it up to date." \
        dispatch_gate "$pr" success "${ci_run_id:-}" "$attempts"
      merge_blocked=true
      continue
      ;;
    gate)
      conclusion="${ci_conclusion:-}"
      if [ "$ci_status" != completed ] || { [ "$conclusion" != success ] && [ "$conclusion" != failure ]; }; then
        # Only a conflict gets here without a usable verdict on this head. The branch's last
        # verdict tells the gate which path it is on; with none, the repair path resolves it.
        last=$(gh api "repos/$REPO/actions/runs?branch=$head_ref&per_page=100" \
          --jq '[.workflow_runs[] | select(.name == env.CI_WORKFLOW_NAME and .status == "completed"
                  and (.conclusion == "success" or .conclusion == "failure"))]
                | sort_by(.created_at) | last // empty | [.id, .conclusion] | @tsv' 2>/dev/null || true)
        ci_run_id=$(cut -f1 <<<"$last")
        conclusion=$(cut -f2 <<<"$last")
        [ -n "$conclusion" ] || conclusion=failure
      fi
      if [ "$conclusion" = failure ]; then
        # A repair: it pushes and can never merge, so it races nothing. Up to MAX_REPAIRS at once.
        if [ "$live_repairs" -ge "$MAX_REPAIRS" ]; then
          echo "  #$pr needs a repair; ${live_repairs} already in progress, the limit is ${MAX_REPAIRS}."
          continue
        fi
        act "Dispatching a repair gate for #$pr (CI failed, attempt $((attempts + 1)) of $MAX_ATTEMPTS)." \
          dispatch_gate "$pr" failure "${ci_run_id:-}" "$attempts"
        live_repairs=$((live_repairs + 1))
        continue
      fi
      # CI is green on the verdict: this gate may merge, so it goes only when nothing is ahead of it.
      if [ "$merge_blocked" = true ]; then
        echo "  #$pr is ready for the gate; it waits for the pull request ahead of it."
        continue
      fi
      act "Dispatching the merge gate for #$pr (CI $conclusion, attempt $((attempts + 1)) of $MAX_ATTEMPTS)." \
        dispatch_gate "$pr" "$conclusion" "${ci_run_id:-}" "$attempts"
      merge_blocked=true
      continue
      ;;
  esac
done

echo "That is every open pull request this tick could move."
summary ""
summary "Every open pull request was looked at; those that could move have."
