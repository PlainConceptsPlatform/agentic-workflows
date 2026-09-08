#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-route-matrix/verify-route-matrix.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Exercise the router's real classifier. This sources classify-route.sh rather than
# restating it, so a change to the route table cannot pass here by being copied twice.
#
# The same file runs in every consumer, whatever subset of workers it installed: the router is
# regenerated for that subset, so every assertion about a worker or about its router job is
# conditional on the worker file being present. The classifier is the complete route table in
# every repository (a route with no job is a no-op run), so its assertions are unconditional.
#
# This file greps workflow sources for literal `${{ ... }}` expressions on purpose.
# shellcheck disable=SC2016

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS_DIR="${HERE}/../../workflows"
ROUTER_YML="${WORKFLOWS_DIR}/work-router.yml"
IMPLEMENT_WORKER_MD="${WORKFLOWS_DIR}/agent-implement.md"
MERGE_GATE_WORKER_MD="${WORKFLOWS_DIR}/agent-merge-gate.md"

# The audit slot is per repository and lives in the router's own env: block, which a real run
# exports into the classify step. Export it here too, or this file would test the classifier's
# fallback rather than the cron the router actually fires on.
router_env() {
  sed -n "s/^  $1: *//p" "$ROUTER_YML" | head -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
AUDIT_CRON="$(router_env AUDIT_CRON)"
export AUDIT_CRON

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../classify-route/classify-route.sh
source "${HERE}/../classify-route/classify-route.sh"

# Every worker route the package knows. The ones with a worker file here are installed; the
# others must have no job in this router. Plumbing routes are in every router.
ALL_WORKER_ROUTES=(refine implement triage apply-review merge-gate audit release)
PLUMBING_ROUTES=(bot-approve audit-close cleanup-artifacts reconcile-bot-pr-runs validate)

worker_installed() {
  [ -f "${WORKFLOWS_DIR}/agent-$1.md" ]
}

INSTALLED_ROUTES=()
EXCLUDED_ROUTES=()
for route in "${ALL_WORKER_ROUTES[@]}"; do
  if worker_installed "$route"; then
    INSTALLED_ROUTES+=("$route")
  else
    EXCLUDED_ROUTES+=("$route")
  fi
done
echo "Installed workers: ${INSTALLED_ROUTES[*]:-(none)}"
[ "${#EXCLUDED_ROUTES[@]}" -eq 0 ] || echo "Not installed: ${EXCLUDED_ROUTES[*]}"

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
assert_route "human refine label waits for authorization" none \
  EVENT=issues ACTION=labeled LABEL=refine ACTOR=maintainer EVENT_ISSUE_NUMBER=42
assert_route "bot refine label routes to refine" refine \
  EVENT=issues ACTION=labeled LABEL=refine ACTOR=platform-devbox[bot] EVENT_ISSUE_NUMBER=42
assert_route "human implement label waits for authorization" none \
  EVENT=issues ACTION=labeled LABEL=implement ACTOR=maintainer EVENT_ISSUE_NUMBER=42
assert_route "bot implement label routes to implement" implement \
  EVENT=issues ACTION=labeled LABEL=implement ACTOR=platform-devbox[bot] EVENT_ISSUE_NUMBER=42
assert_route "human feature label waits for authorization" none \
  EVENT=issues ACTION=labeled LABEL=feature ACTOR=maintainer EVENT_ISSUE_NUMBER=350
assert_route "unrelated label routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=documentation EVENT_ISSUE_NUMBER=42
assert_route "issue opened without labels routes to triage" triage \
  EVENT=issues ACTION=opened EVENT_ISSUE_NUMBER=42
assert_route "issue opened with refine label skips triage" none \
  EVENT=issues ACTION=opened 'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42
assert_route "issue opened with implement label skips triage" none \
  EVENT=issues ACTION=opened 'ISSUE_LABELS=["implement"]' EVENT_ISSUE_NUMBER=42
assert_route "a human triage label routes to triage" triage \
  EVENT=issues ACTION=labeled LABEL=triage ACTOR=maintainer EVENT_ISSUE_NUMBER=42
assert_route "a bot triage label routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=triage ACTOR=platform-devbox[bot] EVENT_ISSUE_NUMBER=42
assert_route "implement + bot-working without feature routes to implement" implement \
  EVENT=issues ACTION=labeled LABEL=bot-working 'ISSUE_LABELS=["implement","bot-working"]' EVENT_ISSUE_NUMBER=300
assert "refine label starts a first pass" first \
  "$(route_field refine-mode EVENT=issues ACTION=labeled LABEL=refine ACTOR=platform-devbox[bot] EVENT_ISSUE_NUMBER=42)"

echo "── Comment events ────────────────────────────────────────────────────────"
assert_route "a comment on a pull request routes to apply-review" apply-review \
  EVENT=issue_comment COMMENT_ON_PR=true EVENT_ISSUE_NUMBER=7
assert_route "the bot's own comment on a pull request never re-enters apply-review" none \
  EVENT=issue_comment COMMENT_ON_PR=true COMMENT_SENDER_TYPE=Bot EVENT_ISSUE_NUMBER=7
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
assert_route "a comment on a triage issue re-triages" triage \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42
assert "a triage re-trigger is a retriage pass" retriage \
  "$(route_field triage-mode EVENT=issue_comment COMMENT_ON_PR=false \
    COMMENT_SENDER_TYPE=User 'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42)"
assert_route "the bot's own comment never re-enters triage" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=Bot \
  'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42

echo "── Closed issues ─────────────────────────────────────────────────────────"
assert_route "a closing comment on a refine issue does not re-refine" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  ISSUE_STATE=closed 'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42
assert_route "a comment on a closed issue never re-triages" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  ISSUE_STATE=closed 'ISSUE_LABELS=["triage"]' EVENT_ISSUE_NUMBER=42
assert_route "a work label added to a closed issue routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=bot-working ISSUE_STATE=closed \
  'ISSUE_LABELS=["implement"]' EVENT_ISSUE_NUMBER=42
assert_route "a closed issue reopened as opened still routes nowhere while closed" none \
  EVENT=issues ACTION=opened ISSUE_STATE=closed 'ISSUE_LABELS=[]' EVENT_ISSUE_NUMBER=42
assert_route "a comment on a closed pull request still routes to apply-review" apply-review \
  EVENT=issue_comment COMMENT_ON_PR=true ISSUE_STATE=closed EVENT_ISSUE_NUMBER=7
assert_route "an open refine issue is unaffected by the closed guard" refine \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=User \
  ISSUE_STATE=open 'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42

echo "── Review events ─────────────────────────────────────────────────────────"
assert_route "a review comment routes to apply-review" apply-review \
  EVENT=pull_request_review_comment EVENT_PR_NUMBER=7
assert_route "a submitted review routes to apply-review" apply-review \
  EVENT=pull_request_review EVENT_PR_NUMBER=7
assert_route "a pull_request_target routes to bot-approve" bot-approve \
  EVENT=pull_request_target ACTION=opened

echo "── CI completion ─────────────────────────────────────────────────────────"
assert_route "a failed App CI run on a pull request routes to merge-gate" merge-gate \
  EVENT=workflow_run RUN_PR_NUMBER=7 RUN_CONCLUSION=failure RUN_ID=99
assert "merge-gate carries the failing CI conclusion" failure \
  "$(route_field ci-conclusion EVENT=workflow_run RUN_PR_NUMBER=7 \
    RUN_CONCLUSION=failure RUN_ID=99)"
assert "merge-gate carries the failing CI run id" 99 \
  "$(route_field ci-run-id EVENT=workflow_run RUN_PR_NUMBER=7 \
    RUN_CONCLUSION=failure RUN_ID=99)"
assert_route "a green App CI run does not auto-trigger the gate" none \
  EVENT=workflow_run RUN_PR_NUMBER=7 RUN_CONCLUSION=success RUN_ID=99
assert_route "a cancelled App CI run does not auto-trigger the gate" none \
  EVENT=workflow_run RUN_PR_NUMBER=7 RUN_CONCLUSION=cancelled RUN_ID=99
assert_route "a failed CI run with no pull request routes nowhere" none \
  EVENT=workflow_run RUN_PR_NUMBER= RUN_CONCLUSION=failure RUN_ID=99

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
done < <(sed -n 's/^ *- cron: "\([^"]*\)".*/\1/p' "$ROUTER_YML")

assert_route "an unknown cron routes nowhere" none EVENT=schedule "SCHEDULE=0 0 30 2 *"

echo "── Manual dispatch ───────────────────────────────────────────────────────"
assert_route "refine dispatch needs an issue number" none \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=
assert_route "refine dispatch rejects a non-numeric issue" none \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=abc
assert_route "refine dispatch accepts a positive issue" refine \
  EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=42
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
assert "merge-gate dispatch defaults its attempt count to zero" 0 \
  "$(route_field merge-gate-attempts EVENT=workflow_dispatch OPERATION=merge-gate INPUT_PR_NUMBER=7)"
assert "merge-gate dispatch forwards the attempt count" 3 \
  "$(route_field merge-gate-attempts EVENT=workflow_dispatch OPERATION=merge-gate INPUT_PR_NUMBER=7 INPUT_ATTEMPTS_SO_FAR=3)"
# The implement worker re-dispatches itself when a run dies before producing an answer, so the
# count has to survive the round trip or the budget never advances and the retry never stops.
assert "implement dispatch defaults its attempt count to zero" 0 \
  "$(route_field implement-attempts EVENT=workflow_dispatch OPERATION=implement INPUT_ISSUE_NUMBER=42)"
assert "implement dispatch forwards the attempt count" 2 \
  "$(route_field implement-attempts EVENT=workflow_dispatch OPERATION=implement INPUT_ISSUE_NUMBER=42 INPUT_ATTEMPTS_SO_FAR=2)"
assert "a refine dispatch carries no implement attempts" 0 \
  "$(route_field implement-attempts EVENT=workflow_dispatch OPERATION=refine INPUT_ISSUE_NUMBER=42 INPUT_ATTEMPTS_SO_FAR=2)"
assert_route "release dispatch needs no numbers" release \
  EVENT=workflow_dispatch OPERATION=release
assert_route "reconcile-bot-pr-runs dispatch needs no numbers" reconcile-bot-pr-runs \
  EVENT=workflow_dispatch OPERATION=reconcile-bot-pr-runs
assert_route "an unknown operation routes nowhere" none \
  EVENT=workflow_dispatch OPERATION=deploy-everything
assert "a scheduled audit reports its trigger kind" scheduled \
  "$(route_field trigger-kind EVENT=schedule "SCHEDULE=17 1 * * 1")"

assert "a dispatched audit reports its trigger kind" manual \
  "$(route_field trigger-kind EVENT=workflow_dispatch OPERATION=audit INPUT_TRIGGER_KIND=manual)"

echo "── Prompt hygiene ────────────────────────────────────────────────────────"

# Everything below a worker's frontmatter is the prompt. Three things must not be in one.
#
# A `gh` call, because the shared CI agent config says the GitHub CLI is intentionally
# unauthenticated and the agent must never use it for GitHub reads or writes. A prompt that
# orders one burns turns and fails; implement carried a `gh pr list` for weeks, asking the agent
# to redo a check the router had already done before dispatching it.
#
# A duplicate step number, because these are ordered instruction lists and a step that says
# "go to step 6" cannot resolve when there are two. implement had two 6s with contradictory
# rules ("exactly one" and "at least one" safe output), refine had two 5s, apply-review two 9s.
#
# A Mermaid diagram, because it is documentation that the model is charged for on every run and
# then told to ignore. They live in docs/diagrams.md.
PROMPT_OK=1
for worker in "${WORKFLOWS_DIR}"/agent-*.md; do
  [ -f "$worker" ] || continue
  name=$(basename "$worker")
  # The prompt starts after the closing --- of the frontmatter.
  fm_end=$(awk 'NR>1 && /^---[[:space:]]*$/{print NR; exit}' "$worker")
  [ -n "$fm_end" ] || { PROMPT_OK=0; echo "FAIL: ${name} has no frontmatter terminator" >&2; continue; }
  prompt=$(tail -n "+$((fm_end + 1))" "$worker")

  if grep -qE '(^|[^[:alnum:]_-])gh (pr|issue|api|run|release|workflow|auth) ' <<<"$prompt"; then
    PROMPT_OK=0
    echo "FAIL: ${name}'s prompt tells the agent to run gh; the CLI is unauthenticated in CI" >&2
    grep -nE '(^|[^[:alnum:]_-])gh (pr|issue|api|run|release|workflow|auth) ' <<<"$prompt" >&2
  fi

  if grep -q '```mermaid' <<<"$prompt"; then
    PROMPT_OK=0
    echo "FAIL: ${name}'s prompt contains a Mermaid diagram; diagrams belong in docs/diagrams.md" >&2
  fi

  # Top-level steps only: an indented "1." is a sub-list and numbers restart legitimately.
  dupes=$(grep -oE '^[0-9]+\. ' <<<"$prompt" | tr -d '. ' | sort -n | uniq -d | tr '\n' ' ')
  if [ -n "${dupes// /}" ]; then
    PROMPT_OK=0
    echo "FAIL: ${name}'s prompt repeats step number(s): ${dupes}" >&2
  fi

  # A multi-line env value does not survive compilation: gh-aw joins it onto one line in the
  # lock, so a Markdown table written across five lines in the source reaches the agent as a
  # single unreadable row. Verified against a compiled lock. Block the YAML block scalars that
  # produce one, so the flattening is a failed check rather than a silently useless value.
  block_scalars=$(awk '
    /^env:$/ { inenv = 1; next }
    inenv && /^[^ ]/ { inenv = 0 }
    inenv && /^  [A-Za-z_][A-Za-z0-9_]*: *[|>]-?[0-9]* *$/ { print $1 }
  ' "$worker" | tr -d ':' | tr '\n' ' ')
  if [ -n "${block_scalars// /}" ]; then
    PROMPT_OK=0
    echo "FAIL: ${name} declares env value(s) as a multi-line block, which the compiler flattens: ${block_scalars}" >&2
  fi
done
if [ "$PROMPT_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

echo "── Router wiring ─────────────────────────────────────────────────────────"

# Two router values are needed where GitHub evaluates no expression, so the installer mirrors
# them out of env: into a literal. A copy that drifts fails in the direction that hurts: the
# gate silently reads a CI workflow nobody runs, or the audit fires on a cron the classifier
# maps to no route. Neither produces a red run, so assert the copies here.
MIRROR_OK=1
ci_name="$(router_env CI_WORKFLOW_NAME)"
trigger_name="$(sed -n 's/^ *workflows: \["\(.*\)"\] *$/\1/p' "$ROUTER_YML" | head -1)"
if [ -z "$ci_name" ]; then
  MIRROR_OK=0; echo "FAIL: work-router.yml defines no CI_WORKFLOW_NAME in its env: block" >&2
elif [ "$ci_name" != "$trigger_name" ]; then
  MIRROR_OK=0
  echo "FAIL: the workflow_run trigger names '${trigger_name}' but env.CI_WORKFLOW_NAME is '${ci_name}'" >&2
fi
# The audit cron only exists in a router that installed the audit worker.
if worker_installed audit; then
  cron_line="$(sed -n 's/^ *- cron: "\([^"]*\)" # audit slot.*/\1/p' "$ROUTER_YML" | head -1)"
  if [ -z "$AUDIT_CRON" ]; then
    MIRROR_OK=0; echo "FAIL: work-router.yml defines no AUDIT_CRON in its env: block" >&2
  elif [ "$AUDIT_CRON" != "$cron_line" ]; then
    MIRROR_OK=0
    echo "FAIL: the audit slot cron is '${cron_line}' but env.AUDIT_CRON is '${AUDIT_CRON}'" >&2
  fi
fi
# And nothing may go back to naming the CI workflow directly: a second literal is a second
# thing to keep in step, and the one that gets forgotten is the one inside a jq filter.
if [ "$(grep -c '"App: CI"' "$ROUTER_YML")" -gt 2 ]; then
  MIRROR_OK=0
  echo "FAIL: work-router.yml hardcodes the CI workflow name outside env: and the mirrored trigger" >&2
  grep -n '"App: CI"' "$ROUTER_YML" >&2
fi
if [ "$MIRROR_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# GitHub evaluates every Actions expression in a workflow file, including ones written inside
# shell comments. An empty pair is not a valid expression and fails the whole file to parse,
# with an error that points at a line number rather than saying what is wrong. Prose about
# expressions must not contain one.
empty_expr=$(grep -rl -e '${{[[:space:]]*}}' "${WORKFLOWS_DIR}"/*.yml "${WORKFLOWS_DIR}"/*.md 2>/dev/null || true)
if [ -z "$empty_expr" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: workflow files contain an empty Actions expression:" >&2
  while IFS= read -r offending; do echo "  $offending" >&2; done <<<"$empty_expr"
fi

# A hyphen inside a ${{ }} property path is parsed as subtraction, so the reference silently
# resolves to nothing and the rendered prompt keeps the raw expression. Underscores only.
if worker_installed implement; then
  if ! grep -qE 'needs\.[a-z_]+\.outputs\.[a-zA-Z0-9_]*-' "$IMPLEMENT_WORKER_MD"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: implement worker reads a hyphenated job output inside an expression" >&2
    grep -nE 'needs\.[a-z_]+\.outputs\.[a-zA-Z0-9_]*-' "$IMPLEMENT_WORKER_MD" >&2
  fi
fi

# A worker that prints `${{ env.NAME }}` without defining NAME in its own env: block renders
# an empty value, and the model fills the gap itself. That is how a child shipped `dotnet build
# --no-restore` against an unrestored workspace: the verification block was empty. Every name a
# worker prints must be defined in that worker. The values are consumer-owned (a consumer may
# split VERIFY_COMMANDS per area, or keep one); only the wiring is asserted here.
VERIFY_OK=1
for worker in "${WORKFLOWS_DIR}"/agent-*.md; do
  [ -f "$worker" ] || continue
  while read -r name; do
    [ -n "$name" ] || continue
    if ! grep -q "^  ${name}:" "$worker"; then
      VERIFY_OK=0
      echo "FAIL: $(basename "$worker") prints env.${name} without defining it" >&2
    fi
  done < <(grep -oE '\$\{\{ *env\.[A-Za-z_][A-Za-z0-9_]* *\}\}' "$worker" | sed -E 's/.*env\.([A-Za-z_][A-Za-z0-9_]*).*/\1/' | sort -u)
done
if [ "$VERIFY_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

if worker_installed implement && worker_installed merge-gate; then
  if grep -Fq 'protected-files: allowed' "$IMPLEMENT_WORKER_MD" &&
    grep -Fq 'protected-files: allowed' "$MERGE_GATE_WORKER_MD" &&
    grep -Fq "needs.protected_changes.outputs.requires_review != 'true' || needs.subject.outputs.conclusion == 'failure'" "$MERGE_GATE_WORKER_MD"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: protected changes must allow failed-CI repair while remaining held from merge" >&2
  fi
fi

# gh-aw folds the worker's top-level `if:` into the generated activation job but computes
# activation's `needs` on its own: only custom jobs the prompt references AND that declare no
# `needs:` are hoisted. A guard with its own `needs:` (protected_changes needs subject) is read
# before it has run, resolves to '' and gates nothing, unless it is listed in `on.needs`, the
# documented way to add jobs to pre_activation and activation. Inline list form is expected.
if worker_installed merge-gate; then
  TOP_IF="$(tr -d '\r' <"$MERGE_GATE_WORKER_MD" | sed -n 's/^if: //p')"
  ON_NEEDS="$(tr -d '\r' <"$MERGE_GATE_WORKER_MD" | sed -n '/^on:$/,/^[a-z]/p' |
    sed -n 's/^  needs: *\[\(.*\)\].*/\1/p' | tr -d ' ' | tr ',' '\n')"
  ACTIVATION_OK=1
  [ -n "$TOP_IF" ] || { ACTIVATION_OK=0; echo "FAIL: could not read the merge-gate worker's top-level if" >&2; }
  while read -r job; do
    [ -n "$job" ] || continue
    if tr -d '\r' <"$MERGE_GATE_WORKER_MD" | sed -n "/^  ${job}:$/,/^  [a-z_]*:$/p" | grep -q '^    needs:' &&
      ! grep -qx "$job" <<<"$ON_NEEDS"; then
      ACTIVATION_OK=0
      echo "FAIL: merge-gate top-level if reads needs.${job}, which has its own needs and is not in on.needs; activation would read it before it runs" >&2
    fi
  done < <(grep -oE 'needs\.[a-z_]+\.' <<<"$TOP_IF" | sed 's/^needs\.//; s/\.$//' | sort -u)
  if [ "$ACTIVATION_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

  # The merge belt is serial for the whole repository: several overnight pull requests
  # mean every merge moves the default branch under the rest, and gates running at once
  # rebase onto bases other gates are about to invalidate. A per-issue group here would
  # reintroduce that race, so assert the repo-wide lock is the one in use.
  if grep -A7 'call-merge-gate:' "$ROUTER_YML" | grep -q 'group: merge-belt'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: call-merge-gate must hold the repo-wide merge-belt lock" >&2
  fi
fi

# A verdict is the gate marker AND a `**Verdict:**` line together. Comments carrying the
# marker alone were progress notes and failed attempts, and the reconcile belt read every
# one of them as final: a crashed or OOM-killed gate parked its pull request for the rest
# of the night. Attempts are counted separately, capped, and reset by any new CI run.
# The belt lives in the router's plumbing jobs, so this holds in every repository.
BELT_OK=1
if ! grep -q 'agent-merge-gate-attempt' "$ROUTER_YML"; then
  BELT_OK=0; echo "FAIL: router never counts gate attempts" >&2
fi
if [ "$(grep -cF 'contains("<!-- agent-merge-gate -->")) and (.body | contains("**Verdict:**"))' "$ROUTER_YML")" -lt 4 ]; then
  BELT_OK=0; echo "FAIL: verdict detection must pair the gate marker with a Verdict line in both dispatch paths" >&2
fi
if [ "$(grep -c 'attempts_so_far' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0; echo "FAIL: dispatch sites must forward attempts_so_far" >&2
fi
# A second gate for a pull request whose gate is already queued or running reads the same CI
# verdict and is cancelled by the single-slot merge-belt queue (two cancellations on 2026-09-06).
if [ "$(grep -c 'a merge-gate run is already live' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0; echo "FAIL: both dispatch paths must skip a pull request whose gate is already live" >&2
fi
# A conflicting pull request has no refs/pull/N/merge for GitHub to build, so a `pull_request`
# CI workflow can never run on that head. Requiring a fresh verdict before dispatching deadlocks
# the belt: only the gate resolves the conflict, and the gate never runs. Both paths fall back to
# the branch's last verdict when, and only when, the pull request is conflicting.
if [ "$(grep -c 'conflicts, so CI cannot run on' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0
  echo "FAIL: both dispatch paths must gate a conflicting pull request that can never get fresh CI" >&2
fi
# That fallback has to read the computed mergeable state. The REST boolean is null until GitHub
# recomputes it, and stays null for a pull request nobody has opened recently, which is exactly
# the stale conflicting pull request the fallback exists for: it never fired once in production.
# The state has to be polled, not read once. GitHub computes mergeability on demand and the
# first read answers UNKNOWN (or null through REST) while it works it out, so a single read
# reports "not conflicting" for exactly the stale pull requests the fallback is for. Observed
# twice in production: the fallback logged "no completed CI run" for a pull request that
# `gh pr view` reported as CONFLICTING from a warm cache seconds later.
if [ "$(grep -c 'mergeable_state()' "$ROUTER_YML")" -lt 2 ] ||
  [ "$(grep -c 'mergeable_now=$(mergeable_state' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0
  echo "FAIL: both dispatch paths must poll the mergeable state; a single read answers UNKNOWN" >&2
fi
if [ "$BELT_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# GitHub delivers workflow_run only for CI runs whose actor is a human, so a bot pull request's
# CI never reaches the router's CI-completion route. The package ships a dispatch-merge-gate job
# in templates/ci that hands the verdict over from inside CI; a consumer CI workflow, where one
# exists beside the router, must carry it or bot pull requests wait for the hourly belt.
for ci in "${WORKFLOWS_DIR}/ci.yml" "${WORKFLOWS_DIR}/app-ci.yml"; do
  [ -f "$ci" ] || continue
  if grep -q 'operation=merge-gate' "$ci"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $(basename "$ci") has no dispatch-merge-gate job; bot pull requests would wait for the hourly belt" >&2
  fi
done

# The router forwards a fact to a worker by reading `needs.classify.outputs.<x>`; a name the
# classify job does not export resolves to '' with no error. That is how the gate received
# attempts_so_far='' (the classifier emitted merge-gate-attempts, the job never exported it),
# fromJson('') killed the incomplete job before its attempt comment, and the belt re-dispatched
# the same crash every hour. Every name the router reads must be exported by the classify job.
CLASSIFY_EXPORTS="$(tr -d '\r' <"$ROUTER_YML" |
  sed -n '/^  classify:$/,/^  [a-z-]*:$/p' |
  sed -n '/^    outputs:$/,/^    [a-z]*:$/p' |
  sed -n 's/^      \([a-zA-Z0-9_-]*\):.*/\1/p')"
CLASSIFY_OK=1
[ -n "$CLASSIFY_EXPORTS" ] || { CLASSIFY_OK=0; echo "FAIL: could not read the classify job's outputs from work-router.yml" >&2; }
while read -r name; do
  [ -n "$name" ] || continue
  if ! grep -qx "$name" <<<"$CLASSIFY_EXPORTS"; then
    CLASSIFY_OK=0
    echo "FAIL: work-router.yml reads needs.classify.outputs.${name} but the classify job does not export it" >&2
  fi
done < <(grep -oE 'needs\.classify\.outputs\.[a-zA-Z0-9_-]+' "$ROUTER_YML" | sed 's/.*\.//' | sort -u)
if [ "$CLASSIFY_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

if worker_installed merge-gate; then
  # fromJson('') is a hard failure ("Error reading JToken"), and a workflow_call input arrives as
  # '' whenever the caller passes an empty expression, declared default or not. The gate must never
  # hand a raw input to fromJson; `inputs.x || '0'` reads the empty case as zero.
  if ! grep -qE "fromJson\(inputs\.[a-zA-Z0-9_]+\)" "$MERGE_GATE_WORKER_MD"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: merge-gate worker calls fromJson on a raw input; an empty caller value kills the job" >&2
    grep -nE "fromJson\(inputs\.[a-zA-Z0-9_]+\)" "$MERGE_GATE_WORKER_MD" >&2
  fi

  # The worker's own comments must keep the distinction: progress notes carry no marker,
  # failed attempts carry the attempt marker, verdicts carry the marker AND the Verdict line.
  # Three verdict sites: the review hold on the issue, the agent's assessment on the issue,
  # and conclude's short verdict on the pull request itself.
  if grep -q 'ATTEMPT_MARKER: "<!-- agent-merge-gate-attempt -->"' "$MERGE_GATE_WORKER_MD" &&
    [ "$(grep -c '\${{ env.GATE_MARKER }}' "$MERGE_GATE_WORKER_MD")" -eq 3 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: merge-gate worker must keep verdict and attempt markers distinct" >&2
  fi
fi

# add-issue-labels and remove-issue-labels split `labels` on newlines. A caller that joined two
# names with a comma removed one label called "bot-working,pr-pending": a 404 the action swallows
# on purpose, so the release never happened and Pliny-Bot #49/#54 carried implement, pr-pending
# and review together for a day. Callers use block scalars, one label per line; the actions also
# accept commas so a consumer copy of an old caller keeps working.
LABELS_OK=1
if grep -nE '^[[:space:]]+labels: [^|>].*,' "${WORKFLOWS_DIR}"/agent-*.md >&2 2>/dev/null; then
  LABELS_OK=0
  echo "FAIL: a worker passes comma-joined labels to a label action; use a block scalar, one label per line" >&2
fi
for action in add-issue-labels remove-issue-labels; do
  if ! grep -qF 'split(/\r?\n|,/)' "${HERE}/../${action}/action.yml"; then
    LABELS_OK=0
    echo "FAIL: ${action} must accept comma-separated labels as well as one per line" >&2
  fi
done
if [ "$LABELS_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

if worker_installed merge-gate; then
  # The agent's fix reaches the branch as a bundle applied fast-forward only (apply-agent-output).
  # gh-aw's push tool description tells the model to rebase, and a rebased branch cannot
  # fast-forward: the push is refused and the verdict is lost (Pliny-Bot run 33952565835). The
  # worker must start on the pull request branch and must never say `git rebase`. Its progress
  # comment is posted on the first attempt only; retries are recorded by the attempt comment.
  BRANCH_OK=1
  # Path B: staged safe outputs, applied by conclude with the App token. Without `staged: true`
  # gh-aw's safe_outputs job writes too, and it runs first: it pushed a flattened single-parent
  # commit with GITHUB_TOKEN, which lost the agent's merge, left the pull request conflicting,
  # and started no CI, because GITHUB_TOKEN writes raise no events.
  if ! grep -qE '^  staged: true' "$MERGE_GATE_WORKER_MD"; then
    BRANCH_OK=0; echo "FAIL: merge-gate safe-outputs must be staged; conclude owns the write path" >&2
  fi
  if grep -q 'git rebase' "$MERGE_GATE_WORKER_MD"; then
    BRANCH_OK=0; echo "FAIL: merge-gate worker tells the agent to rebase; the push is fast-forward only" >&2
  fi
  if ! grep -q 'name: Check out the pull request branch' "$MERGE_GATE_WORKER_MD"; then
    BRANCH_OK=0; echo "FAIL: merge-gate worker must check out the pull request branch before the agent starts" >&2
  fi
  if ! grep -qF "conclusion == 'failure' && (inputs.attempts_so_far || '0') == '0'" "$MERGE_GATE_WORKER_MD"; then
    BRANCH_OK=0; echo "FAIL: the reserve job's progress comment must be posted on the first attempt only" >&2
  fi
  # A conflicting pull request has no CI run to read logs from, so the gate is handed empty
  # failure artifacts. Read on its own that looks like "no evidence", and the agent asked for a
  # human instead of resolving the conflict that caused it.
  if ! grep -qF 'Empty failure evidence is not a reason to ask for review' "$MERGE_GATE_WORKER_MD"; then
    BRANCH_OK=0
    echo "FAIL: the gate must treat empty failure evidence on a conflicting PR as the conflict to fix" >&2
  fi
  if [ "$BRANCH_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

  # pr-pending means a pull request for this issue is open and waiting. Only merging retires it.
  # Every other path (the protected-files hold, a review verdict, a failed attempt) leaves the
  # pull request open, and stripping the label there produced a board where issues with open
  # pull requests looked like they had none. It went unnoticed while the label actions silently
  # removed nothing, so the two bugs hid each other.
  PENDING_OK=1
  grep -q '^  PR_PENDING_LABEL:' "$MERGE_GATE_WORKER_MD" ||
    { PENDING_OK=0; echo "FAIL: merge gate lost its PR_PENDING_LABEL definition" >&2; }
  if [ "$(grep -c '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD")" -ne 1 ]; then
    PENDING_OK=0
    echo "FAIL: pr-pending must be removed in exactly one place, the merge path" >&2
    grep -n '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD" >&2
  fi
  # And that one place has to be the merge outcome, not a hold or a failed attempt.
  grep -B12 '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD" | grep -q "outcome == 'merge'" ||
    { PENDING_OK=0; echo "FAIL: the only pr-pending removal must sit under the merge outcome" >&2; }
  if [ "$PENDING_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

if worker_installed implement; then
  # A provider outage kills a run in a couple of minutes with no answer, and the same issue used
  # to be handed to a human for it. The implement worker retries those and only those: a run that
  # worked for half an hour and then failed produced an answer that was wrong, and repeating it
  # costs the fleet the same half hour to be wrong again.
  IMPLEMENT_RETRY_OK=1
  for needle in 'RETRY_UNDER_MINUTES' 'ATTEMPT_MARKER' 'attempts_so_far' 'operation=implement'; do
    grep -qF "$needle" "$IMPLEMENT_WORKER_MD" || {
      IMPLEMENT_RETRY_OK=0
      echo "FAIL: implement worker lost its retry belt: no '$needle'" >&2
    }
  done
  # Park and retry are mutually exclusive: the retry path must never add the review label, and
  # the park path must never re-dispatch.
  grep -A3 'Flag for human review' "$IMPLEMENT_WORKER_MD" | grep -q "retry != 'true'" ||
    grep -B3 'Flag for human review' "$IMPLEMENT_WORKER_MD" | grep -q "retry != 'true'" || {
      IMPLEMENT_RETRY_OK=0
      echo "FAIL: the implement worker must not flag review on a run it is about to retry" >&2
    }
  if [ "$IMPLEMENT_RETRY_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

if worker_installed merge-gate; then
  # A failed attempt must not strip `implement`: identify-gate-subject refuses an issue
  # without it, so the first crash would starve every retry at the subject check.
  if grep -A6 'Park the issue' "$MERGE_GATE_WORKER_MD" | grep -q 'REVIEW_LABEL' &&
    ! grep -qF 'labels: ${{ env.WORKING_LABEL }},${{ env.IMPLEMENT_LABEL }}' "$MERGE_GATE_WORKER_MD"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: the incomplete job must keep implement and only park on an exhausted budget" >&2
  fi
fi

# This repository is public. Every route a human can start from a comment, a review or a
# label must pass the authorize gate, or anyone able to comment can start a model run that
# writes code. Asserted here because removing the gate would otherwise be a silent, one-line
# change that nothing fails on.
for route in refine implement apply-review; do
  worker_installed "$route" || continue
  if grep -qE "route == '${route}'.*needs\.authorize\.outputs\.trusted == 'true'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: route '${route}' does not require needs.authorize.outputs.trusted" >&2
  fi
done

# Triage runs under a trusted App identity. Outside collaborators are admitted only to
# the deterministic dispatcher; the worker call itself requires a trusted actor.
if worker_installed triage; then
  if grep -qE "dispatch-triage:.*" "$ROUTER_YML" && \
     grep -qE "route == 'triage'.*is_outside_collaborator == 'true'" "$ROUTER_YML" && \
     grep -qE "route == 'triage'.*trusted == 'true'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: route 'triage' does not dispatch outside collaborators and require a trusted worker actor" >&2
  fi
fi

# Every installed worker and every plumbing route has a job; a worker that is not installed
# has none, or the router would call a lock file that does not exist.
for route in "${INSTALLED_ROUTES[@]}" "${PLUMBING_ROUTES[@]}"; do
  if grep -q "route == '${route}'" "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: work-router.yml has no job for route '${route}'" >&2
  fi
done
for route in "${EXCLUDED_ROUTES[@]}"; do
  if grep -q "route == '${route}'" "$ROUTER_YML"; then
    FAIL=$((FAIL + 1))
    echo "FAIL: work-router.yml has a job for route '${route}' but agent-${route}.md is not installed" >&2
  else
    PASS=$((PASS + 1))
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

# A router job that reads pull requests has to say so. audit-close listed them with only
# contents and issues and failed nightly on a 403 that named the endpoint and nothing else.
# Paired job-to-scope rather than parsed out of each action: the jobs that touch pull
# requests are few and known, and naming them here is what makes the omission visible.
for pr_job in audit-close reconcile-bot-pr-runs detect-pr-conflicts; do
  if ! grep -q "^  ${pr_job}:$" "$ROUTER_YML"; then
    continue
  fi
  pr_scopes=$(sed -n "/^  ${pr_job}:$/,/^    steps:$/p" "$ROUTER_YML")
  if printf '%s' "$pr_scopes" | grep -qE '^      pull-requests: (read|write)$'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: router job '${pr_job}' reads pull requests but grants no pull-requests scope" >&2
  fi
done

# No written-down passwords in anything this repository ships. A throwaway credential for
# a test container is still a policy finding, and one sat in every consumer's CI for weeks
# until a scan found it rather than us. Two shapes: a password-ish name assigned a quoted
# value, and a command-line flag given one; a line containing a dollar sign is taken to be
# an expression or a shell variable and allowed. Paths resolve relative to this script, so
# upstream this reads the templates and in a consumer it reads the real workflows.
PASSWORD_SCAN_DIRS=("${WORKFLOWS_DIR}")
[ -d "${HERE}/../../templates/ci" ] && PASSWORD_SCAN_DIRS+=("${HERE}/../../templates/ci")
[ -d "${HERE}/../../templates/agentics" ] && PASSWORD_SCAN_DIRS+=("${HERE}/../../templates/agentics")
password_hits=$(
  find "${PASSWORD_SCAN_DIRS[@]}" -type f \( -name '*.yml' -o -name '*.yaml' \) \
    -not -name '*.lock.yml' -print0 |
    xargs -0 -r grep -nEi \
      -e "(password|passwd|pwd)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"']" \
      -e "(^|[[:space:]])(-P|--password)[[:space:]=]*[\"'][^\"']" |
    grep -v '[$]' || true
)
if [ -z "$password_hits" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: a password is written down in a shipped workflow; use a secret or derive it per run" >&2
  printf '%s\n' "$password_hits" >&2
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Route matrix: ${PASS} passed"
else
  echo "Route matrix: ${PASS} passed, ${FAIL} FAILED" >&2
fi

exit $((FAIL > 0))
