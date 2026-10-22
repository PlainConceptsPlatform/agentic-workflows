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
            elif [ "${CI_SHALLOW:-false}" = true ]; then
              move=deepen; reason="green on the light checks only; the full CI has not run on this head"
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

# The failing jobs of the CI run on a commit, read from the Actions API. The App behind the train's token
# can dispatch workflows but may not read check runs (403 "Resource not accessible by integration"): the
# check-runs calls then returned the same error text for the head and for the base, "what fails here" was
# always a subset of "what fails on the base", and every red pull request was left waiting. Nothing is
# printed, and the status is non-zero, when the run cannot be read, so the caller claims nothing.
ci_runs_for_sha() {
  local sha="$1" runs
  # Every completed run on the commit, not only the CI workflow's: on the default branch the CI runs inside the
  # deploy workflow. Extra failures on the base are harmless, the rule only asks that the pull request's own
  # failures are among them.
  runs=$(gh api "repos/$REPO/actions/runs?head_sha=$sha&per_page=100"     --jq '.workflow_runs[] | select(.status == "completed") | .id' 2>/dev/null) || return 1
  [ -n "$runs" ] || return 1
  printf '%s
' "$runs"
}

ci_failed_jobs() {
  local run="$1"
  gh api "repos/$REPO/actions/runs/$run/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion == "failure") | [(.name | sub("^.* / "; "")), .completed_at] | @tsv' 2>/dev/null
}

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

# Tiered CI: the label that asks a pull request's CI for the full depth. The CI's depth job reads the
# pull request's labels at run time, so a re-run of the same pull_request run turns full: the event and
# its context stay the pull request's, which the scope, mutation and coverage jobs rely on (a separate
# workflow_dispatch run would lose it, and mutation runs on pull_request events only).
CI_FULL_LABEL="ci-full"

mark_full_ci() {
  local pr="$1"
  gh label create "$CI_FULL_LABEL" --repo "$REPO" --color 0E8A16 \
    --description "The CI runs at full depth on this pull request (set by the merge train)" >/dev/null 2>&1 || true
  gh api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$CI_FULL_LABEL" >/dev/null 2>&1
}

deepen_ci() {
  local pr="$1" run="$2"
  [ -n "$run" ] || return 1
  mark_full_ci "$pr" || return 1
  # A CI handover reaches the train from inside the run, and a run still going cannot be re-run.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    [ "$(gh api "repos/$REPO/actions/runs/$run" --jq .status 2>/dev/null)" = completed ] && break
    sleep 10
  done
  gh run rerun "$run" --repo "$REPO" >/dev/null 2>&1
}

# Where a pull request stands in its base branch's merge queue: QUEUED, AWAITING_CHECKS, LOCKED,
# UNMERGEABLE or MERGEABLE, or empty when it is not in one.
queue_state() {
  local pr="$1"
  # shellcheck disable=SC2016
  gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){mergeQueueEntry{state}}}}' \
    -f o="${REPO%%/*}" -f n="${REPO#*/}" -F p="$pr" \
    --jq '.data.repository.pullRequest.mergeQueueEntry.state // ""' 2>/dev/null || true
}

# The failed merge-group CI run behind the queue's last ejection of a pull request since its head
# was pushed, or nothing. The queue names its branches gh-readonly-queue/<base>/pr-<number>-<sha>.
queue_ejection_run() {
  local pr="$1" since="$2" removed
  removed=$(gh api --paginate "repos/$REPO/issues/$pr/timeline?per_page=100" \
    --jq '.[] | select(.event == "removed_from_merge_queue") | .created_at' 2>/dev/null | sort | tail -1)
  [ -n "$removed" ] || return 0
  [ -z "$since" ] || [ "$removed" \> "$since" ] || return 0
  gh api "repos/$REPO/actions/runs?event=merge_group&per_page=100" \
    --jq "[.workflow_runs[] | select(.name == env.CI_WORKFLOW_NAME and .conclusion == \"failure\"
            and (.head_branch | test(\"/pr-$pr-\")))] | sort_by(.created_at) | last | .id // empty" 2>/dev/null || true
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
  # With GitHub's merge queue (MERGE_QUEUE) the queue orders, builds and merges: nothing here waits
  # for the pull request ahead, brings a branch up to date or asks for a deeper CI.
  [ "${MERGE_QUEUE:-false}" = true ] && merge_blocked=false

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
  # Tiered CI (CI_DEPTH_TIERED): a bot's push runs the light checks and the full CI runs once, when the
  # pull request is next in line. Pliny-Bot spent two thirds of its pull request CI on heads that were
  # replaced before they merged. A green run without a successful "Full CI" job was light and says
  # nothing about the tests. When the jobs cannot be read the run is taken as full, as before.
  ci_shallow=false
  if [ "${CI_DEPTH_TIERED:-false}" = true ] && [ "$ci_status" = completed ] && [ "$ci_conclusion" = success ] && [ -n "${ci_run_id:-}" ]; then
    full_jobs=$(gh api "repos/$REPO/actions/runs/$ci_run_id/jobs?per_page=100" \
      --jq '[.jobs[] | select((.name | test("(^|/ )Full CI$")) and .conclusion == "success")] | length' 2>/dev/null || echo "")
    [ "$full_jobs" = 0 ] && ci_shallow=true
  fi
  if [ "${MERGE_QUEUE:-false}" = true ]; then
    # The pull request's own CI is the light one; the full CI runs on the queue's merge group.
    ci_shallow=false
    if [ "$(queue_state "$pr")" != "" ]; then
      echo "#$pr ($author): skip, it is in the merge queue."
      summary "| #$pr | $author | skip | in the merge queue |"
      continue
    fi
    # The queue ejected it after this head was pushed: the merge group's CI failed on it, or it
    # conflicted with what was ahead. That run is the verdict the gate repairs from; the pull
    # request's own green light CI says nothing about it.
    if ejected_run=$(queue_ejection_run "$pr" "${head_committed:-}"); [ -n "$ejected_run" ]; then
      ci_run_id="$ejected_run"
      ci_status=completed
      ci_conclusion=failure
    fi
  fi
  ci_stuck=false
  if [ "$ci_status" != none ] && [ "$ci_status" != completed ] && [ -n "${ci_created:-}" ]; then
    [ $((now_epoch - $(iso_epoch "$ci_created"))) -lt $((STUCK_HOURS * 3600)) ] || ci_stuck=true
  fi

  mergeable=UNKNOWN
  behind_by=0
  if [ "$park" = none ] && [ "$hold" != true ] && [ "$review_decision" != CHANGES_REQUESTED ]; then
    mergeable=$(mergeable_state "$pr")
    if [ "$ci_status" = completed ] && [ "$ci_conclusion" = success ] && [ "${MERGE_QUEUE:-false}" != true ]; then
      behind_by=$(gh api "repos/$REPO/compare/$base_ref...$head_sha" --jq '.behind_by' 2>/dev/null || echo 0)
    fi
  fi

  # What failed on the head, compared with what is failing on the base branch tip. Names are
  # compared after the last " / ": a check that a reusable workflow runs is "CI / backend" on the
  # base branch and "backend" on a pull request. Only when every failed check is also failing on
  # the base is the pull request left alone.
  same_as_main=false
  if [ "$ci_status" = completed ] && [ "$ci_conclusion" = failure ] && [ "$park" = none ]; then
    failed_here=""
    failed_base=""
    red_since=""
    base_sha=$(gh api "repos/$REPO/commits/$base_ref" --jq .sha 2>/dev/null || true)
    here_jobs=$(ci_failed_jobs "${ci_run_id:-0}" || true)
    failed_here=$(cut -f1 <<<"$here_jobs" | sort -u)
    # A base tip with no completed CI run (a stack branch's tip is a merge commit nothing ran on) says
    # nothing about the base: the pull request is judged on its own failures.
    if [ -n "$base_sha" ] && base_runs=$(ci_runs_for_sha "$base_sha"); then
      base_jobs=""
      for base_run in $base_runs; do
        base_jobs="$base_jobs$(ci_failed_jobs "$base_run" || true)"$'
'
      done
      base_jobs=$(grep -v '^$' <<<"$base_jobs" || true)
      failed_base=$(cut -f1 <<<"$base_jobs" | sort -u)
      # How long the base has been red: the oldest failing job on its tip. The wait is bounded,
      # because waiting for a base nobody fixes starves every pull request behind it. Pliny-Bot's
      # main was red from 19:30 and the train waited until morning, ten hours, saying nothing.
      red_since=$(cut -f2 <<<"$base_jobs" | sort | head -1)
    fi
    red_for_hours=0
    if [ -n "$red_since" ]; then
      # A date that does not parse reads as epoch 0, which made main "red for 497899h" and ended the
      # wait at once (Pliny-Bot repaired five pull requests for failures main had too). No date, no claim.
      red_epoch=$(iso_epoch "$red_since")
      if [ "$red_epoch" -gt 0 ]; then
        red_for_hours=$(( (now_epoch - red_epoch) / 3600 ))
      else
        echo "::warning::Could not read when $base_ref went red ('$red_since'); waiting for it as if it just did."
      fi
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
    BEHIND_BY="${behind_by:-0}" TRUSTED_AUTHOR="$trusted_author" CI_SHALLOW="$ci_shallow" train_move)
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
    deepen)
      if [ "$merge_blocked" = true ]; then
        echo "  #$pr waits for the pull request ahead of it before its full CI runs."
        continue
      fi
      if act "Running the full CI on #$pr, which is next in line." deepen_ci "$pr" "${ci_run_id:-}"; then
        merge_blocked=true
        continue
      fi
      # Never a gate on the light run: it could merge code no test has run on. The pull request is
      # skipped this tick and the line moves on, so one that cannot be deepened does not stop the rest.
      echo "::warning::Could not start the full CI on #$pr; it is skipped this tick."
      continue
      ;;
    update)
      if [ "$merge_blocked" = true ]; then
        echo "  #$pr waits for the pull request ahead of it before it is brought up to date."
        continue
      fi
      # Next in line: with tiered CI the run this update starts is the one that decides, so it runs full.
      if [ "${CI_DEPTH_TIERED:-false}" = true ]; then
        act "Asking for the full CI on #$pr before it is brought up to date." mark_full_ci "$pr" ||
          echo "::warning::Could not label #$pr for the full CI; its update runs the light checks."
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
