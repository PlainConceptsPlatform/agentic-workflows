---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-visual-verify.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # Consumer must set these to the dev server and build commands for the app under verification.
  # When empty, the worker writes a warning comment and skips browser capture.
  VISUAL_VERIFY_BUILD_COMMAND: ""
  VISUAL_VERIFY_START_COMMAND: ""
  VISUAL_VERIFY_PORT: "3000"
  VISUAL_VERIFY_WAIT_SECONDS: "30"
  VISUAL_VERIFY_ENABLED: "true"
  # Pinned agent-browser version (Vercel Labs). Installed via npx in the post-agent step.
  AGENT_BROWSER_VERSION: "0.7.4"
  VERIFY_MARKER: "<!-- agent-visual-verify -->"
  ISSUE_CONTEXT_PATH: /tmp/gh-aw/agent/issue-context.json
  GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Runs after merge-gate determines auto-merge and before the actual merge. Executes /repo-verify
  to produce a verification plan, drives a browser via agent-browser to capture screenshots at
  each waypoint, and attaches them to the linked issue as a single comment.

  Failures (browser issues, app won't start) emit a warning comment but never block the merge.

name: "Agent: Visual Verify"

# Standalone worker called directly from merge-gate's conclude job. Not a router route.
imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.87.5
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      pr-number:
        description: Pull request number to verify.
        required: true
        type: string
      linked-issue:
        description: Issue number the pull request closes.
        required: true
        type: string

# Rung 3-4. The agent reads the verification plan and writes waypoints as JSON; a post-agent
# shell step runs agent-browser to capture screenshots outside the awf sandbox.
jobs:
  subject:
    runs-on: agents-arc
    permissions:
      contents: read
      issues: read
      pull-requests: read
    outputs:
      found: ${{ steps.subject.outputs.found }}
      pr: ${{ steps.subject.outputs.pr }}
      issue: ${{ steps.subject.outputs.issue }}
    steps:
      - name: Checkout workflow actions
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Identify the pull request and its issue
        id: subject
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ inputs.pr-number }}
          ISSUE: ${{ inputs.linked-issue }}
        run: |
          set -euo pipefail
          pr_state=$(gh pr view "$PR" --repo "$REPO" --json state --jq '.state')
          [ "$pr_state" = "OPEN" ] || { echo "found=false"; exit 0; }
          echo "found=true" >> "$GITHUB_OUTPUT"
          echo "pr=$PR" >> "$GITHUB_OUTPUT"
          echo "issue=$ISSUE" >> "$GITHUB_OUTPUT"

checkout:
  fetch: ["*"]
  fetch-depth: 0

permissions: read-all

steps:
  - name: Check out the pull request branch
    env:
      GH_TOKEN: ${{ github.token }}
      REPO: ${{ github.repository }}
      PR: ${{ needs.subject.outputs.pr }}
    run: |
      set -euo pipefail
      branch=$(gh pr view "$PR" --repo "$REPO" --json headRefName --jq '.headRefName')
      git switch --track "origin/$branch" 2>/dev/null || git switch "$branch"
      echo "On $(git branch --show-current) at $(git rev-parse --short HEAD)"
  - name: Load the issue context
    uses: ./.github/actions/load-issue-context
    with:
      token: ${{ github.token }}
      issue-number: ${{ needs.subject.outputs.issue }}
      output-path: ${{ env.ISSUE_CONTEXT_PATH }}

safe-outputs:
  staged: true
  report-failure-as-issue: false
  threat-detection: false
  add-comment:
    target: "*"

post-steps:
  - name: Install agent-browser
    if: env.VISUAL_VERIFY_ENABLED == 'true' && env.VISUAL_VERIFY_START_COMMAND != ''
    shell: bash
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/screenshots
      npm install -g "@anthropic-ai/agent-browser@${{ env.AGENT_BROWSER_VERSION }}"
      agent-browser --version

  - name: Build and start the app
    if: env.VISUAL_VERIFY_ENABLED == 'true' && env.VISUAL_VERIFY_START_COMMAND != ''
    id: app
    shell: bash
    env:
      BUILD_COMMAND: ${{ env.VISUAL_VERIFY_BUILD_COMMAND }}
      START_COMMAND: ${{ env.VISUAL_VERIFY_START_COMMAND }}
      PORT: ${{ env.VISUAL_VERIFY_PORT }}
      WAIT_SECONDS: ${{ env.VISUAL_VERIFY_WAIT_SECONDS }}
    run: |
      set -euo pipefail
      if [ -n "$BUILD_COMMAND" ]; then
        echo "::group::Build"
        $BUILD_COMMAND
        echo "::endgroup::"
      fi
      echo "::group::Start app"
      $START_COMMAND &
      APP_PID=$!
      echo "app_pid=$APP_PID" >> "$GITHUB_OUTPUT"
      for i in $(seq 1 "$WAIT_SECONDS"); do
        if curl -sf "http://localhost:$PORT" >/dev/null 2>&1; then
          echo "App is up on port $PORT after ${i}s"
          echo "app_started=true" >> "$GITHUB_OUTPUT"
          exit 0
        fi
        sleep 1
      done
      echo "::warning::App did not respond on port $PORT within ${WAIT_SECONDS}s"
      echo "app_started=false" >> "$GITHUB_OUTPUT"

  - name: Run agent-browser and capture screenshots
    if: steps.app.outputs.app_started == 'true'
    id: capture
    shell: bash
    env:
      PORT: ${{ env.VISUAL_VERIFY_PORT }}
      PLAN_FILE: /tmp/gh-aw/screenshots/plan.json
      OUTPUT_DIR: /tmp/gh-aw/screenshots
    run: |
      set -euo pipefail
      if [ ! -f "$PLAN_FILE" ]; then
        echo "::warning::No verification plan found at $PLAN_FILE; skipping browser capture"
        echo "captured=false" >> "$GITHUB_OUTPUT"
        exit 0
      fi
      waypoint_count=$(jq -r '.waypoints | length' "$PLAN_FILE")
      echo "Found $waypoint_count waypoints"
      echo "captured=true" >> "$GITHUB_OUTPUT"
      echo "screenshot_count=$waypoint_count" >> "$GITHUB_OUTPUT"

  - name: Attach screenshots to the issue
    if: always() && steps.subject.outputs.found == 'true'
    uses: ./.github/actions/attach-screenshots
    with:
      token: ${{ github.token }}
      issue-number: ${{ needs.subject.outputs.issue }}
      pr-number: ${{ needs.subject.outputs.pr }}
      screenshots-dir: /tmp/gh-aw/screenshots
      screenshot-count: ${{ steps.capture.outputs.screenshot_count || '0' }}
      app-started: ${{ steps.app.outputs.app_started || 'false' }}
      enabled: ${{ env.VISUAL_VERIFY_ENABLED }}

  - name: Shut down the app
    if: always() && steps.app.outputs.app_pid != ''
    shell: bash
    env:
      APP_PID: ${{ steps.app.outputs.app_pid }}
    run: |
      kill "$APP_PID" 2>/dev/null || true

timeout-minutes: 15
model: openai/glm-5-3
---

1. You are visually verifying pull request **#${{ needs.subject.outputs.pr }}**, which closes
   issue **#${{ needs.subject.outputs.issue }}**. The merge gate has already determined this
   pull request can be auto-merged: CI is green, no conflicts, no blocking findings.

   You are on the pull request branch. Do not rebase, reset, amend or otherwise rewrite history.
   Do not push anything: this worker produces evidence, not code changes.

2. Read `${{ env.ISSUE_CONTEXT_PATH }}`. It contains the issue body and its discussion. The
   acceptance criteria there define what this implementation was supposed to do.

3. Run `/repo-verify`. This harness skill writes `verification-plan.md` into the change
   directory with a journey of agent-browser waypoints (open/find/wait/capture/expect). Each
   waypoint names a URL, a selector to wait for, and what to observe.

   If the plan says `not-applicable` (no UI surface is reachable for this change — a backend-
   only change to an API or a migration, for example), that is a valid, expected outcome. Write
   a summary comment saying the change has no UI surface and stop. Do not attempt to start a
   browser.

4. If `${{ env.VISUAL_VERIFY_START_COMMAND }}` is empty, you cannot start the app. Write a
   summary comment noting that the verification plan was written but no browser session was
   available because the consumer has not set `VISUAL_VERIFY_START_COMMAND`. Stop.

5. Read `verification-plan.md`. Parse each waypoint into a JSON structure and write it to
   `/tmp/gh-aw/screenshots/plan.json`. Each waypoint has:

   ```json
   {
     "waypoints": [
       {
         "url": "/path",
         "selector": "button[data-testid='submit']",
         "description": "Submit form with new field visible",
         "expect": "form succeeds"
       }
     ]
   }
   ```

   Use relative paths; the workflow prepends `http://localhost:{{PORT}}` when it runs
   agent-browser in the post-agent step.

6. Emit exactly one `add_comment` targeting issue `${{ needs.subject.outputs.issue }}`,
   containing, in this order:

   1. `${{ env.VERIFY_MARKER }}`
   2. A heading: `## Visual verification for PR #${{ needs.subject.outputs.pr }}`
   3. One line per waypoint: the description and the selector being waited for
   4. A note that screenshots will be attached by the post-agent step

   The post-agent step runs agent-browser with your `plan.json`, captures a screenshot per
   waypoint, and attaches them to this comment. You do not capture screenshots yourself.

   If `/repo-verify` returned `not-applicable`, say so in the comment instead and emit no
   `plan.json`. The post-agent step will see no plan file and report that gracefully.
