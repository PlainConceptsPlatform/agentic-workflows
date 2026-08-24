#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/classify-route/classify-route.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Classify one GitHub event into exactly one route. Pure: no network, no gh calls, so
# verify-route-matrix.sh can source this file and exercise the same code the router runs.
#
# Reads the event facts from the environment and writes `key=value` lines to stdout.
# The caller appends them to $GITHUB_OUTPUT.

set -euo pipefail

readonly AUDIT_CRON="17 1 * * 1"
readonly AUDIT_CLOSE_CRON="43 3 * * *"
readonly CLEANUP_ARTIFACTS_CRON="0 6 * * *"
readonly RECONCILE_BOT_PR_RUNS_CRON="17 */2 * * *"
# Daily, but it proposes far less often than daily: the worker holds one open
# proposal at a time and skips while that slot is filled. The cron is a heartbeat,
# the queue is the pacing.
readonly PROPOSE_CRON="29 7 * * *"

has_label() {
  jq -e --arg name "$1" 'index($name)' >/dev/null 2>&1 <<<"${ISSUE_LABELS:-[]}"
}

is_issue_number() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

classify_route() {
  local route="none" error=""
  local issue_number="" pr_number="" ci_conclusion="" ci_run_id=""
  local refine_mode="" direct_mode="" triage_mode="" trigger_kind=""
  local batch_branch=""

  case "${EVENT:-}" in
    issues)
      if [ "${ACTION:-}" = "opened" ]; then
        # Issue opened with a work label (refine/implement/direct) → skip triage.
        # The label event will trigger authorize-bot-work → bot-working → the
        # correct worker. Triage would only interfere.
        if has_label refine || has_label implement || has_label direct; then
          error="issue opened with a work label (refine/implement/direct); triage skipped"
        else
          # Issue opened by an outside collaborator → triage. The authorize job
          # gates the caller on is_outside_collaborator; this routes unconditionally
          # so write+ openers classify to triage but the caller job skips them.
          route="triage"
          triage_mode="first"
          issue_number="${EVENT_ISSUE_NUMBER:-}"
        fi
      elif [ "${ACTION:-}" = "labeled" ]; then
        case "${LABEL:-}" in
          bot-working)
            # Bot adds bot-working → route based on which work label is present
            # BUT: if review label is present, do NOT route (human review required)
            if has_label review; then
              error="issue has review label; bot-working does not re-trigger while human review is required"
            elif has_label implement && has_label feature; then
              route="batch"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
            elif has_label implement; then
              route="implement"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
            elif has_label refine; then
              route="refine"
              refine_mode="first"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
            elif has_label direct; then
              route="direct"
              direct_mode="first"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
            else
              error="bot-working added but no work label (implement/refine/direct) found"
            fi
            ;;
          triage)
            # A maintainer can explicitly re-run triage by adding this label. The
            # triage worker adds it after claiming the issue, so bot label events
            # and an existing claim must not start a second worker.
            if [ "${ACTOR:-}" != "" ] && echo "${ACTOR:-}" | grep -q '\[bot\]$'; then
              error="bot-added triage label does not re-trigger triage"
            elif has_label bot-working; then
              error="issue already has bot-working label; triage already in progress"
            else
              route="triage"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
              triage_mode="first"
            fi
            ;;
          refine | implement | direct)
            # If the actor is a bot (e.g. refine→implement transition), route directly.
            # If the actor is a human, authorize-bot-work.yml will add bot-working which triggers the workflow.
            if [ "${ACTOR:-}" != "" ] && echo "${ACTOR:-}" | grep -q '\[bot\]$'; then
              route="${LABEL:-}"
              issue_number="${EVENT_ISSUE_NUMBER:-}"
              if [ "${LABEL:-}" = "refine" ]; then
                refine_mode="first"
              elif [ "${LABEL:-}" = "direct" ]; then
                direct_mode="first"
              fi
            elif has_label bot-working; then
              # Already has bot-working - the workflow is already running or queued.
              # Don't re-trigger.
              error="issue already has bot-working label; implement/refine/direct already in progress"
            else
              error="waiting for bot to add bot-working label"
            fi
            ;;
        esac
      fi
      ;;

    issue_comment)
      if [ "${COMMENT_ON_PR:-false}" = "true" ]; then
        route="apply-review"
        pr_number="${EVENT_ISSUE_NUMBER:-}"
      elif [ "${COMMENT_SENDER_TYPE:-}" = "Bot" ]; then
        error="comment authored by a bot"
      elif has_label triage; then
        route="triage"
        triage_mode="retriage"
        issue_number="${EVENT_ISSUE_NUMBER:-}"
      elif has_label implement; then
        error="issue has implement label; comments do not re-trigger implement"
      elif has_label direct; then
        route="direct"
        direct_mode="continue"
        issue_number="${EVENT_ISSUE_NUMBER:-}"
      elif ! has_label refine; then
        error="issue does not carry the refine or direct label"
      else
        route="refine"
        refine_mode="rerefine"
        issue_number="${EVENT_ISSUE_NUMBER:-}"
      fi
      ;;

    pull_request_review_comment | pull_request_review)
      route="apply-review"
      pr_number="${EVENT_PR_NUMBER:-}"
      ;;

    pull_request_target)
      if [ "${ACTION:-}" = "labeled" ] && [ "${LABEL:-}" = "merge-gate" ]; then
        # Human adds merge-gate label to bot PR → triggers merge-gate with human actor
        # This bypasses gh-aw's bot membership check since the actor is human
        route="merge-gate"
        pr_number="${EVENT_PR_NUMBER:-}"
        # CI status will be fetched by the merge-gate workflow
        ci_conclusion=""
        ci_run_id=""
      else
        route="bot-approve"
      fi
      ;;

    workflow_run)
      if is_issue_number "${RUN_PR_NUMBER:-}"; then
        route="merge-gate"
        pr_number="${RUN_PR_NUMBER}"
        ci_conclusion="${RUN_CONCLUSION:-}"
        ci_run_id="${RUN_ID:-}"
      else
        error="CI run has no attached pull request"
      fi
      ;;

    schedule)
      trigger_kind="scheduled"
      case "${SCHEDULE:-}" in
        "$AUDIT_CRON") route="audit" ;;
        "$AUDIT_CLOSE_CRON") route="audit-close" ;;
        "$CLEANUP_ARTIFACTS_CRON") route="cleanup-artifacts" ;;
        "$RECONCILE_BOT_PR_RUNS_CRON") route="reconcile-bot-pr-runs" ;;
        *) error="no route for cron '${SCHEDULE:-}'" ;;
      esac
      ;;

    workflow_dispatch)
      trigger_kind="manual"
      case "${OPERATION:-}" in
        refine | implement | direct)
          if is_issue_number "${INPUT_ISSUE_NUMBER:-}"; then
            route="${OPERATION}"
            issue_number="${INPUT_ISSUE_NUMBER}"
            batch_branch="${INPUT_BATCH_BRANCH:-}"
            if [ "$OPERATION" = "refine" ]; then
              refine_mode="${INPUT_MODE:-first}"
            elif [ "$OPERATION" = "direct" ]; then
              direct_mode="${INPUT_MODE:-first}"
            fi
          else
            error="operation '${OPERATION}' needs a positive issue-number, got '${INPUT_ISSUE_NUMBER:-}'"
          fi
          ;;
        triage)
          if is_issue_number "${INPUT_ISSUE_NUMBER:-}"; then
            route="triage"
            issue_number="${INPUT_ISSUE_NUMBER}"
            triage_mode="${INPUT_MODE:-first}"
          else
            error="operation 'triage' needs a positive issue-number, got '${INPUT_ISSUE_NUMBER:-}'"
          fi
          ;;
        batch)
          if is_issue_number "${INPUT_ISSUE_NUMBER:-}"; then
            route="batch"
            issue_number="${INPUT_ISSUE_NUMBER}"
          else
            error="operation 'batch' needs a positive issue-number, got '${INPUT_ISSUE_NUMBER:-}'"
          fi
          ;;
        apply-review)
          if is_issue_number "${INPUT_PR_NUMBER:-}"; then
            route="apply-review"
            pr_number="${INPUT_PR_NUMBER}"
          else
            error="operation 'apply-review' needs a positive pr-number, got '${INPUT_PR_NUMBER:-}'"
          fi
          ;;
        merge-gate)
          if is_issue_number "${INPUT_PR_NUMBER:-}"; then
            route="merge-gate"
            pr_number="${INPUT_PR_NUMBER}"
            ci_conclusion="${INPUT_CI_CONCLUSION:-}"
            ci_run_id="${INPUT_CI_RUN_ID:-}"
          else
            error="operation 'merge-gate' needs a positive pr-number, got '${INPUT_PR_NUMBER:-}'"
          fi
          ;;
        audit | propose)
          route="${OPERATION}"
          trigger_kind="${INPUT_TRIGGER_KIND:-manual}"
          ;;
          audit-close | cleanup-artifacts | reconcile-bot-pr-runs | validate)
          route="${OPERATION}"
          ;;
        *)
          error="unknown operation '${OPERATION:-}'"
          ;;
      esac
      ;;

    *)
      error="unsupported event '${EVENT:-}'"
      ;;
  esac

  cat <<EOF
route=${route}
issue-number=${issue_number}
pr-number=${pr_number}
ci-conclusion=${ci_conclusion}
ci-run-id=${ci_run_id}
refine-mode=${refine_mode}
direct-mode=${direct_mode}
triage-mode=${triage_mode}
trigger-kind=${trigger_kind}
batch-branch=${batch_branch}
error=${error}
EOF
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  classify_route
fi
