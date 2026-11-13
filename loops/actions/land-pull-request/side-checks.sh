#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/land-pull-request/side-checks.sh. Update with workflows update --force; consumer edits may be overwritten.
#
# Prints why a commit may not land yet, or nothing when it may. A side workflow
# (SIDE_CHECK_WORKFLOWS, comma-separated, default "Agentics checks") runs only when its paths change,
# so no ruleset can require it, and the CI verdict the train and the gate read leaves it out: a
# release once merged into three apps with its workflow lint red. A side workflow that did not run
# on the commit is no objection; one that is running, failed or cannot be read is.
# Usage: side-checks.sh <owner/repo> <sha>
set -euo pipefail
repo="$1"
sha="$2"
IFS=',' read -ra names <<<"${SIDE_CHECK_WORKFLOWS-Agentics checks}"
[ "${#names[@]}" -gt 0 ] || exit 0

if ! runs=$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" --jq '.workflow_runs' 2>/dev/null); then
  echo "the workflow runs on ${sha:0:7} could not be read"
  exit 0
fi

for name in "${names[@]}"; do
  name=$(sed -E 's/^ +| +$//g' <<<"$name")
  [ -n "$name" ] || continue
  latest=$(jq -r --arg n "$name" '[.[] | select(.name == $n)] | sort_by(.created_at) | last // empty | "\(.status) \(.conclusion // "")"' <<<"$runs")
  [ -n "$latest" ] || continue
  status=${latest%% *}
  conclusion=${latest#* }
  if [ "$status" != completed ]; then
    echo "$name is still running on ${sha:0:7}"
    exit 0
  fi
  case "$conclusion" in
    success | skipped | neutral) ;;
    *) echo "$name ended ${conclusion:-without a conclusion} on ${sha:0:7}"; exit 0 ;;
  esac
done
