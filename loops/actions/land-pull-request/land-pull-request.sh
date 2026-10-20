#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/land-pull-request/land-pull-request.sh. Update with workflows update --force; consumer edits may be overwritten.
#
# Lands one approved pull request. A base branch with a merge queue gets the pull request in the
# queue, where GitHub builds it on top of what is ahead and merges it; any other base gets a squash
# merge, as before. The asynchronous merge endpoint is the one that enqueues: the older merge
# endpoint and auto-merge do not take stacked pull requests.
set -euo pipefail

: "${REPO:?}" "${PR:?}" "${HEAD_SHA:?}"
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || { echo "::error::Invalid pull request number: $PR"; exit 1; }
[[ "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "::error::Invalid head commit for #$PR: $HEAD_SHA"; exit 1; }

out() { echo "landed=$1" >> "${GITHUB_OUTPUT:-/dev/null}"; }

pr_json=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,baseRefName,headRefName,state)
state=$(jq -r .state <<<"$pr_json")
[ "$state" = OPEN ] || { echo "#$PR is $state; nothing to land."; out ""; exit 0; }
current=$(jq -r .headRefOid <<<"$pr_json")
if [ "$current" != "$HEAD_SHA" ]; then
  echo "::warning::#$PR moved from ${HEAD_SHA:0:7} to ${current:0:7} after it was judged; not landing it."
  out ""
  exit 0
fi
base=$(jq -r .baseRefName <<<"$pr_json")
head_ref=$(jq -r .headRefName <<<"$pr_json")

owner=${REPO%%/*}
name=${REPO#*/}
queue=$(gh api graphql -f query='query($o:String!,$n:String!,$b:String!){repository(owner:$o,name:$n){mergeQueue(branch:$b){id}}}' \
  -f o="$owner" -f n="$name" -f b="$base" --jq '.data.repository.mergeQueue.id // ""' 2>/dev/null || true)

if [ "${APPROVE:-false}" = true ]; then
  # A ruleset that requires an approval counts the App's. Without one this is a record of the verdict.
  gh api -X POST "repos/$REPO/pulls/$PR/reviews" -f commit_id="$HEAD_SHA" -f event=APPROVE \
    -f body="${APPROVAL_BODY:-Approved by the merge gate.}" >/dev/null ||
    echo "::warning::Could not approve #$PR; a required approval will hold it."
fi

if [ -z "$queue" ]; then
  gh pr merge "$PR" --repo "$REPO" --squash --match-head-commit "$HEAD_SHA"
  # The branch goes as well: nothing else deletes it where `delete_branch_on_merge` is off.
  gh api -X DELETE "repos/$REPO/git/refs/heads/$head_ref" >/dev/null 2>&1 || true
  echo "Merged #$PR into $base."
  out merged
  exit 0
fi

pr_id=$(gh pr view "$PR" --repo "$REPO" --json id --jq .id)
# GraphQL first: the asynchronous merge endpoint refuses a GitHub App with "Enqueuer is not
# authorized to merge" (Agentic-Workflow-Dogfood, 2026-10-20), while enqueuePullRequest takes the
# same token. A stacked pull request refuses GraphQL and only the asynchronous endpoint takes it.
enqueued=$(gh api graphql -f query='mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{state}}}' \
  -f id="$pr_id" -f sha="$HEAD_SHA" 2>&1 || true)
if grep -q '"mergeQueueEntry":{' <<<"$enqueued"; then
  echo "#$PR is in the $base merge queue; GitHub merges it once its group passes."
  out enqueued
  exit 0
fi
if ! grep -q 'part of a stack' <<<"$enqueued"; then
  echo "::error::#$PR could not be added to the $base merge queue: $(tr '\n' ' ' <<<"$enqueued" | cut -c1-400)"
  out ""
  exit 1
fi

# A stack enters the queue only through merge-async, which refuses a GitHub App there. The App lands
# it directly instead, through the ruleset's bypass list (it must be on it): every layer has passed its
# own checks and the gate, and the whole stack lands as one operation.
answer=$(gh api -X PUT "repos/$REPO/pulls/$PR/merge-async" -f merge_action=direct_merge -f merge_method=squash \
  -F bypass_rules=true -f sha="$HEAD_SHA")
status=$(jq -r .status <<<"$answer")
uuid=$(jq -r '.details.uuid // ""' <<<"$answer")
for _ in $(seq 1 12); do
  case "$status" in enqueued | merged) break ;; failed) break ;; esac
  [ -n "$uuid" ] || break
  sleep 5
  answer=$(gh api "repos/$REPO/pulls/$PR/merge-async/$uuid" 2>/dev/null || echo '{}')
  status=$(jq -r '.status // "pending"' <<<"$answer")
done

case "$status" in
  enqueued)
    echo "#$PR is in the $base merge queue; GitHub merges it once its group passes."
    out enqueued
    ;;
  merged)
    echo "#$PR merged into $base."
    out merged
    ;;
  *)
    message=$(jq -r '.details.message // ""' <<<"$answer")
    echo "::error::Stack #$PR was not merged (status '${status}'${message:+: $message}). The App lands a stack by bypassing the base branch's ruleset, so it must be on that ruleset's bypass list."
    out ""
    exit 1
    ;;
esac
