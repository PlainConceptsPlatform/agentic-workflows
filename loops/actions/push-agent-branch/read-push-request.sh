#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/push-agent-branch/read-push-request.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Reads the agent's push_to_pull_request_branch request and writes `branch=<name>` to
# $GITHUB_OUTPUT, or nothing when the agent asked for no push. Exits non-zero when the push
# cannot be applied.
#
# Environment: OUTPUT_FILE (agent_output.json), BUNDLE_FILE (may be empty), EXPECTED_BRANCH
# (may be empty: then the branch the item names is accepted).
set -euo pipefail

[ -f "$OUTPUT_FILE" ] || exit 0

# gh-aw keeps the first push and drops any later one ("Too many items"), so the first is the one.
ITEM=$(jq -c '[.items[] | select(.type == "push_to_pull_request_branch")][0] // empty' "$OUTPUT_FILE")
[ -n "$ITEM" ] || exit 0

BRANCH=$(echo "$ITEM" | jq -r '.branch // empty')
# The agent names the branch; the caller knows it. A push anywhere else is refused, not
# redirected: a model that named the wrong branch may have built on the wrong one too.
# An item that names none was built on the checkout, which is the expected branch.
if [ -n "$EXPECTED_BRANCH" ] && [ -z "$BRANCH" ]; then
  BRANCH="$EXPECTED_BRANCH"
fi
if [ -n "$EXPECTED_BRANCH" ] && [ "$BRANCH" != "$EXPECTED_BRANCH" ]; then
  echo "::error::The agent asked to push to '$BRANCH'; this run may only push to '$EXPECTED_BRANCH'."
  exit 1
fi
if [ -z "$BRANCH" ]; then
  echo "::error::The agent asked for a push but named no branch, and this run has no expected branch to use."
  exit 1
fi

# A push with nothing to push used to end here silently: the bundle step was skipped, the job
# stayed green, and the caller went on to report the repair as made. With gh-aw 1.2 that was
# every push, because the compiler stopped putting the bundle in the agent artifact, and the
# merge gate posted "remediated" on pull requests whose branch never moved. A requested push
# that cannot be applied is a failed run, so the caller's failure path reports it.
if [ -z "${BUNDLE_FILE:-}" ] || [ ! -f "$BUNDLE_FILE" ]; then
  echo "::error::The agent asked to push to '$BRANCH', but this run carries no git bundle, so the repair could not be applied and nothing was pushed. Check that the worker uploads /tmp/gh-aw/aw-*.bundle as the '<prefix>agent-bundle' artifact."
  exit 1
fi

echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"
