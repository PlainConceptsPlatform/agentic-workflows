#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/apply-agent-bundle/apply-bundle.sh. Update with `workflows update --force`; consumer edits may be overwritten.
set -euo pipefail

BUNDLE_FILE=$1
TARGET_BRANCH=$2
BASE_BRANCH=${3:-}

fail() {
  echo "::error::$1"
  exit 1
}

[ -f "$BUNDLE_FILE" ] || fail "Git bundle not found: $BUNDLE_FILE"
git check-ref-format --branch "$TARGET_BRANCH" >/dev/null || fail "Invalid target branch: $TARGET_BRANCH"

if [ -n "$BASE_BRANCH" ]; then
  git check-ref-format --branch "$BASE_BRANCH" >/dev/null || fail "Invalid base branch: $BASE_BRANCH"
fi

git bundle verify "$BUNDLE_FILE"
mapfile -t BUNDLE_HEADS < <(git bundle list-heads "$BUNDLE_FILE")
[ "${#BUNDLE_HEADS[@]}" -eq 1 ] || fail "Git bundle must expose exactly one ref"

read -r BUNDLE_TIP BUNDLE_REF <<< "${BUNDLE_HEADS[0]}"
if [ -z "$BUNDLE_TIP" ] || [ -z "$BUNDLE_REF" ]; then
  fail "Git bundle ref is invalid"
fi

if git ls-remote --exit-code --heads origin "refs/heads/$TARGET_BRANCH" >/dev/null; then
  git fetch --no-tags origin "refs/heads/$TARGET_BRANCH:refs/remotes/origin/$TARGET_BRANCH"
  TARGET_TIP=$(git rev-parse "refs/remotes/origin/$TARGET_BRANCH")
else
  [ -n "$BASE_BRANCH" ] || fail "Target branch does not exist and no base branch was supplied"
  git fetch --no-tags origin "refs/heads/$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH"
  TARGET_TIP=$(git rev-parse "refs/remotes/origin/$BASE_BRANCH")
fi

git fetch --no-tags "$BUNDLE_FILE" "$BUNDLE_REF"
[ "$(git cat-file -t "$BUNDLE_TIP")" = commit ] || fail "Git bundle ref must point directly to a commit"
[ "$(git rev-parse FETCH_HEAD)" = "$BUNDLE_TIP" ] || fail "Fetched bundle commit did not match listed bundle ref"

# Fast-forward only, deliberately: a push that is not one would discard somebody's commits.
#
# "Cannot fast-forward" said nothing about why, and there are two reasons: the agent
# rewrote history (a rebase, an amend, a reset), or somebody pushed to the branch while it
# was working. Both mean the same thing to git, that the branch carries commits the bundle
# does not, so the applier cannot tell them apart and does not try. It prints the commits
# that are missing instead: their authors and dates answer the question immediately.
if ! git merge-base --is-ancestor "$TARGET_TIP" "$BUNDLE_TIP"; then
  echo "::error::Nothing was applied. $TARGET_BRANCH is at $TARGET_TIP and the bundle is at $BUNDLE_TIP, which does not contain it, so pushing would drop the commits below. Either the agent rewrote history, which this push refuses, or the branch moved while it was working, in which case nothing is lost and the gate only needs running again on the current head."
  echo "On $TARGET_BRANCH but missing from the bundle:"
  git --no-pager log --format="  %h %ad %an  %s" --date=short "$BUNDLE_TIP..$TARGET_TIP" |
    head -20 || true
  exit 1
fi
git switch --detach "$TARGET_TIP"
git merge --ff-only "$BUNDLE_TIP"
git push origin "HEAD:refs/heads/$TARGET_BRANCH"
