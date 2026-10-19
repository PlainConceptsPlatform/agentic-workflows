---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-release.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # The model this worker's own session runs on. opencode.ci.json's `model` is the cheap default
  # every agent without its own model falls back to; the lead is where a wrong call costs a run,
  # so it names its model here. `model:` below only satisfies the compiler. A repository may
  # change it to any model its opencode.ci.json declares.
  AGENT_LEAD_MODEL: "forge/quasar-438b"
  # Empty: every harness tier (plan, build, fast) runs on the model harness.json names, as on a
  # developer's machine. Set it only to pin all tiers to one model, which the proxy must price.
  AGENT_TIER_MODEL: ""
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Generates release notes from the commit log and opens a release pull request.
  The agent writes human-readable release notes; every other step (version bump,
  release branch, pull request, auto-merge) is deterministic. release-tag.yml tags
  the merged commit and publishes the GitHub Release.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: version-bump(patch|minor|major|auto).

name: "Agent: Release"

imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.87.5
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      version-bump:
        description: "Version bump strategy: patch, minor, major, or auto"
        required: false
        type: string
        default: "auto"

runs-on: agents-arc
runs-on-slim: agents-arc

secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

engine:
  id: opencode
  version: "1.2.14"
  env:
    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1

model: openai/glm-5-2

max-turns: 100
max-turn-cache-misses: 3000
max-ai-credits: 2000

permissions: read-all

checkout:
  fetch: ["*"]
  fetch-depth: 0

steps:
  - name: Prepare release context
    env:
      GH_TOKEN: ${{ github.token }}
      REPO: ${{ github.repository }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent

      last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
      if [ -n "$last_tag" ]; then
        git log --oneline --no-decorate "${last_tag}..HEAD" > /tmp/gh-aw/agent/git-log.txt
      else
        git log --oneline --no-decorate -50 > /tmp/gh-aw/agent/git-log.txt
      fi

      version=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
      echo "$version" > /tmp/gh-aw/agent/current-version.txt

      echo "Last tag: ${last_tag:-none}"
      echo "Current version: $version"

safe-outputs:
  report-failure-as-issue: false
  threat-detection: false
  noop:
    max: 1

# The fleet is two machines, so this clock is also how long a stuck run can hold half of it.
# 240 went on to every worker at once when the provider was slow, which fixed the deaths and
# made every worker equally expensive to hang. These numbers are per worker: enough headroom
# for a slow gateway on the work it actually does, and not four hours for a run that reads one
# issue. Turns remain the guard against a confused agent looping; the credit ceiling meters the
# Forge models at Multiverse's list prices, set in shared/opencode-ci.md.
#
# Reads a commit log already on disk and writes release notes. Nothing else.
timeout-minutes: 30

jobs:
  # The release is a pull request, not a push. A repository whose `main` requires pull
  # requests and status checks cannot accept a direct push, and a push with GITHUB_TOKEN would
  # not start CI on the branch either, so the required checks would never report. The App token
  # does both: its push and its pull request fire workflows, so CI runs and auto-merge can land
  # the bump once it is green.
  #
  # No tag and no GitHub Release here. `release-tag.yml` creates both after the merge, with
  # GITHUB_TOKEN on purpose: a consumer deploying to production on `v*` tags must not start
  # that deploy from a release (see the comment at the top of release-tag.yml).
  conclude:
    needs: [activation, agent, safe_outputs]
    if: >
      always() &&
      needs.agent.result == 'success' &&
      needs.safe_outputs.result == 'success'
    runs-on: agents-arc
    permissions:
      contents: read
    steps:
      - name: Download agent output artifact
        id: download-agent-output
        continue-on-error: true
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          pattern: "{${{ needs.activation.outputs.artifact_prefix }}agent,${{ needs.activation.outputs.artifact_prefix }}agent-output-fallback}"
          merge-multiple: true
          path: /tmp/gh-aw/
      - name: Create bot token
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          token: ${{ steps.app-token.outputs.token }}
          fetch-depth: 0
      - name: Read release notes and determine version
        id: release
        env:
          VERSION_BUMP: ${{ inputs.version-bump }}
        run: |
          set -euo pipefail

          notes="/tmp/gh-aw/agent/release-notes.md"
          if [ ! -f "$notes" ]; then
            echo "::error::Agent did not write release-notes.md"
            exit 1
          fi

          current=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
          echo "current_version=$current" >> "$GITHUB_OUTPUT"

          # Determine the version bump
          bump="$VERSION_BUMP"
          if [ "$bump" = "auto" ]; then
            if grep -qiE 'BREAKING CHANGE' "$notes" || grep -qE '\w+\(!:' /tmp/gh-aw/agent/git-log.txt; then
              bump="major"
            elif grep -qE '^feat(\(.+\))?:' /tmp/gh-aw/agent/git-log.txt; then
              bump="minor"
            else
              bump="patch"
            fi
          fi

          # Semver bump
          IFS='.' read -r major minor patch <<< "$current"
          case "$bump" in
            major) major=$((major + 1)); minor=0; patch=0 ;;
            minor) minor=$((minor + 1)); patch=0 ;;
            patch) patch=$((patch + 1)) ;;
            *) echo "::error::Unknown version-bump: $bump"; exit 1 ;;
          esac
          new_version="${major}.${minor}.${patch}"
          echo "new_version=$new_version" >> "$GITHUB_OUTPUT"
          echo "Determined version: $current -> $new_version (bump: $bump)"

          # Copy notes to a clean location the release step can read
          cp "$notes" /tmp/release-notes.md
      - name: Bump version in package.json
        env:
          NEW_VERSION: ${{ steps.release.outputs.new_version }}
        run: |
          set -euo pipefail
          node -e "
            const fs = require('fs');
            for (const file of ['package.json', 'cli/package.json']) {
              if (fs.existsSync(file)) {
                const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
                pkg.version = process.env.NEW_VERSION;
                fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
                console.log('Bumped ' + file + ' to ' + process.env.NEW_VERSION);
              }
            }
          "
      - name: Commit and push the release branch
        id: branch
        env:
          NEW_VERSION: ${{ steps.release.outputs.new_version }}
        run: |
          set -euo pipefail
          base=$(git rev-parse --abbrev-ref HEAD)
          branch="release/v${NEW_VERSION}"
          # A second dispatch before the first release PR merged computes the same version from
          # the same package.json. Two PRs bumping to one version would tag it twice.
          if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
            echo "::error::Branch $branch already exists: a release PR for v${NEW_VERSION} is open or was abandoned. Merge or close it, delete the branch, then dispatch again."
            exit 1
          fi
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git switch -c "$branch"
          git add package.json
          [ -f cli/package.json ] && git add cli/package.json
          git commit -m "chore(release): v${NEW_VERSION}"
          git push origin "$branch"
          echo "base=$base" >> "$GITHUB_OUTPUT"
          echo "branch=$branch" >> "$GITHUB_OUTPUT"
          echo "Pushed $branch (base $base)."
      # The body is what release-tag.yml publishes as the GitHub Release notes. The marker is how
      # it tells this PR from any other PR associated with the merge commit.
      - name: Open the release pull request
        id: pr
        env:
          NEW_VERSION: ${{ steps.release.outputs.new_version }}
          BASE: ${{ steps.branch.outputs.base }}
          BRANCH: ${{ steps.branch.outputs.branch }}
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          set -euo pipefail
          {
            echo "<!-- release:v${NEW_VERSION} -->"
            cat /tmp/release-notes.md
          } > /tmp/release-pr-body.md
          url=$(gh pr create \
            --repo "$GITHUB_REPOSITORY" \
            --base "$BASE" \
            --head "$BRANCH" \
            --title "chore(release): v${NEW_VERSION}" \
            --body-file /tmp/release-pr-body.md)
          echo "url=$url" >> "$GITHUB_OUTPUT"
          echo "Opened $url"
      # Squash keeps the PR title as the commit subject, which is what release-tag.yml matches.
      - name: Enable auto-merge
        env:
          NEW_VERSION: ${{ steps.release.outputs.new_version }}
          PR_URL: ${{ steps.pr.outputs.url }}
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          set -euo pipefail
          if gh pr merge "$PR_URL" --auto --squash --subject "chore(release): v${NEW_VERSION}" 2>/tmp/auto-merge.err; then
            echo "Auto-merge enabled on $PR_URL; v${NEW_VERSION} is tagged once it merges."
            exit 0
          fi
          cat /tmp/auto-merge.err >&2
          allowed=$(gh api "repos/$GITHUB_REPOSITORY" --jq '.allow_auto_merge' 2>/dev/null || echo "unknown")
          if [ "$allowed" = "false" ]; then
            echo "::warning::Auto-merge is disabled on $GITHUB_REPOSITORY, so the release PR $PR_URL stays open. Merge it by hand (squash), or enable it once: gh api -X PATCH repos/$GITHUB_REPOSITORY -F allow_auto_merge=true"
          else
            echo "::warning::Could not enable auto-merge on $PR_URL; it stays open. Merge it by hand (squash) to tag v${NEW_VERSION}."
          fi

  incomplete:
    needs: [agent, safe_outputs]
    if: >
      always() &&
      (needs.agent.result != 'success' || needs.safe_outputs.result != 'success')
    runs-on: agents-arc
    permissions:
      contents: read
    steps:
      - name: Report release failure
        run: |
          echo "::error::Release agent did not complete successfully."
          echo "The release was not created. Check the agent logs."
          exit 1

---

1. Read `/tmp/gh-aw/agent/git-log.txt`. It contains the commit log since the last
   tag (or the last 50 commits if no tag exists).

2. Read `/tmp/gh-aw/agent/current-version.txt` for the current version.

3. Categorize commits by conventional-commit prefix:
   - `feat:` / `feat(scope):` → Features
   - `fix:` / `fix(scope):` → Bug Fixes
   - `chore:` / `chore(scope):` → Maintenance
   - `docs:` → Documentation
   - `refactor:` → Refactoring
   - `perf:` → Performance
   - Any `BREAKING CHANGE` footer or `!:` prefix → Breaking Changes (top of the notes)

4. Write structured release notes in markdown to `/tmp/gh-aw/agent/release-notes.md`.
   Format:
   - A `## What's Changed` heading
   - Breaking Changes section first (if any)
   - Grouped sections: `### Features`, `### Bug Fixes`, etc.
   - One bullet per commit with the commit message (not the hash)
   - A `**Full Changelog**: <last-tag>...<new-tag>` line at the end
   - Keep it concise and factual. Do not invent changes that are not in the log.

5. Call `noop` and stop. The deterministic `conclude` job reads the notes you wrote
   and handles the version bump and the release pull request.
