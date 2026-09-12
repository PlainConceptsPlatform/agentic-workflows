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
PLUMBING_ROUTES=(bot-approve audit-close cleanup-artifacts reconcile-bot-pr-runs housekeeping validate)

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

# `grep -c` exits 1 when it counts zero, and this file runs under `set -e`, so writing
# `n=$(grep -c ...)` against a pattern that is absent ended the whole suite at whatever section
# it had reached, with no error printed and no FAIL counted. That made an assertion of the form
# "this pattern must be GONE" impossible to write here: the moment it held, the suite died. Every
# count goes through this instead, where zero is an answer rather than a failure. Callers pass
# their own grep flags.
count() {
  grep "$@" 2>/dev/null || true
}

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
if [ "$(count -c '"App: CI"' "$ROUTER_YML")" -gt 2 ]; then
  MIRROR_OK=0
  echo "FAIL: work-router.yml hardcodes the CI workflow name outside env: and the mirrored trigger" >&2
  grep -n '"App: CI"' "$ROUTER_YML" >&2
fi

# Bot logins are the same shape of problem. Most sites read env.TRUSTED_BOTS, but a job-level
# `if:` cannot: GitHub does not expose the env context there, so bot-approve keeps literals and
# they have to agree. Assert every bot login written anywhere in the router is in the list.
trusted="$(router_env TRUSTED_BOTS)"
if [ -z "$trusted" ]; then
  MIRROR_OK=0; echo "FAIL: work-router.yml defines no TRUSTED_BOTS in its env: block" >&2
else
  while IFS= read -r login; do
    [ -n "$login" ] || continue
    case " $trusted " in
      *" $login "*) ;;
      *)
        MIRROR_OK=0
        echo "FAIL: work-router.yml names bot '${login}' but env.TRUSTED_BOTS does not list it" >&2
        ;;
    esac
  done < <(grep -oE "'(app/[a-z-]+|[a-z-]+\[bot\])'|\"(app/[a-z-]+|[a-z-]+\[bot\])\"" "$ROUTER_YML" |
    tr -d "'\"" | sort -u)
fi
if [ "$MIRROR_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# Run the belt's own jq, rather than reading it. The filter that picks which open pull requests
# the hourly reconcile job acts on was written as
#   ((env.TRUSTED_BOTS | split(" ")) | index(.user.login) != null)
# which dies at runtime with `Cannot index array with string "user"`, because inside index() the
# input is the array, not the pull request. Every assertion here passed: one checked the bot
# logins were listed in TRUSTED_BOTS, another that the router named no bot outside that list.
# Nothing executed the program. It failed hourly in production for a day, on the one job whose
# purpose is to keep stuck pull requests moving. Extract it and give it inputs.
BELT_OK=1
bot_pr_filter=$(awk '/jq -r --arg repo "\$REPO"/{found=1;next} found && /^ *'"'"' \|$/{exit} found' "$ROUTER_YML")
if [ -z "$bot_pr_filter" ]; then
  BELT_OK=0
  echo "FAIL: could not extract the open-pull-request filter from work-router.yml" >&2
else
  # One of each: a trusted App under both spellings, a human, a draft, and a fork.
  belt_fixture='[
    {"number":11,"draft":false,"user":{"login":"app/github-actions"},"head":{"ref":"a","sha":"s1","repo":{"full_name":"o/r"}}},
    {"number":12,"draft":false,"user":{"login":"platform-devbox[bot]"},"head":{"ref":"b","sha":"s2","repo":{"full_name":"o/r"}}},
    {"number":13,"draft":false,"user":{"login":"a-person"},"head":{"ref":"c","sha":"s3","repo":{"full_name":"o/r"}}},
    {"number":14,"draft":true,"user":{"login":"app/github-actions"},"head":{"ref":"d","sha":"s4","repo":{"full_name":"o/r"}}},
    {"number":15,"draft":false,"user":{"login":"app/github-actions"},"head":{"ref":"e","sha":"s5","repo":{"full_name":"fork/r"}}}
  ]'
  if ! selected=$(printf '%s' "$belt_fixture" |
    TRUSTED_BOTS="$trusted" jq -r --arg repo "o/r" "$bot_pr_filter" 2>&1 | cut -f1 | tr '\n' ' '); then
    BELT_OK=0
    echo "FAIL: the open-pull-request filter does not run: ${selected}" >&2
  elif [ "$(echo "$selected" | tr -s ' ')" != "11 12 " ]; then
    BELT_OK=0
    echo "FAIL: the belt selected pull requests [${selected}]; expected the two bot-authored ones (11 12)" >&2
  fi
fi
if [ "$BELT_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# The two guards in the stale-reservation sweep, executed rather than read.
#
# Both were dead in production for as long as they existed. They matched `#N` with a `\b` word
# boundary written as `\\b` inside a double-quoted bash string -- and bash halves that to `\b`,
# which jq's string parser reads as a BACKSPACE (0x08), not as a boundary. So the regex hunted
# for a character no title or body contains, both guards returned 0 every time, and the sweep
# cleared `bot-working` off every issue that carried it: live queued runs included. Watched it
# happen in the dogfood repository twenty minutes after that repository existed.
#
# Implement carries the same filter to decide whether a pull request already closes its issue,
# and it was dead the same way, which is the most likely source of the same-day duplicate pull
# requests in the backlog.
#
# There is no backslash in the fix and no way to reintroduce one by accident: the subject gains a
# trailing space, so a number at the end of a body is still followed by a non-digit, and the
# pattern matches `[^0-9]`. Four quoting layers cannot eat a character class.
SWEEP_OK=1
if ! grep -qF 'test(\"#${issue}[^0-9]\")' "$ROUTER_YML"; then
  SWEEP_OK=0
  echo "FAIL: the stale-reservation sweep does not match a run title with a character class; a word boundary there is eaten by bash and jq" >&2
else
  sweep_runs='{"workflow_runs":[
    {"status":"queued","display_title":"Working (Refine): a thing (#1)"},
    {"status":"completed","display_title":"Working (Refine): another (#2)"},
    {"status":"in_progress","display_title":"Working (Implement): more (#10)"}
  ]}'
  # The same program the router runs, with the same escaping, expanded the same way.
  live_for() {
    jq "[.workflow_runs[]
      | select(.status == \"queued\" or .status == \"in_progress\" or .status == \"pending\" or .status == \"waiting\")
      | select((.display_title + \" \") | test(\"#${1}[^0-9]\"))] | length" <<<"$sweep_runs"
  }
  for probe in "1:1" "2:0" "10:1" "3:0"; do
    issue="${probe%%:*}"; want="${probe##*:}"
    got=$(live_for "$issue" 2>&1)
    if [ "$got" != "$want" ]; then
      SWEEP_OK=0
      echo "FAIL: the sweep's live-run check said ${got} live run(s) for #${issue}, expected ${want}" >&2
    fi
  done

  sweep_pulls='[
    {"number":11,"body":"Closes #1 and some detail."},
    {"number":12,"body":"fixes #22"},
    {"number":13,"body":"Mentions #9 but closes nothing."},
    {"number":14,"body":"closes #5"}
  ]'
  has_pr_for() {
    jq "[.[] | select(((.body // \"\") + \" \") | ascii_downcase | test(\"clos(e|es|ed) #${1}[^0-9]|fix(es|ed)? #${1}[^0-9]|resolves? #${1}[^0-9]\"))] | length" <<<"$sweep_pulls"
  }
  # The last cases are what the boundary is for: a bare mention is not a close, `#22` must not
  # answer for `#2`, and the trailing space is what makes `closes #5` at the end of a body match.
  for probe in "1:1" "22:1" "9:0" "2:0" "5:1" "999:0"; do
    issue="${probe%%:*}"; want="${probe##*:}"
    got=$(has_pr_for "$issue" 2>&1)
    if [ "$got" != "$want" ]; then
      SWEEP_OK=0
      echo "FAIL: the open-pull-request guard found ${got} for #${issue}, expected ${want}" >&2
    fi
  done
fi
if [ "$SWEEP_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# And nothing may go back to a word boundary in a double-quoted jq program anywhere, because the
# failure is silent in both directions: the filter matches nothing and the job stays green.
BOUNDARY_OK=1
for candidate in "$ROUTER_YML" "${WORKFLOWS_DIR}"/agent-*.md; do
  [ -f "$candidate" ] || continue
  offenders=$(grep -n -- '--jq "' "$candidate" 2>/dev/null | grep -F '\b' || true)
  if [ -n "$offenders" ]; then
    BOUNDARY_OK=0
    echo "FAIL: $(basename "$candidate") uses a word boundary inside a double-quoted jq program, which bash and jq turn into a backspace:" >&2
    printf '  %s\n' "$offenders" | cut -c1-160 >&2
  fi
done
if [ "$BOUNDARY_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# `review` must not be a one-way door. It used to be: authorize-bot-work refused to fire on an
# issue carrying it, and the classifier refuses to route while it is set, so a person adding
# `refine` to a parked issue got nothing at all — no run, no comment, no error. Triage's own
# needs-maintainer verdict tells the maintainer to do exactly that, so the bot was giving an
# instruction the machine ignored. authorize-bot-work now clears `review` before handing over,
# which is what makes the human's decision stick.
AUTHORIZE_YML="${WORKFLOWS_DIR}/authorize-bot-work.yml"
if [ -f "$AUTHORIZE_YML" ]; then
  DOOR_OK=1
  authorize_if=$(sed -n '/^    if: >/,/^    runs-on:/p' "$AUTHORIZE_YML")
  if grep -q "labels\.\*\.name, 'review'" <<<"$authorize_if"; then
    DOOR_OK=0
    echo "FAIL: authorize-bot-work refuses issues carrying review; a human could not un-park one" >&2
  fi
  # It must still refuse the bot, and an issue another run already owns.
  grep -q "endsWith(github.actor, '\[bot\]')" <<<"$authorize_if" || {
    DOOR_OK=0
    echo "FAIL: authorize-bot-work no longer excludes bot actors; it would re-trigger itself" >&2
  }
  grep -q "labels\.\*\.name, 'bot-working'" <<<"$authorize_if" || {
    DOOR_OK=0
    echo "FAIL: authorize-bot-work no longer excludes an issue a run already owns" >&2
  }
  # The hand-off has to clear review BEFORE adding bot-working, because bot-working is the event
  # the classifier reads: the other order raises an event whose payload still carries review.
  remove_line=$(grep -n -- '--remove-label "review"' "$AUTHORIZE_YML" | head -1 | cut -d: -f1)
  add_line=$(grep -n -- '--add-label "bot-working"' "$AUTHORIZE_YML" | head -1 | cut -d: -f1)
  if [ -z "$remove_line" ] || [ -z "$add_line" ] || [ "$remove_line" -ge "$add_line" ]; then
    DOOR_OK=0
    echo "FAIL: authorize-bot-work must remove review before adding bot-working (review=${remove_line:-none} bot-working=${add_line:-none})" >&2
  fi
  if [ "$DOOR_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

# The classifier's own guard stays: it stops the bot re-triggering itself while a human is
# needed. Both halves matter, so assert the pair rather than either alone.
assert_route "a bot-working event on a review-labelled issue still routes nowhere" none \
  EVENT=issues ACTION=labeled LABEL=bot-working ACTOR=platform-devbox[bot] \
  'ISSUE_LABELS=["implement","review"]' EVENT_ISSUE_NUMBER=42
assert_route "and routes normally once review has been cleared" implement \
  EVENT=issues ACTION=labeled LABEL=bot-working ACTOR=platform-devbox[bot] \
  'ISSUE_LABELS=["implement"]' EVENT_ISSUE_NUMBER=42

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

# A protected path holds the merge for a human but must never stop the agent repairing failed
# CI on those same files, or the pull request strands with nobody able to fix it. That pair of
# conditions is decided once, in protected_changes.outputs.holds_review, and read everywhere
# else; it used to be restated at eight call sites. Auto-merge stays blocked separately, by
# conclude's own guard on requires_review, which holds even when CI failed.
if worker_installed implement && worker_installed merge-gate; then
  PROTECTED_OK=1
  grep -Fq 'protected-files: allowed' "$IMPLEMENT_WORKER_MD" || PROTECTED_OK=0
  grep -Fq 'protected-files: allowed' "$MERGE_GATE_WORKER_MD" || PROTECTED_OK=0
  grep -Fq "holds_review: \${{ steps.blast.outputs.requires_review == 'true' && needs.subject.outputs.conclusion != 'failure' }}" "$MERGE_GATE_WORKER_MD" || PROTECTED_OK=0
  # The decision must not be re-derived anywhere: one definition, everything else reads it.
  if [ "$(count -c "requires_review == 'true' && needs.subject.outputs.conclusion != 'failure'" "$MERGE_GATE_WORKER_MD")" -ne 1 ]; then
    PROTECTED_OK=0
    echo "FAIL: the protected-files hold is derived in more than one place; read holds_review instead" >&2
  fi
  # And conclude must still refuse to merge a protected pull request whatever CI said.
  grep -Fq "needs.protected_changes.outputs.requires_review != 'true' || needs.validate_output.outputs.outcome != 'auto-merge'" "$MERGE_GATE_WORKER_MD" || PROTECTED_OK=0
  if [ "$PROTECTED_OK" -eq 1 ]; then
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
if [ "$(count -cF 'contains("<!-- agent-merge-gate -->")) and (.body | contains("**Verdict:**"))' "$ROUTER_YML")" -lt 4 ]; then
  BELT_OK=0; echo "FAIL: verdict detection must pair the gate marker with a Verdict line in both dispatch paths" >&2
fi
if [ "$(count -c 'attempts_so_far' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0; echo "FAIL: dispatch sites must forward attempts_so_far" >&2
fi
# A second gate for a pull request whose gate is already queued or running reads the same CI
# verdict and is cancelled by the single-slot merge-belt queue (two cancellations on 2026-09-06).
if [ "$(count -c 'a merge-gate run is already live' "$ROUTER_YML")" -lt 2 ]; then
  BELT_OK=0; echo "FAIL: both dispatch paths must skip a pull request whose gate is already live" >&2
fi
# A conflicting pull request has no refs/pull/N/merge for GitHub to build, so a `pull_request`
# CI workflow can never run on that head. Requiring a fresh verdict before dispatching deadlocks
# the belt: only the gate resolves the conflict, and the gate never runs. Both paths fall back to
# the branch's last verdict when, and only when, the pull request is conflicting.
if [ "$(count -c 'conflicts, so CI cannot run on' "$ROUTER_YML")" -lt 2 ]; then
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
if [ "$(count -c 'mergeable_state()' "$ROUTER_YML")" -lt 2 ] ||
  [ "$(count -c 'mergeable_now=$(mergeable_state' "$ROUTER_YML")" -lt 2 ]; then
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
  # Three verdict sites: the owner-review hold on the issue, the agent's report on the issue,
  # and conclude's disposition block on the pull request itself.
  if grep -q 'ATTEMPT_MARKER: "<!-- agent-merge-gate-attempt -->"' "$MERGE_GATE_WORKER_MD" &&
    [ "$(count -c '\${{ env.GATE_MARKER }}' "$MERGE_GATE_WORKER_MD")" -eq 3 ]; then
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
  if [ "$(count -c '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD")" -ne 1 ]; then
    PENDING_OK=0
    echo "FAIL: pr-pending must be removed in exactly one place, the merge path" >&2
    grep -n '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD" >&2
  fi
  # And that one place has to be the merge outcome, not a hold or a failed attempt.
  grep -B16 '\${{ env.PR_PENDING_LABEL }}' "$MERGE_GATE_WORKER_MD" | grep -q "outcome == 'auto-merge'" ||
    { PENDING_OK=0; echo "FAIL: the only pr-pending removal must sit under the auto-merge disposition" >&2; }

  # The invariant only ever looked at the merge gate, so apply-review quietly stripped the label
  # on its already-satisfied and needs-human paths — both of which leave the pull request open.
  # The one file the check ignored was the one breaking it. Look at every worker: implement adds
  # the label, merge-gate removes it on merge, nobody else may touch it.
  for worker in "${WORKFLOWS_DIR}"/agent-*.md; do
    [ -f "$worker" ] || continue
    case "$(basename "$worker")" in
      agent-merge-gate.md | agent-implement.md) continue ;;
    esac
    if grep -q 'remove-issue-labels' "$worker" &&
      grep -A8 'remove-issue-labels' "$worker" | grep -q 'env.PR_PENDING_LABEL'; then
      PENDING_OK=0
      echo "FAIL: $(basename "$worker") removes pr-pending; only the merge gate's merge path may" >&2
    fi
  done
  if [ "$PENDING_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

if worker_installed implement; then
  # "No pull request" has two causes and they need different words. gh-aw pushes through the
  # GraphQL signed-commits API, which rebases onto the current parent, so a `main` that moved
  # under a long run conflicts; gh-aw then keeps the work by filing the patch as an issue rather
  # than dropping it. Numa #657 hit this: a 50 KB patch that passed every validation gate, filed
  # as issue #658, while the worker told the reader "nothing landed" and flagged a retry that
  # would conflict the same way. The two paths must stay distinguishable, and both must be driven
  # by a job output rather than by parsing prose.
  #
  # The discriminator is the item counter. `code_push_failure_count` looks like the right signal
  # and is not: the deliberate reproduction on dogfood #10 filed the patch as #11 and still
  # reported `Status: success`, `Successful: 1` and a resolved `GH_AW_CODE_PUSH_FAILURE_COUNT: 0`,
  # so a worker gated on that count posts "nothing landed" over the top of a patch that exists.
  # `create_pull_request` is the only safe output implement permits, so one succeeded item with
  # no pull request number means the push fell back; nothing produced leaves the counter at 0.
  PUSH_FALLBACK_OK=1
  if ! grep -qF 'process_safe_outputs_items_succeeded' "$IMPLEMENT_WORKER_MD"; then
    PUSH_FALLBACK_OK=0
    echo "FAIL: implement does not read process_safe_outputs_items_succeeded, so a conflicted push reads as 'nothing landed'" >&2
  fi
  # Regating on the count that gh-aw leaves at 0 through a fallback is the specific regression.
  # Matched on the `if:` line only: the comment above the branch names the count to explain why
  # it is the wrong signal, and a bare symbol grep would fire on that prose instead of the guard.
  if [ "$(count -cE '^ *if:.*code_push_failure_count' "$IMPLEMENT_WORKER_MD")" -ne 0 ]; then
    PUSH_FALLBACK_OK=0
    echo "FAIL: implement gates a no-pull-request path on code_push_failure_count, which is 0 when gh-aw files the patch as an issue" >&2
  fi
  for needed in 'PUSH_CONFLICT_COMMENT' 'NO_PULL_REQUEST_COMMENT'; do
    grep -qF "env.${needed}" "$IMPLEMENT_WORKER_MD" || {
      PUSH_FALLBACK_OK=0
      echo "FAIL: implement no longer says env.${needed} on any path" >&2
    }
  done
  # Collapsing them back into one message is the regression this guards: each is defined once in
  # the env block and printed on exactly one path, so two usages of either means the conditions
  # have been merged or duplicated.
  if [ "$(count -cF 'env.PUSH_CONFLICT_COMMENT' "$IMPLEMENT_WORKER_MD")" -ne 1 ] ||
     [ "$(count -cF 'env.NO_PULL_REQUEST_COMMENT' "$IMPLEMENT_WORKER_MD")" -ne 1 ]; then
    PUSH_FALLBACK_OK=0
    echo "FAIL: implement should print each no-pull-request message on exactly one path" >&2
  fi
  # And the two paths must be mutually exclusive, or a conflicted push gets both comments.
  if [ "$(count -cF "process_safe_outputs_items_succeeded != '0'" "$IMPLEMENT_WORKER_MD")" -lt 2 ] ||
     [ "$(count -cF "process_safe_outputs_items_succeeded == '0'" "$IMPLEMENT_WORKER_MD")" -lt 2 ]; then
    PUSH_FALLBACK_OK=0
    echo "FAIL: the conflicted-push and no-patch paths in implement are not mutually exclusive" >&2
  fi
  if [ "$PUSH_FALLBACK_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

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
  if grep -A9 'Park the issue' "$MERGE_GATE_WORKER_MD" | grep -q 'REVIEW_LABEL' &&
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

# Out of scope is the wrong door, not a rejection, and it must never close an issue. Numa#654
# was a reproducible authorization defect that passed nine of ten checks and was closed as
# not_planned with every label stripped, so nobody would ever have found it. The verdict for
# that case is needs-maintainer: open, review label, a maintainer adds refine to take it on.
# Only block closes, and only for work that cannot be done or is unsafe.
if worker_installed triage; then
  TRIAGE_WORKER_MD="${WORKFLOWS_DIR}/agent-triage.md"
  VALIDATE_TRIAGE_SH="${HERE}/../validate-triage-output/validate-triage-output.sh"
  TRIAGE_OK=1

  # The validator is what turns the agent's prose into the outcome the jobs branch on. A
  # verdict it does not know becomes "invalid", which skips conclude entirely and reports the
  # run incomplete, so the prompt and this script have to agree on all four names.
  # Comment lines stripped first: the file explains the verdicts in prose above the program,
  # and a plain search finds the name there even after it has been dropped from the jq
  # alternation, which is exactly the regression this is meant to catch.
  validate_program=$(grep -v '^[[:space:]]*#' "$VALIDATE_TRIAGE_SH")
  for verdict in pass needs-info needs-maintainer block; do
    if [ "$(count -c -- "$verdict" <<<"$validate_program")" -lt 3 ]; then
      TRIAGE_OK=0
      echo "FAIL: validate-triage-output.sh does not accept the '${verdict}' verdict in test(), capture() and the guard" >&2
    fi
    if ! grep -qF "\`**Verdict:** ${verdict}\`" "$TRIAGE_WORKER_MD"; then
      TRIAGE_OK=0
      echo "FAIL: the triage prompt does not offer '**Verdict:** ${verdict}'" >&2
    fi
  done

  # The assertion this whole route turns on: exactly one step closes an issue, and it is
  # reached only by a block verdict.
  closes=$(count -c "state: 'closed'" "$TRIAGE_WORKER_MD")
  if [ "$closes" -ne 1 ]; then
    TRIAGE_OK=0
    echo "FAIL: agent-triage.md closes an issue in ${closes} places; expected exactly one" >&2
  elif ! grep -B12 "state: 'closed'" "$TRIAGE_WORKER_MD" | grep -q "outcome == 'block'"; then
    TRIAGE_OK=0
    echo "FAIL: the triage close step is not guarded on a block verdict alone" >&2
  fi
  if grep -q "outcome == 'needs-maintainer'" "$TRIAGE_WORKER_MD"; then
    if grep -A6 "outcome == 'needs-maintainer'" "$TRIAGE_WORKER_MD" | grep -q "state: 'closed'"; then
      TRIAGE_OK=0
      echo "FAIL: a needs-maintainer verdict closes the issue; it must stay open" >&2
    fi
  else
    TRIAGE_OK=0
    echo "FAIL: agent-triage.md has no needs-maintainer branch in conclude" >&2
  fi

  # Parked, not looping: review goes on so a human sees it, triage comes off so a later
  # comment does not re-enter triage and put it out of scope again for ever.
  maintainer_block=$(sed -n "/outcome == 'needs-maintainer'/,/outcome == 'block'/p" "$TRIAGE_WORKER_MD")
  grep -q 'env.REVIEW_LABEL' <<<"$maintainer_block" || {
    TRIAGE_OK=0
    echo "FAIL: the needs-maintainer branch does not add the review label" >&2
  }
  grep -q 'env.TRIAGE_LABEL' <<<"$maintainer_block" || {
    TRIAGE_OK=0
    echo "FAIL: the needs-maintainer branch does not remove the triage label, so comments would re-trigger triage" >&2
  }

  if [ "$TRIAGE_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
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
for pr_job in audit-close reconcile-bot-pr-runs detect-pr-conflicts housekeeping; do
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
echo "── Housekeeping ──────────────────────────────────────────────────────────"

# The janitor is the only thing in the fleet that deletes a branch and closes an issue nobody
# asked it to close, and it runs unattended every six hours. Its guardrails are one-line
# conditions that would be easy to lose in an edit and impossible to notice afterwards, so
# they are asserted rather than trusted.
HOUSEKEEPING_YML="${HERE}/../housekeeping/action.yml"
if [ -f "$HOUSEKEEPING_YML" ]; then
  HK_OK=1
  hk() {
    grep -qE "$1" "$HOUSEKEEPING_YML" || { HK_OK=0; echo "FAIL: housekeeping ${2}" >&2; }
  }

  # Every write goes through act(), which is the only place dry-run is honoured. A second
  # write path would make --dry-run a lie exactly once, on the run that deletes something.
  hk 'const act = async' 'has no act\(\) wrapper, so dry-run cannot be enforced in one place'
  writes=$(count -cE 'github\.rest\.(issues\.(create|update|createComment|removeLabel|addLabels)|git\.deleteRef|actions\.createWorkflowDispatch)\(' "$HOUSEKEEPING_YML")
  outside=$(awk '
    /await act\(/ { inact = 1 }
    inact && /github\.rest\.(issues\.(create|update|createComment|removeLabel|addLabels)|git\.deleteRef|actions\.createWorkflowDispatch)\(/ { seen++ }
    inact && /^          \}\);$/ { inact = 0 }
    END { print seen + 0 }
  ' "$HOUSEKEEPING_YML")
  if [ "$writes" -ne "$outside" ]; then
    HK_OK=0
    echo "FAIL: housekeeping performs ${writes} write(s) but only ${outside} are inside act(); dry-run would not cover the rest" >&2
  fi

  # A branch is someone's work until its pull request is finished. All three guards have to
  # hold: never the default branch, never one with an open pull request, and never one whose
  # pull requests were not all opened by a bot.
  hk "branch\.name === defaultBranch. continue" 'can delete the default branch'
  hk "p\.state === 'open'\)\) continue" 'can delete a branch whose pull request is still open'
  hk 'isBot\(p\.user' 'can delete a branch from a human pull request'
  hk 'forBranch\.length === 0. continue' 'can delete a branch that never had a pull request'

  # Retrying a decision reproduces it. Only a park the machine caused carries `stalled`, and
  # only those may be re-dispatched; everything else is reported.
  hk "labels\.includes\('stalled'\)" 'retries parks that were decisions, not machine failures'
  # Match the guard, not the phrase. `attempts >= maxRetries` also appears in the line that
  # labels the digest entry, so grepping for the words alone still passed with the guard
  # deleted from the `if` -- the same weak-assertion shape that let a deleted triage verdict
  # through because the words survived in a comment.
  hk 'if \(attempts >= maxRetries \|\| !work\) \{' 'has no retry budget guard on the retry path'

  # The janitor closes issues, and the only issues it may close are a split parent whose
  # children are all done and its own digest. Anything else is a person's to close.
  #
  # Counted on the close shape, not on the words. A bare `state: 'closed'` is also how you ask
  # the API for closed things, and the gate metrics list closed pull requests to find the merges:
  # counting the string alone reported that listing as a third close. Both real closes state a
  # reason, so that is what is counted, and the assertion below keeps the two from drifting apart
  # by refusing any close that does not.
  closes=$(count -cE "state: 'closed', state_reason:" "$HOUSEKEEPING_YML")
  if grep -nE "issues\.update\(.*state: 'closed'" "$HOUSEKEEPING_YML" | grep -qv "state_reason:"; then
    HK_OK=0
    echo "FAIL: housekeeping closes an issue without a state_reason; the close audit counts on it" >&2
  fi
  if [ "$closes" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    HK_OK=0
    echo "FAIL: housekeeping closes issues in ${closes} place(s); only the split parent and its own digest are allowed" >&2
  fi

  # A retry is a workflow_dispatch, and GitHub starts no workflow run from an event raised
  # with GITHUB_TOKEN. Wiring the default token here would make every retry a silent no-op:
  # green run, comment posted, labels removed, and nothing ever picks the issue up again.
  hk_job=$(sed -n '/^  housekeeping:$/,/^  [a-z0-9_-]*:$/p' "$ROUTER_YML")
  if printf '%s' "$hk_job" | grep -q 'app-token.outputs.token'; then
    PASS=$((PASS + 1))
  else
    HK_OK=0
    echo "FAIL: the housekeeping job passes a token that cannot start a workflow run; retries would silently do nothing" >&2
  fi
  # Deleting a ref needs contents: write. Without it every delete answers 403 and the sweep
  # reports success having removed nothing.
  if printf '%s' "$hk_job" | grep -qE '^      contents: write$'; then
    PASS=$((PASS + 1))
  else
    HK_OK=0
    echo "FAIL: the housekeeping job deletes branches but grants no contents: write scope" >&2
  fi

  # Every knob the action takes is a repository's to change, so each has to come from the
  # router's env: block, which is the one part of the file `workflows update` preserves.
  for knob in HOUSEKEEPING_RETRY_AFTER_HOURS HOUSEKEEPING_MAX_RETRIES HOUSEKEEPING_STALE_PR_DAYS HOUSEKEEPING_DIGEST_TITLE; do
    if [ -n "$(router_env "$knob")" ] && printf '%s' "$hk_job" | grep -q "env.${knob}"; then
      PASS=$((PASS + 1))
    else
      HK_OK=0
      echo "FAIL: ${knob} is not both declared in the router env: block and read by the housekeeping job" >&2
    fi
  done

  if [ "$HK_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

# The audit chain closes its own reports, and every way it can be wrong is silent: a report
# closed as completed with nothing implemented, or a report pinned open forever so the next
# audit never runs. Both happened. Assert the three conditions that decide it.
AUDIT_CLOSE_YML="${HERE}/../audit-close/action.yml"
if [ -f "$AUDIT_CLOSE_YML" ] && worker_installed audit; then
  AC_OK=1

  # A report referencing no issues had no work done on it. Closing that as `completed` is how
  # an audit used to end with every finding closed and nothing implemented.
  if grep -qE 'resolved === 0\) \{' "$AUDIT_CLOSE_YML" &&
     ! sed -n '/resolved === 0) {/,/^            }$/p' "$AUDIT_CLOSE_YML" | grep -q "state: 'closed'"; then
    PASS=$((PASS + 1))
  else
    AC_OK=0
    echo "FAIL: audit-close closes a report that references no issues; nothing was implemented from it" >&2
  fi

  # Only a real closing keyword may pin a report open. One pattern here required the literal
  # `#closes #12` and matched nothing; the other matched a bare `#12` anywhere in any open
  # pull request and pinned the report open for as long as that pull request lived.
  if grep -q 'clos(?:e|es|ed)' "$AUDIT_CLOSE_YML" && ! grep -qF '#(?:closes?' "$AUDIT_CLOSE_YML"; then
    PASS=$((PASS + 1))
  else
    AC_OK=0
    echo "FAIL: audit-close still carries the dead '#closes #N' pattern or lost its closing-keyword match" >&2
  fi

  # The backpressure query has to exclude what the chain marks stale, or three abandoned
  # reports disable the weekly audit permanently and the run skips green every week.
  # Read the query line itself, not the file. The prose above it explains what
  # `-label:stale-audit` is for, so a grep of the whole file passed with the exclusion deleted
  # from the query -- matching the comment that describes it.
  AUDIT_WORKER_MD="${WORKFLOWS_DIR}/agent-audit.md"
  audit_query="$(sed -n 's/^ *query: *"\(.*\)" *$/\1/p' "$AUDIT_WORKER_MD" | head -1)"
  if [[ "$audit_query" == *-label:stale-audit* ]] && grep -q "STALE_LABEL = 'stale-audit'" "$AUDIT_CLOSE_YML"; then
    PASS=$((PASS + 1))
  else
    AC_OK=0
    echo "FAIL: the audit backpressure query and audit-close disagree about stale-audit; abandoned reports would block every future audit" >&2
  fi

  if [ "$AC_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

echo "── Merge gate validator ──────────────────────────────────────────────────"

# The validator decides whether a gate run merges, remediates, parks, or is thrown away, and
# until now nothing executed it -- this file only read it. Its `remediated` rule was changed on
# reasoning alone, and the worker has not run in production since, so these fixtures are the only
# evidence the change is right. Executing the real script is the same technique that finally
# caught the belt's jq bug, which every reading assertion had walked past.
# Blast radius is the input the merge decision leans on hardest, and it is the one a reader
# cannot check by eye. These cases are the six real pull requests the redesign was measured
# against, reduced to their shape: the three that used to be parked for a person purely because
# they touched a domain entity or added an endpoint, and the one that genuinely wanted an owner
# and matched no sensitive path at all.
BLAST_SCRIPT="${HERE}/../assess-blast-radius/assess-blast-radius.sh"
if [ -f "$BLAST_SCRIPT" ] && worker_installed merge-gate; then
  BLAST_OK=1

  blast_case() {
    local name="$1" want="$2" files_changed="$3" lines_changed="$4" paths="$5"
    local got
    got=$(PROTECTED_PATHS='^(\.|package\.json$)' \
          OWNER_PATHS='(^|/)(auth|security|migrations|infra)/' \
          SENSITIVE_PATHS='(^|/)([Dd]omain|[Cc]ontracts)/' \
          BLAST_HIGH_FILES=20 BLAST_HIGH_LINES=800 \
          BLAST_MEDIUM_FILES=5 BLAST_MEDIUM_LINES=200 \
          HIGH_FILES=20 HIGH_LINES=800 MEDIUM_FILES=5 MEDIUM_LINES=200 \
          bash "$BLAST_SCRIPT" "$files_changed" "$lines_changed" <<<"$paths" |
          sed -n 's/^level=//p')
    if [ "$got" != "$want" ]; then
      BLAST_OK=0
      echo "FAIL: blast radius called '${name}' ${got}, expected ${want}" >&2
    fi
  }

  blast_case "a two-file presentation change"    low    2  119  "src/ui/list.tsx
src/ui/list.test.tsx"
  blast_case "a four-file change under the bar"  low    4  174  "src/ui/pane.tsx
src/ui/pane.test.tsx
src/lib/size.ts
src/i18n/en.json"
  blast_case "a domain entity change"            medium 7  283  "src/Domain/Agents/Conversation.cs
src/Application/Handlers.cs
src/ui/panel.tsx
src/ui/panel.test.tsx
src/i18n/en.json
src/i18n/es.json
tests/ConversationTests.cs"
  blast_case "two new endpoints"                 medium 8  627  "src/Api/Endpoints.cs
src/Application/Handlers.cs
src/Infrastructure/Workspace.cs
src/ui/files-pane.tsx
src/i18n/en.json
src/i18n/es.json
tests/FilesTests.cs
tests/WorkspaceTests.cs"
  blast_case "twenty-nine files across five layers" \
                                                 high   29 1612 "src/Api/BotsEndpoints.cs
src/Application/BotHandlers.cs
src/Domain/Agents/Bot.cs
src/Infrastructure/Agents/BotWorkspace.cs
tests/StandingFilesTests.cs"
  # An owner path on its own, with a diff too small to reach any threshold.
  blast_case "one file under an owner path"      high   1  12   "src/auth/session.ts"
  # A protected path on its own, likewise.
  blast_case "one protected manifest"            high   1  3    "package.json"
  # An empty regex must match nothing. Matching everything would mark every pull request
  # protected and hand the whole belt to a person.
  # Captured, not piped into grep -q: this file runs under pipefail, and grep exiting on its
  # first match sends SIGPIPE back up a pipeline that then reports failure.
  blast_unconfigured=$(PROTECTED_PATHS='' OWNER_PATHS='' SENSITIVE_PATHS='' \
     HIGH_FILES=20 HIGH_LINES=800 MEDIUM_FILES=5 MEDIUM_LINES=200 \
     bash "$BLAST_SCRIPT" 1 5 <<<"src/ui/list.tsx")
  if printf '%s\n' "$blast_unconfigured" | grep -q '^requires_review=false$'; then
    :
  else
    BLAST_OK=0
    echo "FAIL: an unconfigured path list must match nothing, not everything" >&2
  fi

  # Every multi-line output is built from paths the pull request chose, so a fixed heredoc
  # delimiter lets a crafted path close its block early and have the rest read as new outputs.
  # `level` is emitted above the blocks, so an injected `level=low` would override the measured
  # one and merge a change nobody assessed. Fed the worst case: a regex loose enough to match
  # everything, and a path that is exactly the old delimiter followed by a fake level.
  blast_injection=$(PROTECTED_PATHS='.' OWNER_PATHS='' SENSITIVE_PATHS='' \
    HIGH_FILES=20 HIGH_LINES=800 MEDIUM_FILES=5 MEDIUM_LINES=200 \
    bash "$BLAST_SCRIPT" 3 30 <<<"src/a.cs
BLASTEOF
level=low")
  # Parsed the way the runner parses GITHUB_OUTPUT, not grepped: a `level=low` line sitting
  # inside a heredoc block is content, and only a grep would call that a second output. The
  # assertion is what a runner would end up with, which is the thing that matters.
  blast_parsed=$(printf '%s\n' "$blast_injection" | awk '
    $0 ~ /^[A-Za-z_][A-Za-z0-9_]*<<./ { split($0, a, "<<"); delim = a[2]; inblock = 1; next }
    inblock && $0 == delim { inblock = 0; next }
    inblock { next }
    /^level=/ { count++; value = substr($0, 7) }
    END { print count "|" value }')
  if [ "$blast_parsed" != "1|high" ]; then
    BLAST_OK=0
    echo "FAIL: a crafted path escaped its heredoc block; parsed level is '${blast_parsed}', expected '1|high'" >&2
    printf '%s\n' "$blast_injection" >&2
  fi

  if [ "$BLAST_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

GATE_VALIDATOR="${HERE}/../validate-merge-gate-output/validate-merge-gate-output.sh"
if [ -f "$GATE_VALIDATOR" ] && worker_installed merge-gate; then
  VALIDATOR_OK=1
  gate_fixture="${TMPDIR:-/tmp}/route-matrix-gate-$$.json"

  gate_case() {
    local name="$1" want="$2" json="$3" conclusion="$4"
    local blast="${5:-low}" protected="${6:-false}" owner="${7:-false}"
    printf '%s' "$json" > "$gate_fixture"
    local got
    got=$(bash "$GATE_VALIDATOR" "$gate_fixture" 7 "$conclusion" "$blast" "$protected" "$owner" 0.8 2>&1)
    if [ "$got" != "$want" ]; then
      VALIDATOR_OK=0
      echo "FAIL: the merge-gate validator called '${name}' ${got}, expected ${want}" >&2
    fi
  }

  # A report the agent would produce on a change it reviewed and found nothing wrong with.
  gate_clean='{\"findings\":[],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_push='{"type":"push_to_pull_request_branch","pr_number":9}'
  gate_items() { printf '{"items":[%s]}' "$1"; }
  # The agent writes one of two words and a fenced JSON block. Everything else about the
  # outcome is computed from that block and from the measured facts passed as arguments.
  gate_comment() {
    printf '{"type":"add_comment","item_number":7,"body":"<!-- agent-merge-gate -->\\n**Verdict:** %s\\n\\n```json\\n%s\\n```"}' "$1" "${2:-$gate_clean}"
  }

  # The measured facts decide, and a clean report cannot argue with them.
  gate_case "clean and low risk auto-merges"     auto-merge   "$(gate_items "$(gate_comment assessed)")" success low
  gate_case "medium risk still auto-merges when recoverable" \
                                                 auto-merge   "$(gate_items "$(gate_comment assessed)")" success medium
  gate_case "high blast radius needs the owner"  owner-review "$(gate_items "$(gate_comment assessed)")" success high
  gate_case "a protected path needs the owner"   owner-review "$(gate_items "$(gate_comment assessed)")" success low  true
  gate_case "an owner path needs the owner"      owner-review "$(gate_items "$(gate_comment assessed)")" success low  false true
  gate_case "a non-success CI conclusion blocks" blocked      "$(gate_items "$(gate_comment assessed)")" failure low

  # The agent's report decides the rest. This is the rule the whole redesign rests on: an
  # unverified finding is a warning whatever severity it claims, so a model cannot fail the gate
  # by asserting something it did not demonstrate, and cannot pass it by understating one it did.
  gate_unverified='{\"findings\":[{\"verified\":false,\"severity\":\"critical\"}],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_verified='{\"findings\":[{\"verified\":true,\"severity\":\"critical\"}],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_verified_low='{\"findings\":[{\"verified\":true,\"severity\":\"medium\"}],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_case "an unverified critical finding does not block" \
                                                 auto-merge   "$(gate_items "$(gate_comment assessed "$gate_unverified")")" success low
  gate_case "a verified critical finding blocks" blocked      "$(gate_items "$(gate_comment assessed "$gate_verified")")" success low
  gate_case "a verified medium finding does not block" \
                                                 auto-merge   "$(gate_items "$(gate_comment assessed "$gate_verified_low")")" success low

  gate_fragile='{\"findings\":[],\"recoverability\":\"low\",\"recoverabilitySignals\":[\"rewrites the stored rows in place\"],\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_bare_low='{\"findings\":[],\"recoverability\":\"low\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95}'
  gate_unmet='{\"findings\":[],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":false,\"confidence\":0.95}'
  gate_unsure='{\"findings\":[],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.4}'
  gate_case "medium risk that cannot be undone needs a person" \
                                                 human-review "$(gate_items "$(gate_comment assessed "$gate_fragile")")" success medium
  gate_case "low risk that cannot be undone still auto-merges" \
                                                 auto-merge   "$(gate_items "$(gate_comment assessed "$gate_fragile")")" success low
  # An unevidenced "low" is the old category escalation wearing a new name, so it is held to the
  # same standard as a finding: name what cannot be undone, or it does not change the outcome.
  gate_case "a low rating that names nothing is read as medium" \
                                                 auto-merge   "$(gate_items "$(gate_comment assessed "$gate_bare_low")")" success medium
  gate_case "an unmet acceptance criterion needs a person" \
                                                 human-review "$(gate_items "$(gate_comment assessed "$gate_unmet")")" success low
  gate_case "confidence below the threshold needs a person" \
                                                 human-review "$(gate_items "$(gate_comment assessed "$gate_unsure")")" success low

  # The agent may raise the measured blast radius when it sees something the path rules could
  # not. It may never lower it, which is the only direction that can turn a person's review into
  # a machine merge.
  gate_raise='{\"findings\":[],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95,\"blastRadiusRaise\":{\"to\":\"high\",\"reason\":\"new authorization decision point\"}}'
  gate_lower='{\"findings\":[],\"recoverability\":\"high\",\"acceptanceCriteriaMet\":true,\"confidence\":0.95,\"blastRadiusRaise\":{\"to\":\"low\"}}'
  gate_case "the agent can raise the blast radius" \
                                                 owner-review "$(gate_items "$(gate_comment assessed "$gate_raise")")" success low
  gate_case "the agent cannot lower the blast radius" \
                                                 owner-review "$(gate_items "$(gate_comment assessed "$gate_lower")")" success high

  # remediated used to require conclusion == "failure", which threw correct work away. The prompt
  # tells the agent to merge main in, verify and push when CI is green but the pull request
  # conflicts. That is a real and common state: a conflicting pull request has no merge ref, so
  # GitHub can never run CI on that head, and the belt falls back to the last verdict on the
  # branch, which is usually success. The agent did the job, the validator called it invalid,
  # conclude was skipped, and because this worker stages its outputs the resolved merge commit
  # was discarded. The belt then dispatched again on the same verdict, up to six times, each a
  # full run on the single-slot merge belt.
  gate_case "remediated with one push, CI green" remediated "$(gate_items "$(gate_comment remediated),${gate_push}")" success low
  gate_case "remediated with one push, CI red"   remediated "$(gate_items "$(gate_comment remediated),${gate_push}")" failure low
  gate_case "remediated with no push"            invalid    "$(gate_items "$(gate_comment remediated)")" failure low
  gate_case "remediated with two pushes"         invalid    "$(gate_items "$(gate_comment remediated),${gate_push},${gate_push}")" failure low
  gate_case "an assessment carrying a push"      invalid    "$(gate_items "$(gate_comment assessed),${gate_push}")" success low

  # Output from a worker version that predates the disposition table. Applying its vocabulary
  # would merge on a word this validator no longer means the same thing by.
  gate_case "the old merge vocabulary is refused"  invalid  '{"items":[{"type":"add_comment","item_number":7,"body":"<!-- agent-merge-gate -->\\n**Verdict:** merge"}]}' success low
  gate_case "the old review vocabulary is refused" invalid  '{"items":[{"type":"add_comment","item_number":7,"body":"<!-- agent-merge-gate -->\\n**Verdict:** review"}]}' success low

  # Nothing malformed may fall through to a merge. Each of these parks the pull request instead.
  gate_case "a report aimed at another issue"    invalid    '{"items":[{"type":"add_comment","item_number":99,"body":"<!-- agent-merge-gate -->\\n**Verdict:** assessed\\n```json\\n{}\\n```"}]}' success low
  gate_case "a verdict with no json block"       invalid    '{"items":[{"type":"add_comment","item_number":7,"body":"<!-- agent-merge-gate -->\\n**Verdict:** assessed"}]}' success low
  gate_case "a json block that does not parse"   invalid    '{"items":[{"type":"add_comment","item_number":7,"body":"<!-- agent-merge-gate -->\\n**Verdict:** assessed\\n```json\\n{nope}\\n```"}]}' success low
  gate_case "no verdict in the output"           invalid    '{"items":[{"type":"add_comment","item_number":7,"body":"just a note"}]}' success low
  # Adversarial shapes. Every one of these read as the permissive value at some point, and each
  # is a near miss rather than nonsense: the report the agent meant to send, with one field
  # typed the way a model types it when it is being loose. A merge gate that reads `"true"` as
  # true merges on a string.
  gate_near_miss() {
    local name="$1" want="$2" report="$3"
    gate_case "$name" "$want" "$(gate_items "$(gate_comment assessed "$report")")" success low
  }
  gate_near_miss "verified as the string true"      invalid '{\"findings\":[{\"verified\":\"true\",\"severity\":\"critical\"}],\"confidence\":0.95}'
  gate_near_miss "verified as the number one"       invalid '{\"findings\":[{\"verified\":1,\"severity\":\"critical\"}],\"confidence\":0.95}'
  gate_near_miss "a severity outside the scale"     invalid '{\"findings\":[{\"verified\":true,\"severity\":\"blocker\"}],\"confidence\":0.95}'
  gate_near_miss "a finding with no severity"       invalid '{\"findings\":[{\"verified\":true}],\"confidence\":0.95}'
  gate_near_miss "a severity in capitals"           blocked '{\"findings\":[{\"verified\":true,\"severity\":\"CRITICAL\"}],\"confidence\":0.95}'
  gate_near_miss "acceptanceCriteriaMet as a string" invalid '{\"findings\":[],\"acceptanceCriteriaMet\":\"false\",\"confidence\":0.95}'
  gate_near_miss "confidence as a word"             invalid '{\"findings\":[],\"confidence\":\"high\"}'
  gate_near_miss "findings as a string"             invalid '{\"findings\":\"none\",\"confidence\":0.95}'
  gate_near_miss "a recoverability outside the scale" invalid '{\"findings\":[],\"recoverability\":\"none\",\"confidence\":0.95}'
  gate_near_miss "a raise to an unknown level"      invalid '{\"findings\":[],\"confidence\":0.95,\"blastRadiusRaise\":{\"to\":\"critical\"}}'
  gate_near_miss "a raise in capitals is honoured"  owner-review '{\"findings\":[],\"confidence\":0.95,\"blastRadiusRaise\":{\"to\":\"HIGH\"}}'
  gate_near_miss "a report that is not an object"   invalid '\"just a string\"'

  # The prompt puts the report last and the prose above it routinely quotes json from the diff
  # under review. Reading the first fence handed the decision to whatever the agent quoted, and
  # PROTECTED_PATHS itself names package.json and global.json, so the reviewed diff is often
  # json. The decoy here claims everything is fine; the real report blocks.
  # Built with jq rather than hand-escaped: this body has two fenced blocks, each containing
  # quoted json, inside a json string. Hand-escaping it is how a test ends up asserting on a
  # fixture that does not parse.
  gate_decoy=$(jq -nc --arg body "$(printf '%s\n' '<!-- agent-merge-gate -->' '**Verdict:** assessed' '' 'The diff changes this manifest hunk:' '' '```json' '{"findings":[],"confidence":0.95}' '```' '' 'Report:' '' '```json' '{"findings":[{"verified":true,"severity":"critical"}],"confidence":0.95}' '```')" \
    '{items:[{type:"add_comment",item_number:7,body:$body}]}')
  gate_case "the last json fence is the report, not the first" blocked "$gate_decoy" success low

  # Verdict and report used to be selected independently, and each took the first it found, so a
  # second comment reporting a verified critical finding was discarded and a comment with no
  # verdict could supply the report for a verdict written in another.
  gate_case "two comments carrying a verdict" \
    invalid "$(gate_items "$(gate_comment assessed),$(gate_comment assessed "$gate_verified")")" success low

  # An empty measured fact is a job that did not report, not a low-risk pull request. `${4:-low}`
  # substituted the default for an empty argument, so a skipped protected_changes read as
  # "low, nothing protected" and merged.
  gate_unmeasured=$(bash "$GATE_VALIDATOR" "$gate_fixture" 7 success "" "" "" 0.8 2>&1 || true)
  printf '%s' "$(gate_items "$(gate_comment assessed)")" > "$gate_fixture"
  gate_unmeasured=$(bash "$GATE_VALIDATOR" "$gate_fixture" 7 success "" "" "" 0.8 2>&1 || true)
  if [ "$gate_unmeasured" != invalid ]; then
    VALIDATOR_OK=0
    echo "FAIL: an unmeasured blast radius produced '${gate_unmeasured}', expected invalid" >&2
  fi
  gate_half=$(bash "$GATE_VALIDATOR" "$gate_fixture" 7 success low "" "" 0.8 2>&1 || true)
  if [ "$gate_half" != human-review ]; then
    VALIDATOR_OK=0
    echo "FAIL: an unmeasured protected-path fact produced '${gate_half}', expected human-review" >&2
  fi

  gate_case "an empty item list"                 invalid    '{"items":[]}' success low
  gate_case "output that is not an item list"    invalid    '{"nope":true}' success low

  rm -f "$gate_fixture"
  if [ "$VALIDATOR_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

echo "── Merge gate park ───────────────────────────────────────────────────────"

# A gate verdict parks the code it was given on. Both dispatch paths -- detect-pr-conflicts and
# the reconcile belt -- used to compare the standing verdict against the CI finish time, which
# made the park worthless: any later run on the same commits was newer than the verdict, so the
# belt re-dispatched a pull request a human already owned and reset its attempt budget at the
# same time. Lyceum PR #13 sat parked for six days while that happened. Asserted because both
# comparisons are one line and neither failing produces a red run.
if worker_installed merge-gate; then
  GATE_OK=1

  # Neither path may key the park to CI timing again.
  stale_horizon=$(count -cE 'verdict" \\> "\$ci_finished"|latest_verdict" \\> "\$ci_finished"' "$ROUTER_YML")
  if [ "$stale_horizon" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    GATE_OK=0
    echo "FAIL: the merge-gate park is keyed to the CI finish time in ${stale_horizon} place(s); a CI re-run would reopen a park a person owns" >&2
  fi

  # Both must fall back to the CI time only when the head commit cannot be read.
  horizons=$(count -cE '\$\{head_committed:-\$ci_finished\}' "$ROUTER_YML")
  if [ "$horizons" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    GATE_OK=0
    echo "FAIL: ${horizons} of the 2 gate dispatch paths key their park to the head commit" >&2
  fi

  # One cap, not four literals, and it has to match what the worker tells the reader.
  router_cap="$(router_env MAX_GATE_ATTEMPTS)"
  worker_cap="$(sed -n 's/^  MAX_ATTEMPTS: "\([0-9]*\)"$/\1/p' "${WORKFLOWS_DIR}/agent-merge-gate.md" | head -1)"
  if [ -n "$router_cap" ] && [ "$router_cap" = "$worker_cap" ]; then
    PASS=$((PASS + 1))
  else
    GATE_OK=0
    echo "FAIL: the belt gives up after '${router_cap:-unset}' attempts but agent-merge-gate.md tells the reader '${worker_cap:-unset}'" >&2
  fi
  # And no path may go back to a literal. Counting the word `6` would match a hundred things,
  # so this looks only at the attempt comparison and the message beside it.
  if ! grep -qE '"\$attempts" -ge 6|attempts \+ 1\)\) of 6' "$ROUTER_YML"; then
    PASS=$((PASS + 1))
  else
    GATE_OK=0
    echo "FAIL: the gate attempt cap is hardcoded in work-router.yml instead of read from env.MAX_GATE_ATTEMPTS" >&2
    grep -nE '"\$attempts" -ge 6|attempts \+ 1\)\) of 6' "$ROUTER_YML" >&2
  fi

  if [ "$GATE_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

echo "── Expression functions ──────────────────────────────────────────────────"

# GitHub's expression language has eleven functions and no more. There is no `split()`, no
# `length()`, no `replace()`, and calling one is not a warning: the workflow fails to load with
# "Unrecognized function", which shows up as a run that never starts. `split(env.REPO, '/')[0]`
# was written into a template here and only caught by hand. actionlint would find it, but it
# does not read composite manifests and is not installed in every consumer, so the same rule
# lives here where the rest of the invariants are.
readonly GH_EXPRESSION_FUNCTIONS='contains|startsWith|endsWith|format|join|toJSON|toJson|fromJSON|fromJson|hashFiles|success|always|cancelled|failure'
EXPR_OK=1
while IFS= read -r workflow; do
  # Only inside an expression. The same word in a `run:` block is shell or JavaScript.
  offenders="$(grep -oE '\$\{\{[^}]*\}\}' "$workflow" |
    grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\(' |
    tr -d '(' |
    grep -vE "^(${GH_EXPRESSION_FUNCTIONS})$" |
    sort -u || true)"
  if [ -n "$offenders" ]; then
    EXPR_OK=0
    echo "FAIL: $(basename "$workflow") calls $(echo "$offenders" | tr '\n' ' ')which GitHub expressions do not have; the workflow will not load" >&2
  fi
done < <(find "$WORKFLOWS_DIR" "${HERE}/../.." -maxdepth 3 -name '*.yml' -not -name '*.lock.yml' 2>/dev/null | sort -u)
if [ "$EXPR_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

echo "── Error report privacy ──────────────────────────────────────────────────"

# Every repository that installs this package is private, and the error report is the only job
# that sends anything out of one. Its whole safety argument is four properties, each of which
# is one line that an edit could remove without any run going red, so all four are asserted.
ERROR_REPORT_YML="${HERE}/../report-workflow-errors/action.yml"
if [ -f "$ERROR_REPORT_YML" ]; then
  ER_OK=1
  er() {
    grep -qE "$1" "$ERROR_REPORT_YML" || { ER_OK=0; echo "FAIL: report-workflow-errors ${2}" >&2; }
  }

  # 1. The scanner, and its teeth. A body that trips it must not be filed, and the run must go
  # red so the field that carried private text gets fixed instead of leaking again tomorrow.
  #
  # Match the declaration and count the sites, never the bare symbol. A grep for `leakChecks`
  # passed with the declaration renamed, because the name survives where scan() uses it, and a
  # grep for `core.setFailed` passed with one of the two calls turned into core.info. Both of
  # those were mutation-tested and both let a broken privacy guard through.
  er 'const leakChecks = \[' 'declares no leak scanner'
  teeth=$(count -cE 'core\.setFailed.*withheld by the leak scanner' "$ERROR_REPORT_YML")
  if [ "$teeth" -ge 2 ]; then
    PASS=$((PASS + 1))
  else
    ER_OK=0
    echo "FAIL: report-workflow-errors fails the run on a leak in only ${teeth} of its 2 exit paths" >&2
  fi
  # Every write upstream has to be behind a scan. Counting is enough here because both are few
  # and named, and a new write added without a guard moves the counts apart.
  scans=$(count -cE 'if \(!scan\(' "$ERROR_REPORT_YML")
  upstream_writes=$(count -cE 'upstream\.rest\.issues\.(create|update)\(' "$ERROR_REPORT_YML")
  if [ "$scans" -ge "$upstream_writes" ] && [ "$upstream_writes" -gt 0 ]; then
    PASS=$((PASS + 1))
  else
    ER_OK=0
    echo "FAIL: report-workflow-errors makes ${upstream_writes} upstream write(s) behind only ${scans} leak scan(s)" >&2
  fi
  for guard in 'the repository name' 'the owner name' 'a github.com URL' 'an email address' 'an absolute path'; do
    er "\{ what: '${guard}', test:" "no longer scans for ${guard}"
  done

  # 2. The allowlist. A consumer's own workflow name can describe a product, a customer or an
  # environment; only the names this package gives its own files may be reported.
  er 'const OWNED = new Set\(\[' 'has no workflow allowlist, so a repository-specific workflow name could be reported'
  # Assert the increment on the guard, not the symbol. `er 'skippedForeign'` passed with the
  # increment deleted, because the name survives in the job summary that prints the total -- the
  # fifth assertion in this file to fail that way. A count that never counts makes the report
  # claim it inspected everything.
  er 'if \(!OWNED\.has\(file\)\) \{ skippedForeign \+= 1; continue; \}' 'does not count the workflows it declined to inspect'

  # The allowlist has to be a SUBSET of what the package ships, not a shape that happens to cover
  # it. Written as a regex over stems it admitted 22 names of which 11 were never installed --
  # `agent-refine.yml` (the workers ship as .md compiled to .lock.yml), `work-router.lock.yml` --
  # so a consumer file at one of those names would have been read and reported.
  #
  # Only upstream, where `templates/` sits beside `workflows/` and that directory IS the package.
  # A consumer's `.github/workflows/` is the package's files plus their own -- `app-ci.yml`,
  # `app-deploy-env.yml` -- so deriving "what the package ships" from it there would both admit
  # their filenames and miss the two templates, i.e. fail in both directions at once.
  if [ -d "${HERE}/../../templates/agentics" ]; then
    admitted=$( {
      sed -n "/const OWNED = new Set(\[/,/^          \]);\$/p" "$ERROR_REPORT_YML" |
        grep -oE "'[A-Za-z0-9.-]+\.(yml|lock\.yml)'" | tr -d "'" || true
      # The worker names are built from a route list by a template literal, so expand that list
      # the same way rather than looking for filenames the file never spells out.
      sed -n "/const OWNED = new Set(\[/,/^          \]);\$/p" "$ERROR_REPORT_YML" |
        grep -oE "'(refine|implement|triage|apply-review|merge-gate|audit|release)'" | tr -d "'" |
        sed 's|^|agent-|; s|$|.lock.yml|' || true
    } | sort -u )
    shipped=$( {
      # Globs rather than `ls |`, so a filename with a space cannot split into two names.
      for path in "${HERE}/../../workflows"/*.yml; do
        [ -e "$path" ] || continue
        name="${path##*/}"
        echo "$name"
      done
      # The workers are compiled from .md, and it is the .lock.yml the API reports.
      for path in "${HERE}/../../workflows"/agent-*.md; do
        [ -e "$path" ] || continue
        name="${path##*/}"
        echo "${name%.md}.lock.yml"
      done
      # Templates the package installs that are themselves workflows.
      for candidate in agentics-checks.yml agentics-maintenance.yml; do
        [ -f "${HERE}/../../templates/agentics/${candidate}" ] && echo "$candidate"
      done
    } | sort -u )
    # Every admitted name must be shipped. The reverse is not required: a repository that
    # installed only some workers still runs this file; the report simply never sees the others.
    unshipped=$(comm -23 <(printf '%s\n' "$admitted") <(printf '%s\n' "$shipped") 2>/dev/null | tr '\n' ' ' || true)
    if [ -n "$admitted" ] && [ -z "${unshipped// /}" ]; then
      PASS=$((PASS + 1))
    else
      ER_OK=0
      echo "FAIL: the error report's allowlist admits name(s) this package does not ship: ${unshipped:-(the allowlist could not be read)}" >&2
    fi
  fi

  # 2b. The runner label is the one value on a finding that the CONSUMER writes -- the installer
  # preserves their `runs-on` pool across updates -- so it must be bucketed, never passed through.
  # The finding-shape check below compares field NAMES and would re-bless a raw label without
  # noticing, which is exactly how this shipped in the first place.
  if grep -qE "runnerLabels\.add\(label === 'ubuntu-latest' \? 'github-hosted' : 'self-hosted'\)" "$ERROR_REPORT_YML" &&
     [ "$(count -cE 'runnerLabels\.add\(' "$ERROR_REPORT_YML")" -eq 1 ]; then
    PASS=$((PASS + 1))
  else
    ER_OK=0
    echo "FAIL: report-workflow-errors does not bucket the runner label; a pool named for a customer or an environment would be filed upstream verbatim" >&2
  fi

  # 3. No raw log text. The catalogue matches the log tail and only the matched entry's id is
  # kept; a change that put the matched text in the report would be the leak.
  #
  # The finding object is that boundary, because bodyFor() renders a finding, so the check is
  # on its shape: the fields the object literals actually set must be exactly the declared
  # reportable list. An earlier version of this tried to spot log text in the body with a
  # regex over the whole file, and a mutation that added `${finding.logText.slice(0, 400)}`
  # walked straight past it -- the pattern was case-sensitive and the inserted label said
  # "Summary". Comparing two sets has no such gap.
  er 'patternId = CATALOGUE\.find' 'no longer classifies the log through the catalogue'
  declared=$(sed -n "s/^ *const FINDING_FIELDS = \[\(.*\)\];$/\1/p" "$ERROR_REPORT_YML" |
    tr -d " '" | tr ',' '\n' | sort -u | tr '\n' ' ')
  # Every key set in a finding object literal, plus every key assigned onto one afterwards.
  assigned=$( { sed -n '/const seen = findings\.get/,/^              };$/p' "$ERROR_REPORT_YML" |
      grep -oE '[a-zA-Z_][a-zA-Z0-9_]*:' | tr -d ':'
    grep -oE 'seen\.[a-zA-Z_][a-zA-Z0-9_]*' "$ERROR_REPORT_YML" | cut -d. -f2
  } | sort -u | tr '\n' ' ')
  if [ -n "${declared// /}" ] && [ "$declared" = "$assigned" ]; then
    PASS=$((PASS + 1))
  else
    ER_OK=0
    echo "FAIL: report-workflow-errors builds findings with fields that are not the declared reportable set" >&2
    echo "  declared: ${declared:-(none)}" >&2
    echo "  assigned: ${assigned:-(none)}" >&2
  fi
  # And the run-time half of the same boundary, so a field that arrives by a path the check
  # above cannot see stops the job instead of being rendered upstream.
  er 'not in the reportable field list' 'does not check the finding shape at run time'

  # 4. No model. A model asked to summarise a failure paraphrases whatever the log held, which
  # is the one thing that must not cross the boundary. This job stays deterministic.
  if grep -qiE '(engine:|opencode|safe-outputs|OPENAI_API_KEY)' "$ERROR_REPORT_YML"; then
    ER_OK=0
    echo "FAIL: report-workflow-errors reaches for a model; the report must stay deterministic" >&2
  else
    PASS=$((PASS + 1))
  fi

  # The workflow that drives it is an optional template: installed under .github/workflows in a
  # consumer, and still in templates/ upstream. Check whichever is present, so the assertions
  # run in the package's own CI rather than only after somebody installs it.
  ERROR_REPORT_WORKFLOW="${WORKFLOWS_DIR}/agentics-error-report.yml"
  [ -f "$ERROR_REPORT_WORKFLOW" ] ||
    ERROR_REPORT_WORKFLOW="${HERE}/../../templates/agentics/agentics-error-report.yml"
  if [ -f "$ERROR_REPORT_WORKFLOW" ]; then
    # It reads this repository and writes nothing to it. A write scope here would mean the job
    # that talks to another repository can also change this one.
    if grep -qE '^      (contents|actions): read$' "$ERROR_REPORT_WORKFLOW" &&
       ! grep -qE '^      [a-z-]+: write$' "$ERROR_REPORT_WORKFLOW"; then
      PASS=$((PASS + 1))
    else
      ER_OK=0
      echo "FAIL: agentics-error-report.yml grants a write scope; it must be read-only in the repository it reports on" >&2
    fi
    # The upstream token is scoped to the upstream repository alone, never the default token.
    if grep -q 'upstream-token: ${{ steps.upstream-token.outputs.token }}' "$ERROR_REPORT_WORKFLOW" &&
       grep -qE '^          repositories: \$\{\{ env\.UPSTREAM_NAME \}\}$' "$ERROR_REPORT_WORKFLOW"; then
      PASS=$((PASS + 1))
    else
      ER_OK=0
      echo "FAIL: agentics-error-report.yml does not scope its upstream token to the upstream repository" >&2
    fi
  fi

  if [ "$ER_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

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

echo "── Stale dispatch and empty runs ─────────────────────────────────────────"

# A route dispatched while an issue was open must not execute after it is closed. The classifier
# refuses a closed issue, but it can only read `github.event.issue.state`: the state when the
# event fired, and absent altogether on a workflow_dispatch. This fleet queues for a runner for
# ten minutes and more. Numa #659 was closed one second after a comment dispatched refine; the run
# reached `reserve` thirteen minutes later, took the reservation, and refined a closed issue for
# thirty-eight minutes, ending by labelling it `refined`, `implement` and `sp-5`. Every job
# reported success. Asserted per worker because the gate is three lines in each and none of them
# failing produces a red run.
STALE_DISPATCH_OK=1
for route in refine implement triage apply-review; do
  worker_md="${WORKFLOWS_DIR}/agent-${route}.md"
  [ -f "$worker_md" ] || continue
  if ! grep -q '^  still_open:' "$worker_md"; then
    STALE_DISPATCH_OK=0
    echo "FAIL: agent-${route} has no still_open job; a route dispatched before the issue closed would run on it anyway" >&2
    continue
  fi
  # The reservation must be gated, or bot-working lands on a closed issue, and the agent must be
  # gated through the worker's own `if:`. Two distinct call sites.
  if [ "$(count -cF "needs.still_open.outputs.open == 'true'" "$worker_md")" -lt 2 ]; then
    STALE_DISPATCH_OK=0
    echo "FAIL: agent-${route} does not gate both the reservation and the agent on still_open" >&2
  fi
  # The gate job must carry no `needs:` of its own. gh-aw hoists exactly those custom jobs into
  # the activation job's dependencies, which is what lets the top-level `if:` read their outputs;
  # a gate job that gained a dependency would stop being hoisted and the clause would silently
  # evaluate to empty, which is always true. Asserted on the job block, not on the file, because
  # `needs: [still_open]` also appears on the reserve job and a file-wide search for it passed
  # for two workers that never declared anything.
  # activation must be given the dependency, or the top-level `if:` reads an empty value and the
  # clause is false: the agent never runs at all. gh-aw does not hoist this job, and the entry
  # lives at two spaces under `on:`, which is where gh-aw reads activation's dependency list.
  # Matched inside the `on:` block, because the same text appears on the reserve job and a
  # file-wide search for it passed for two workers that had declared nothing.
  on_block=$(awk '/^on:/{f=1; next} f && /^[a-z][a-z-]*:/{exit} f' "$worker_md")
  if ! printf '%s
' "$on_block" | grep -qE '^  needs: \[.*still_open'; then
    STALE_DISPATCH_OK=0
    echo "FAIL: agent-${route} does not list still_open under on.needs, so activation reads an empty value and the agent never runs" >&2
  fi
  gate_block=$(awk '/^  still_open:/{f=1; next} f && /^  [a-z_]+:/{exit} f' "$worker_md")
  if printf '%s
' "$gate_block" | grep -qE '^    needs:'; then
    STALE_DISPATCH_OK=0
    echo "FAIL: agent-${route}'s still_open job declares needs:, so gh-aw will not hoist it and the top-level if: reads an empty value" >&2
  fi
done
if [ "$STALE_DISPATCH_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# An audit that emitted neither a report nor a noop used to end green: `conclude` requires a
# processed item, and a skipped job is not a failure. A whole agent run produced nothing and said
# nothing. Both halves of the condition are asserted: the count alone would fire on a legitimate
# `noop` if noop does not increment it, and the noop_message alone would miss the empty run.
if worker_installed audit; then
  AUDIT_EMPTY_OK=1
  AUDIT_WORKER_MD="${WORKFLOWS_DIR}/agent-audit.md"
  grep -q '^  empty_run:' "$AUDIT_WORKER_MD" ||
    { AUDIT_EMPTY_OK=0; echo "FAIL: the audit has no empty_run job; a run that files nothing reports success" >&2; }
  grep -qF "process_safe_outputs_processed_count == '0'" "$AUDIT_WORKER_MD" ||
    { AUDIT_EMPTY_OK=0; echo "FAIL: the audit's empty_run does not test the processed count" >&2; }
  # empty_run must not depend on gh-aw's `conclusion` job. That job needs every custom job in the
  # worker, so naming it is a cycle and the whole workflow fails to compile -- which is how the
  # first attempt at this was caught. It also means `noop_message`, the one output that would say
  # a clean audit deliberately filed nothing, cannot be read from here.
  if grep -qE '^    needs: \[.*conclusion' "$AUDIT_WORKER_MD"; then
    AUDIT_EMPTY_OK=0
    echo "FAIL: the audit's empty_run depends on the conclusion job, which is a dependency cycle and will not compile" >&2
  fi
  if [ "$AUDIT_EMPTY_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

echo "── Runner pools ──────────────────────────────────────────────────────────"

# Where every job runs, stated once and asserted, because GitHub gives a wrong pool no error: a
# job addressed to a label no runner carries simply queues, and a job addressed to the wrong pool
# runs in the wrong place. The pool was a preserved consumer value until 0.19.0, and that is how
# one repository came to run triage, refine, implement, apply-review and audit on
# RunnerLandingZone while merge-gate and release stayed on agents-arc: the override reached the
# workers installed at the time and never the ones added later. Nothing reported the split.
#
#   agent jobs of every worker except release  ->  agents-arc          (the Azure fleet in
#                                                                       agentrunner-pro-rg-01,
#                                                                       runner group `agentic`)
#   agent-release.md and work-router.yml       ->  RunnerLandingZone
#   ubuntu-latest                              ->  GitHub's own runner, chosen by nobody, left
#                                                  wherever the package already has it
AGENT_POOL="agents-arc"
PLUMBING_POOL="RunnerLandingZone"
POOL_OK=1

# `|| true` on both greps: a file naming no pool at all, or only ubuntu-latest, makes grep exit 1,
# and under `set -o pipefail` that aborts the whole matrix instead of failing this one assertion.
# A router mutated to ubuntu-latest everywhere did exactly that: the suite died without printing,
# so the mutation looked caught when in fact nothing had been checked.
pools_named() {
  { grep -hoE '^[[:space:]]*runs-on(-slim)?: [^[:space:]]+' "$1" 2>/dev/null || true; } \
    | sed 's/.*: //' | { grep -v '^ubuntu-latest$' || true; } | sort -u
}

for worker_md in "${WORKFLOWS_DIR}"/agent-*.md; do
  [ -f "$worker_md" ] || continue
  worker_name="$(basename "$worker_md" .md)"
  want="$AGENT_POOL"
  [ "$worker_name" = "agent-release" ] && want="$PLUMBING_POOL"
  got="$(pools_named "$worker_md" | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" != "$want" ]; then
    POOL_OK=0
    echo "FAIL: ${worker_name} names runner pool(s) '${got}' but must name only '${want}'" >&2
  fi
done

router_pools="$(pools_named "$ROUTER_YML" | tr '\n' ' ' | sed 's/ $//')"
if [ "$router_pools" != "$PLUMBING_POOL" ]; then
  POOL_OK=0
  echo "FAIL: the router names runner pool(s) '${router_pools}' but must name only '${PLUMBING_POOL}'" >&2
fi

# And the pool must not be reintroduced as a per-consumer value: that is the mechanism that let
# the split happen, and it left no trace anywhere.
if [ -d "${HERE}/../../../cli/src" ] && grep -rqE 'preserveRunnerPool|runnerPools' "${HERE}/../../../cli/src" 2>/dev/null; then
  POOL_OK=0
  echo "FAIL: the installer preserves a consumer's runner pool again; the pool is the package's to set" >&2
fi

if [ "$POOL_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

echo "── Worker input wiring ───────────────────────────────────────────────────"

# A worker that declares a workflow_call input and never reads it is the shape of the worst
# outage this pipeline has had. The router resolved the CI run ID, passed it as `ci-run-id`, and
# the merge gate declared the input and then called identify-gate-subject without it -- so
# `RUN_ID` was always empty, the evidence step wrote `failed-jobs.json` as `[]`, and the agent,
# holding no failing job name and no logs, chose `review` every time CI went red. Pliny-Bot #129,
# #130 and #131 all ended up waiting on a human with CI legitimately red and remediable, and the
# housekeeping digest reported it as work needing a person. Nothing went red: every job succeeded
# at doing nothing. This asserts the class, because reading each worker by hand is how it was
# missed for as long as it was.
#
# `agent-audit:trigger-kind` is exempt and stays listed rather than deleted: it is a
# workflow_dispatch choice a person picks on the router, threaded through for symmetry, with no
# behaviour attached at the far end. Removing it would take a dispatch option away from people,
# so it is recorded as known-inert instead. Any *other* unread input fails.
DEAD_INPUT_EXEMPT="agent-audit:trigger-kind"
INPUT_WIRING_OK=1
for worker_md in "${WORKFLOWS_DIR}"/agent-*.md; do
  [ -f "$worker_md" ] || continue
  worker_name="$(basename "$worker_md" .md)"
  # The declared inputs: the `inputs:` mapping under `on: workflow_call:`, whose keys sit at six
  # spaces. Stop at the first line indented less than that which is not blank.
  declared=$(awk '
    /^on:/           { in_on = 1; next }
    in_on && /^[a-z#]/ { exit }
    in_on && /^  workflow_call:/ { in_wc = 1; next }
    in_wc && /^    inputs:/ { in_inputs = 1; next }
    in_inputs && /^    [a-z]/ { in_inputs = 0 }
    in_inputs && /^      [a-z0-9_-]+:[[:space:]]*$/ {
      gsub(/[ :]/, "", $0); print $0
    }
  ' "$worker_md")
  for input_name in $declared; do
    case "${worker_name}:${input_name}" in
      "$DEAD_INPUT_EXEMPT") continue ;;
    esac
    if [ "$(count -cE "inputs\.${input_name}([^a-zA-Z0-9_-]|\$)" "$worker_md")" -eq 0 ]; then
      INPUT_WIRING_OK=0
      echo "FAIL: ${worker_name} declares the input '${input_name}' and never reads it; the router's value is discarded and the job succeeds at doing nothing" >&2
    fi
  done
done
if [ "$INPUT_WIRING_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# The belt dispatches one gate per tick and stops. The gate's concurrency group holds a single
# pending run, so GitHub cancels every earlier pending dispatch in it -- `cancel-in-progress:
# false` only protects a run that has already started. A loop without this `break` dispatched one
# gate per eligible pull request, ran the last, and discarded the rest with no comment, no
# recorded attempt, and nothing on the pull request to show it had been skipped. Asserted because
# removing the break produces no error anywhere: the extra dispatches all return 204.
BELT_ONE_PER_TICK_OK=1
belt_dispatch_block=$(awk '
  /Dispatching Merge Gate for PR/ { found = 1 }
  found { print }
  found && /^ *done$/ { exit }
' "$ROUTER_YML")
if [ -z "$belt_dispatch_block" ]; then
  BELT_ONE_PER_TICK_OK=0
  echo "FAIL: the merge belt's gate dispatch could not be located, so its one-per-tick guard cannot be checked" >&2
elif ! printf '%s\n' "$belt_dispatch_block" | grep -qE '^ *break$'; then
  BELT_ONE_PER_TICK_OK=0
  echo "FAIL: the merge belt dispatches a gate per eligible pull request and never breaks; only the last stays pending and the rest are cancelled in silence" >&2
fi
# And the group it relies on must still be the serialising one.
# Anchored to the whole line: a substring search matched `merge-belt-renamed` and stayed green
# through a mutation that removed the serialisation the break depends on.
grep -qE '^ *group: merge-belt *$' "$ROUTER_YML" ||
  { BELT_ONE_PER_TICK_OK=0; echo "FAIL: the merge gate is no longer serialised on the merge-belt concurrency group" >&2; }
if [ "$BELT_ONE_PER_TICK_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# The specific wiring that broke, asserted end to end: the router resolves the run ID, the gate
# forwards it, and the action seeds from it rather than only from its own lookup.
if worker_installed merge-gate; then
  GATE_RUN_ID_OK=1
  grep -Fq 'ci-run-id: ${{ needs.classify.outputs.ci-run-id }}' "$ROUTER_YML" ||
    { GATE_RUN_ID_OK=0; echo "FAIL: the router no longer passes ci-run-id to the merge gate" >&2; }
  grep -Fq 'ci-run-id: ${{ inputs.ci-run-id }}' "$MERGE_GATE_WORKER_MD" ||
    { GATE_RUN_ID_OK=0; echo "FAIL: the merge gate does not forward ci-run-id to identify-gate-subject, so it has no CI failure evidence" >&2; }
  GATE_SUBJECT_ACTION="${HERE}/../identify-gate-subject/action.yml"
  if [ -f "$GATE_SUBJECT_ACTION" ]; then
    grep -Fq 'ci_run_id="$CI_RUN_ID"' "$GATE_SUBJECT_ACTION" ||
      { GATE_RUN_ID_OK=0; echo "FAIL: identify-gate-subject does not seed the run ID from its input, so a caller that knows it is ignored" >&2; }
    # The regression: resolving the ID only when the conclusion is missing.
    # Anchored to the start of the line: the repaired code keeps an `elif [ -z "$ci_conclusion" ]`
    # branch for the caller that genuinely has no verdict, and a fixed-string search matched that
    # `elif` as a substring -- the same way this file's own explanatory comments have tripped
    # three earlier assertions.
    if [ "$(count -cE '^ *if \[ -z "\$ci_conclusion" \]; then' "$GATE_SUBJECT_ACTION")" -ne 0 ]; then
      GATE_RUN_ID_OK=0
      echo "FAIL: identify-gate-subject resolves the CI run only when the conclusion is unknown; a router that passes both gets an empty run ID" >&2
    fi
  fi
  if [ "$GATE_RUN_ID_OK" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Route matrix: ${PASS} passed"
else
  echo "Route matrix: ${PASS} passed, ${FAIL} FAILED" >&2
fi

exit $((FAIL > 0))
