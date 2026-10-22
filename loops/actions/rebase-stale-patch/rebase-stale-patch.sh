#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/rebase-stale-patch/rebase-stale-patch.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# gh-aw pushes an agent's commits onto the base as it is when the run ends. When the base moved
# under a long run and the commits no longer apply, gh-aw files the patch as an issue and the work
# waits for a person, although most of the time a plain rebase applies it: Pliny-Bot #787 and #794
# were both rebased by hand in minutes. This does that rebase here and opens the pull request the
# agent asked for. A conflict a rebase cannot settle stays with a person, exactly as before.
#
# Needs: GH_TOKEN (App), DOWNLOAD_TOKEN (the run's own token, for its artifacts), REPO, RUN_ID, ARTIFACT, ISSUE, DEFAULT_BRANCH, GITHUB_OUTPUT.

set -euo pipefail

say() { echo "$1"; }
done_with() {
  echo "rescued=$1" >> "$GITHUB_OUTPUT"
  echo "pr_number=${2:-}" >> "$GITHUB_OUTPUT"
  exit 0
}

work="$(mktemp -d)"
if ! GH_TOKEN="${DOWNLOAD_TOKEN:-$GH_TOKEN}" gh run download "$RUN_ID" --repo "$REPO" --name "$ARTIFACT" --dir "$work" >/dev/null 2>&1; then
  say "No agent artifact to rebase from."
  done_with false
fi

bundle="$(find "$work" -maxdepth 1 -name '*.bundle' | head -1)"
output="$work/agent_output.json"
if [ -z "$bundle" ] || [ ! -f "$output" ]; then
  say "The artifact holds no bundle or no agent output."
  done_with false
fi

request="$(jq -c '[.items[]? | select(.type == "create_pull_request")] | first // empty' "$output")"
if [ -z "$request" ]; then
  say "The agent did not ask for a pull request."
  done_with false
fi
branch="$(jq -r '.branch // empty' <<<"$request")"
title="$(jq -r '.title // empty' <<<"$request")"
jq -r '.body // ""' <<<"$request" > "$work/body.md"
if [ -z "$branch" ] || [ -z "$title" ]; then
  say "The pull request request has no branch or title."
  done_with false
fi

# A stack child targets its feature branch while that branch exists; otherwise the default branch.
base="$DEFAULT_BRANCH"
stack="$(gh issue view "$ISSUE" --repo "$REPO" --json body --jq '.body // ""' |
  sed -nE 's/.*<!-- stack-root-branch: ([^ ]+) -->.*/\1/p' | head -1)"
if [ -n "$stack" ] && gh api "repos/$REPO/branches/$stack" >/dev/null 2>&1; then
  base="$stack"
fi

remote="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
# Full history: the bundle's prerequisites are commits of the base, and a rebase needs their blobs.
if git rev-parse --is-shallow-repository | grep -q true; then
  git fetch --quiet --unshallow "$remote" "+refs/heads/${base}:refs/remotes/rescue-base/${base}"
else
  git fetch --quiet "$remote" "+refs/heads/${base}:refs/remotes/rescue-base/${base}"
fi
git fetch --quiet "$bundle" "+refs/heads/*:refs/remotes/rescue-bundle/*"
head="refs/remotes/rescue-bundle/${branch}"
if ! git rev-parse --verify --quiet "$head" >/dev/null; then
  head="$(git for-each-ref --format='%(refname)' refs/remotes/rescue-bundle | head -1)"
fi

rescued_branch="${branch}-rebased-${RUN_ID}"
git checkout --quiet -B "$rescued_branch" "$head"
if ! git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  rebase --quiet "refs/remotes/rescue-base/${base}"; then
  git rebase --abort || true
  say "The rebase onto ${base} conflicts: left for a person."
  done_with false
fi

git push --quiet "$remote" "HEAD:refs/heads/${rescued_branch}"

grep -qiE "(closes|fixes|resolves) #${ISSUE}\b" "$work/body.md" || printf '\n\nCloses #%s\n' "$ISSUE" >> "$work/body.md"
# shellcheck disable=SC2016
printf '\n\nRebased onto `%s` by the workflow: the agent'"'"'s commits no longer applied after `%s` moved during the run.\n' \
  "$base" "$base" >> "$work/body.md"
[[ "$title" == "[bot] "* ]] || title="[bot] $title"
url="$(gh pr create --repo "$REPO" --base "$base" --head "$rescued_branch" --title "$title" --body-file "$work/body.md")"
number="${url##*/}"

# The issue gh-aw filed with the patch is superseded by the pull request.
stray="$(gh issue list --repo "$REPO" --state open --limit 30 --json number,title 2>/dev/null |
  jq -r --arg t "$title" '[.[] | select(.title == $t)] | first | .number // empty' || true)"
if [ -n "$stray" ]; then
  gh issue close "$stray" --repo "$REPO" --reason "not planned" \
    --comment "Superseded by #${number}: the patch was rebased onto ${base} and opened as a pull request." >/dev/null
fi

say "Rebased onto ${base} and opened #${number}."
done_with true "$number"
