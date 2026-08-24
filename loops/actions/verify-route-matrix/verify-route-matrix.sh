#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-route-matrix/verify-route-matrix.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Exercise the router's real classifier. This sources classify-route.sh rather than
# restating it, so a change to the route table cannot pass here by being copied twice.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER_YML="${HERE}/../../workflows/work-router.yml"
IMPLEMENT_WORKER_MD="${HERE}/../../workflows/agent-implement.md"
MERGE_GATE_WORKER_MD="${HERE}/../../workflows/agent-merge-gate.md"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../classify-route/classify-route.sh
source "${HERE}/../classify-route/classify-route.sh"

PASS=0
FAIL=0

# Classify one event and read a single field out of the result.
route_field() {
  local field="$1"
  shift

  local key value
  local -a assignments=("$@")

  (
    unset EVENT ACTION LABEL ISSUE_LABELS EVENT_ISSUE_NUMBER EVENT_PR_NUMBER \
      COMMENT_ON_PR COMMENT_SENDER_TYPE RUN_PR_NUMBER RUN_CONCLUSION RUN_ID \
      SCHEDULE OPERATION INPUT_ISSUE_NUMBER INPUT_PR_NUMBER INPUT_MODE \
      INPUT_CI_CONCLUSION INPUT_CI_RUN_ID INPUT_TRIGGER_KIND

    for assignment in "${assignments[@]}"; do
      key="${assignment%%=*}"
      value="${assignment#*=}"
      export "${key}=${value}"
    done

    classify_route | sed -n "s/^${field}=//p"
  )
}

assert() {
  local label="$1" expected="$2" actual="$3"

  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$label" "$expected" "$actual" >&2
  fi
}

assert_route() {
  local label="$1" expected="$2"
  shift 2
  assert "$label" "$expected" "$(route_field route "$@")"
}

echo "── Label events ──────────────────────────────────────────────────────────"
assert_route "refine label routes to refine" refine \
  EVENT=issues ACTION=labeled LABEL=refine EVENT_ISSUE_NUMBER=42
assert_route "implement label routes to implement" implement \
  EVENT=issues ACTION=labeled LABEL=implement EVENT_ISSUE_NUMBER=42
assert_route "unrelated label routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=documentation EVENT_ISSUE_NUMBER=42
assert_route "issue opened without labels routes to triage" triage \
  EVENT=issues ACTION=opened EVENT_ISSUE_NUMBER=42
assert_route "issue opened with refine label skips triage" none \
  EVENT=issues ACTION=opened 'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42
assert_route "issue opened with implement label skips triage" none \
  EVENT=issues ACTION=opened 'ISSUE_LABELS=["implement"]' EVENT_ISSUE_NUMBER=42
assert_route "issue opened with direct label skips triage" none \
  EVENT=issues ACTION=opened 'ISSUE_LABELS=["direct"]' EVENT_ISSUE_NUMBER=42
assert_route "a human triage label routes to triage" triage \
  EVENT=issues ACTION=labeled LABEL=triage ACTOR=maintainer EVENT_ISSUE_NUMBER=42
assert_route "a bot triage label routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=triage ACTOR=platform-devbox[bot] EVENT_ISSUE_NUMBER=42
assert "refine label starts a first pass" first \
  "$(route_field refine-mode EVENT=issues ACTION=labeled LABEL=refine EVENT_ISSUE_NUMBER=42)"
assert_route "direct label routes to direct" direct \
  EVENT=issues ACTION=labeled LABEL=direct EVENT_ISSUE_NUMBER=42
assert "direct label starts a first pass" first \
  "$(route_field direct-mode EVENT=issues ACTION=labeled LABEL=direct EVENT_ISSUE_NUMBER=42)"

echo "── Comment events ────────────────────────────────────────────────────────"
assert_route "a comment on a pull request routes to apply-review" apply-review \
  EVENT=issue_comment COMMENT_ON_PR=true EVENT_ISSUE_NUMBER=7
assert_route "an author reply on a refine issue re-refines" refine \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  'ISSUE_LABELS=["refine","review"]' EVENT_ISSUE_NUMBER=42
assert "an author reply is a rerefine pass" rerefine \
  "$(route_field refine-mode EVENT=issue_comment COMMENT_ON_PR=false \
    COMMENT_SENDER_TYPE=User 'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42)"
assert_route "the bot's own comment never re-enters refine" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=Bot \
  'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42
assert_route "a comment on an issue without refine routes nowhere" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  'ISSUE_LABELS=["bug"]' EVENT_ISSUE_NUMBER=42
assert_route "an author reply on a direct issue continues" direct \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  'ISSUE_LABELS=["direct"]' EVENT_ISSUE_NUMBER=42
assert "a direct reply is a continue pass" continue \
  "$(route_field direct-mode EVENT=issue_comment COMMENT_ON_PR=false \
    COMMENT_SENDER_TYPE=User 'ISSUE_LABELS=["direct"]' EVENT_ISSUE_NUMBER=42)"
assert_route "the bot's own comment never re-enters direct" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=Bot \
  'ISSUE_LABELS=["direct"]' EVENT_ISSUE_NUMBER=42
assert_route "a comment on a triage issue re-triages" triage \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42
assert "a triage re-trigger is a retriage pass" retriage \
  "$(route_field triage-mode EVENT=issue_comment COMMENT_ON_PR=false \
    COMMENT_SENDER_TYPE=User 'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42)"
assert_route "the bot's own comment never re-enters triage" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=Bot \
  'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42

echo "── Review events ─────────────────────────────────────────────────────────"
assert_route "a review comment routes to apply-review" apply-review \
  EVENT=pull_request_review_comment EVENT_PR_NUMBER=7
assert_route "a submitted review routes to apply-review" apply-review \
  EVENT=pull_request_review EVENT_PR_NUMBER=7
assert_route "a pull_request_target routes to bot-approve" bot-approve \
  EVENT=pull_request_target ACTION=opened

echo "── CI completion ─────────────────────────────────────────────────────────"
assert_route "App CI completion routes to merge-gate" merge-gate \
  EVENT=workflow_run RUN_PR_NUMBER=7 RUN_CONCLUSION=success RUN_ID=99
assert "merge-gate carries the CI conclusion" failure \
  "$(route_field ci-conclusion EVENT=workflow_run RUN_PR_NUMBER=7 \
    RUN_CONCLUSION=failure RUN_ID=99)"
assert_route "a CI run with no pull request routes nowhere" none \
  EVENT=workflow_run RUN_PR_NUMBER= RUN_CONCLUSION=success RUN_ID=99

echo "── Schedules ─────────────────────────────────────────────────────────────"
while read -r cron; do
  selected="$(route_field route EVENT=schedule "SCHEDULE=${cron}")"

  if [ "$selected" = "none" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: cron '${cron}' in work-router.yml maps to no route" >&2
  else
    PASS=$((PASS + 1))
    echo "  ${cron} -> ${selected}"
  fi
done < <(sed -n 's/^ *- cron: "\(.*\)"$/\1/p' "$ROUTER_YML")

assert_route "an unknown cron routes nowhere" none EVENT=schedule "SCHEDULE=0 0 30 2 *"

echo "── Manual dispatch ───────────────────────────────────────────────────────"
assert_route "refine dispatch needs an issue number" none \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=
assert_route "refine dispatch rejects a non-numeric issue" none \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=abc
assert_route "refine dispatch accepts a positive issue" refine \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=42
assert_route "direct dispatch accepts a positive issue" direct \
  EVENT=workflow_dispatch OPERATION=direct INPUT_ISSUE_NUMBER=42
assert_route "direct dispatch needs an issue number" none \
  EVENT=workflow_dispatch OPERATION=direct INPUT_ISSUE_NUMBER=
assert_route "triage dispatch accepts a positive issue" triage \
  EVENT=workflow_dispatch OPERATION=triage INPUT_ISSUE_NUMBER=42
assert_route "triage dispatch needs an issue number" none \
  EVENT=workflow_dispatch OPERATION=triage INPUT_ISSUE_NUMBER=
assert "triage dispatch defaults to first pass" first \
  "$(route_field triage-mode EVENT=workflow_dispatch OPERATION=triage INPUT_ISSUE_NUMBER=42)"
assert_route "merge-gate dispatch needs a pull request number" none \
  EVENT=workflow_dispatch OPERATION=merge-gate INPUT_PR_NUMBER=0
assert_route "merge-gate dispatch accepts a positive pull request" merge-gate \
  EVENT=workflow_dispatch OPERATION=merge-gate INPUT_PR_NUMBER=7
assert_route "stale-recovery dispatch needs no numbers" stale-recovery \
  EVENT=workflow_dispatch OPERATION=stale-recovery
assert_route "reconcile-bot-pr-runs dispatch needs no numbers" reconcile-bot-pr-runs \
  EVENT=workflow_dispatch OPERATION=reconcile-bot-pr-runs
assert_route "an unknown operation routes nowhere" none \
  EVENT=workflow_dispatch OPERATION=deploy-everything
assert "a scheduled audit reports its trigger kind" scheduled \
  "$(route_field trigger-kind EVENT=schedule "SCHEDULE=17 1 * * 1")"
assert "a dispatched audit reports its trigger kind" manual \
  "$(route_field trigger-kind EVENT=workflow_dispatch OPERATION=audit INPUT_TRIGGER_KIND=manual)"
assert_route "propose dispatch needs no numbers" propose \
  EVENT=workflow_dispatch OPERATION=propose
assert "a scheduled propose reports its trigger kind" scheduled \
  "$(route_field trigger-kind EVENT=schedule "SCHEDULE=29 7 * * *")"
assert "a dispatched propose reports its trigger kind" manual \
  "$(route_field trigger-kind EVENT=workflow_dispatch OPERATION=propose INPUT_TRIGGER_KIND=manual)"

echo "── Router wiring ─────────────────────────────────────────────────────────"
if grep -Fq 'protected-files: allowed' "$IMPLEMENT_WORKER_MD" &&
  grep -Fq 'protected_changes:' "$MERGE_GATE_WORKER_MD"; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: protected changes are not held for Merge Gate review" >&2
fi

# This repository is public. Every route a human can start from a comment, a review or a
# label must pass the authorize gate, or anyone able to comment can start a model run that
# writes code. Asserted here because removing the gate would otherwise be a silent, one-line
# change that nothing fails on.
for route in refine implement direct apply-review; do
  if grep -qE "route == '${route}'.*needs\.authorize\.outputs\.trusted == 'true'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: route '${route}' does not require needs.authorize.outputs.trusted" >&2
  fi
done

# Triage runs under a trusted App identity. Outside collaborators are admitted only to
# the deterministic dispatcher; the worker call itself requires a trusted actor.
if grep -qE "dispatch-triage:.*" "$ROUTER_YML" && \
   grep -qE "route == 'triage'.*is_outside_collaborator == 'true'" "$ROUTER_YML" && \
   grep -qE "route == 'triage'.*trusted == 'true'" "$ROUTER_YML"; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: route 'triage' does not dispatch outside collaborators and require a trusted worker actor" >&2
fi

for route in refine implement direct triage apply-review merge-gate audit propose bot-approve \
  audit-close cleanup-artifacts reconcile-bot-pr-runs stale-recovery validate; do
  if grep -q "route == '${route}'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: work-router.yml has no job for route '${route}'" >&2
  fi
done

while read -r operation; do
  if grep -q "route == '${operation}'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: dispatch operation '${operation}' has no job in work-router.yml" >&2
  fi
done < <(sed -n '/^      operation:/,/^      issue-number:/p' "$ROUTER_YML" |
  sed -n 's/^          - //p')

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Route matrix: ${PASS} passed"
else
  echo "Route matrix: ${PASS} passed, ${FAIL} FAILED" >&2
fi

exit $((FAIL > 0))
