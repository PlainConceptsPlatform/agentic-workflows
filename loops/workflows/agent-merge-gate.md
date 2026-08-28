---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-merge-gate.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  VERIFY_COMMANDS: ""
  REPO_RULES: "Make a risk-based merge decision for the selected bot pull request. Merge only when CI is green and no risk indicators are present. Review risk indicators defined in the repository's guardrails or project documentation. Any of these require human review. Do not merge protected file changes."
  WORKING_LABEL: bot-working
  IMPLEMENT_LABEL: implement
  REVIEW_LABEL: review
  GATE_MARKER: "<!-- agent-merge-gate -->"
  INCOMPLETE_COMMENT: "Automated CI failure remediation ended without an outcome. The issue remains for a retry."
  ISSUE_CONTEXT_PATH: /tmp/gh-aw/agent/issue-context.json
  GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Decides what happens to a bot-authored pull request once CI has reported: merge when the
  risk assessment is clean, hand to a human when it is not, fix CI when it failed. Called by
  the Work Router; does not trigger on public events.

  The router supplies the CI conclusion and run ID as facts, so there is no polling and no
  timeout branch. The conclusion is read from the inputs instead of filtered at the trigger.

name: "Agent: Merge Gate"

# Router-only worker. The Work Router owns triggers, classification, and rung 1-2 checks.
# This workflow receives the classified inputs and runs rung 3+.
imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.87.5
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      pr-number:
        description: Pull request number to gate.
        required: true
        type: string
      linked-issue:
        description: Issue number the pull request closes. May be empty.
        required: false
        type: string
      ci-conclusion:
        description: CI conclusion (success, failure, action_required, cancelled, etc.).
        required: true
        type: string
      ci-run-id:
        description: CI workflow run ID for fetching failing logs.
        required: false
        type: string

# Rung 4. Router has classified the event; identify-gate-subject validates PR ownership,
# resolves the closing issue, and confirms the CI verdict.
# A custom job, not `on.steps`, because the prompt and the precompute step need these
# values and `on.steps` outputs do not reach the agent job.
jobs:
  subject:
    runs-on: agents-arc
    permissions:
      contents: read
      issues: read
      pull-requests: read
      actions: read
    outputs:
      found: ${{ steps.subject.outputs.found }}
      pr: ${{ steps.subject.outputs.pr }}
      issue: ${{ steps.subject.outputs.issue }}
      conclusion: ${{ steps.subject.outputs.conclusion }}
      review_blocked: ${{ steps.review.outputs.review_blocked }}
    steps:
      - name: Checkout workflow actions
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Identify the pull request, its issue, and the CI verdict
        id: subject
        uses: ./.github/actions/identify-gate-subject
        with:
          token: ${{ github.token }}
          pr-number: ${{ inputs.pr-number }}
          ci-conclusion: ${{ inputs.ci-conclusion }}
          linked-issue: ${{ inputs.linked-issue }}
          require-label: ${{ env.IMPLEMENT_LABEL }}
      - name: Block a pull request with requested changes
        id: review
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ steps.subject.outputs.pr }}
        run: |
          set -euo pipefail
          decision=$(gh pr view "$PR" --repo "$REPO" --json reviewDecision --jq '.reviewDecision')
          echo "review_blocked=$([ "$decision" = 'CHANGES_REQUESTED' ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

  protected_changes:
    needs: subject
    if: needs.subject.outputs.found == 'true'
    runs-on: agents-arc
    permissions:
      pull-requests: read
    outputs:
      requires_review: ${{ steps.files.outputs.requires_review }}
      files: ${{ steps.files.outputs.files }}
    steps:
      - name: Require review for protected pull request files
        id: files
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ needs.subject.outputs.pr }}
        run: |
          set -euo pipefail
          files=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename')
          protected=$(printf '%s\n' "$files" | grep -E '^(\.|AGENTS\.md$|ARCHITECTURE\.md$|opencode\.jsonc$|package\.json$|pnpm-lock\.yaml$|Directory\.Packages\.props$|global\.json$)' || true)

          if [ -n "$protected" ]; then
            echo "requires_review=true" >> "$GITHUB_OUTPUT"
            {
              echo 'files<<EOF'
              printf '%s\n' "$protected"
              echo EOF
            } >> "$GITHUB_OUTPUT"
          else
            echo "requires_review=false" >> "$GITHUB_OUTPUT"
            echo "files=" >> "$GITHUB_OUTPUT"
          fi

  review_required:
    needs: [subject, protected_changes]
    # gh-aw makes the agent depend on custom jobs. Keep this job successful when
    # there are no protected files instead of skipping it and blocking remediation.
    if: always() && needs.subject.outputs.found == 'true'
    runs-on: agents-arc
    permissions:
      contents: read
      issues: write
    steps:
      - name: Checkout workflow actions
        if: needs.protected_changes.outputs.requires_review == 'true'
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Create bot token
        if: needs.protected_changes.outputs.requires_review == 'true'
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - name: Release the issue
        if: needs.protected_changes.outputs.requires_review == 'true'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag human review
        if: needs.protected_changes.outputs.requires_review == 'true'
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Explain the merge hold
        if: needs.protected_changes.outputs.requires_review == 'true'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.GATE_MARKER }}
            PR #${{ needs.subject.outputs.pr }} changes protected files and cannot be auto-merged.
            The `review` label is set: a human must merge this PR manually.

            Protected files:
            ${{ needs.protected_changes.outputs.files }}

  reserve:
    needs: subject
    if: needs.subject.outputs.found == 'true'
    runs-on: agents-arc
    permissions:
      contents: read
      issues: write
      pull-requests: read
    outputs:
      has_conflicts: ${{ steps.conflicts.outputs.has_conflicts || 'false' }}
    steps:
      - name: Checkout workflow actions
        if: needs.subject.outputs.conclusion == 'failure'
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Create bot token
        if: needs.subject.outputs.conclusion == 'failure'
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - name: Check for merge conflicts
        if: needs.subject.outputs.conclusion == 'failure'
        id: conflicts
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REPO: ${{ github.repository }}
          PR: ${{ needs.subject.outputs.pr }}
        run: |
          set -euo pipefail
          mergeable=$(gh pr view "$PR" --repo "$REPO" --json mergeable --jq '.mergeable')
          if [ "$mergeable" = "CONFLICTING" ]; then
            echo "has_conflicts=true" >> "$GITHUB_OUTPUT"
          else
            echo "has_conflicts=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Comment on issue - problems found, solving them
        if: needs.subject.outputs.conclusion == 'failure'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.GATE_MARKER }}
            Problems found in PR #${{ needs.subject.outputs.pr }}. ${{ steps.conflicts.outputs.has_conflicts == 'true' && 'Merge conflicts detected.' || 'CI failed.' }}
            Bot is working on fixing it.
  validate_output:
    needs: [activation, subject, agent, safe_outputs]
    if: >
      always() &&
      needs.agent.result == 'success' &&
      needs.safe_outputs.result == 'success'
    runs-on: agents-arc
    permissions:
      contents: read
    outputs:
      valid: ${{ steps.validate.outputs.valid }}
      outcome: ${{ steps.validate.outputs.outcome }}
    steps:
      - name: Checkout workflow actions
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent output
        id: output
        uses: ./.github/actions/download-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
      - name: Validate merge-gate outcome
        id: validate
        uses: ./.github/actions/validate-merge-gate-output
        with:
          output-file: ${{ steps.output.outputs.output-file }}
          issue-number: ${{ needs.subject.outputs.issue }}
          ci-conclusion: ${{ needs.subject.outputs.conclusion }}
  conclude:
    needs: [activation, subject, protected_changes, agent, safe_outputs, validate_output]
    if: >
      needs.agent.result == 'success' &&
       needs.safe_outputs.result == 'success' &&
       needs.validate_output.outputs.valid == 'true' &&
      needs.protected_changes.outputs.requires_review != 'true'
    runs-on: agents-arc
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
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
      - name: Verify pull request closes the source issue
        continue-on-error: true
        uses: ./.github/actions/link-pr-to-issue
        with:
          token: ${{ steps.app-token.outputs.token }}
          pr-number: ${{ needs.subject.outputs.pr }}
          issue-number: ${{ needs.subject.outputs.issue }}
      - name: Apply agent output
        uses: ./.github/actions/apply-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
          token: ${{ steps.app-token.outputs.token }}
          push-to-branch: 'true'
          apply-labels: 'false'
      - name: Merge approved pull request
        if: needs.validate_output.outputs.outcome == 'merge'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REPO: ${{ github.repository }}
          PR: ${{ needs.subject.outputs.pr }}
        run: |
          set -euo pipefail
          head_sha=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq '.headRefOid')
          gh pr merge "$PR" --repo "$REPO" --squash --match-head-commit "$head_sha"
      - name: Release remediated issue
        if: needs.validate_output.outputs.outcome == 'remediated'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag review outcome
        if: needs.validate_output.outputs.outcome == 'review'
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Release review outcome
        if: needs.validate_output.outputs.outcome == 'review'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Clear merged issue labels
        if: needs.validate_output.outputs.outcome == 'merge'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.IMPLEMENT_LABEL }},${{ env.WORKING_LABEL }},${{ env.REVIEW_LABEL }}
  incomplete:
    needs: [subject, protected_changes, agent, safe_outputs, validate_output]
    if: >
      always() &&
      needs.subject.outputs.found == 'true' &&
      needs.protected_changes.outputs.requires_review != 'true' &&
       (
         needs.agent.result != 'success' ||
         needs.safe_outputs.result != 'success' ||
         needs.validate_output.outputs.valid != 'true'
       )
    runs-on: agents-arc
    permissions:
      contents: read
      issues: write
    steps:
      - name: Checkout workflow actions
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Create bot token
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - name: Release the issue
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }},${{ env.IMPLEMENT_LABEL }}
      - name: Flag for human review
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Report missing remediation outcome
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.GATE_MARKER }}
            Bot could not resolve PR #${{ needs.subject.outputs.pr }} automatically. The `review` label is set: a human must take over.
            ${{ env.INCOMPLETE_COMMENT }}
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})

  agent:
    # The top-level guard reads both outputs. GitHub Actions does not make a
    # dependency's dependencies available through `needs` transitively.
    needs: [subject, protected_changes]
    if: always() && needs.protected_changes.outputs.requires_review != 'true' && needs.subject.outputs.review_blocked != 'true'

if: always() && needs.subject.outputs.found == 'true' && needs.protected_changes.outputs.requires_review != 'true' && needs.subject.outputs.review_blocked != 'true'

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

max-turns: 300
max-turn-cache-misses: 3000
max-ai-credits: 5000

permissions: read-all

# push-to-pull-request-branch with target "*" cannot reach a branch the shallow clone
# does not have.
checkout:
  fetch: ["*"]
  fetch-depth: 0

# Rung 3. The diff is what the risk assessment reads, and the failing logs are what a fix
# starts from. Both are known from the inputs, so neither costs the agent a turn.
steps:
  - name: Load the issue context
    uses: ./.github/actions/load-issue-context
    with:
      token: ${{ github.token }}
      issue-number: ${{ needs.subject.outputs.issue }}
      output-path: ${{ env.ISSUE_CONTEXT_PATH }}
  - name: Fetch the diff and any failing job logs
    env:
      GH_TOKEN: ${{ github.token }}
      REPO: ${{ github.repository }}
      PR: ${{ needs.subject.outputs.pr }}
      RUN_ID: ${{ inputs.ci-run-id }}
      CONCLUSION: ${{ needs.subject.outputs.conclusion }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh pr diff "$PR" --repo "$REPO" > /tmp/gh-aw/agent/diff.patch
      gh pr view "$PR" --repo "$REPO" --json title,body,files,additions,deletions \
        > /tmp/gh-aw/agent/pr.json
      if [ "$CONCLUSION" = "failure" ]; then
        gh run view "$RUN_ID" --repo "$REPO" --log-failed \
          > /tmp/gh-aw/agent/failed-logs.txt 2>/dev/null || \
          echo "logs unavailable" > /tmp/gh-aw/agent/failed-logs.txt
        gh run view "$RUN_ID" --repo "$REPO" --json jobs \
          --jq '[.jobs[] | select(.conclusion == "failure") | {name, conclusion}]' \
          > /tmp/gh-aw/agent/failed-jobs.json
      fi

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  threat-detection: false
  push-to-pull-request-branch:
  add-comment:
    target: "*"

timeout-minutes: 60
---

1. You are gating pull request **#${{ needs.subject.outputs.pr }}**, which closes issue
   **#${{ needs.subject.outputs.issue }}**. CI concluded
   **${{ needs.subject.outputs.conclusion }}**.

   It has already been confirmed that this is an open pull request we authored, that it closes
   an issue, and that the issue carries `implement`. Do not re-check any of that, and do not
   poll for checks: the conclusion above is the answer.

2. Read `${{ env.ISSUE_CONTEXT_PATH }}`. It contains the issue body and its discussion. When
   running `/repo-verify`, the acceptance criteria there define what the implementation must
   satisfy.

3. Branch on the conclusion.

   First check the issue context for `<!-- complexity: trivial -->`.

   **If the trivial marker is present AND CI conclusion is success:**
   Skip the full assessment (step 5). Emit a minimal assessment table with all checks marked
   ✅ and the note "Trivial change, CI green — deep risk review skipped." Then proceed directly
   to step 8 (merge verdict).

   **If the trivial marker is absent OR CI is not success:**
   Follow the normal branching below.

   - **success** → step 4, then step 5 (full assessment).
    - **action_required** → CI did not run because the workflow needs approval.
      Emit the assessment table with ❌ on CI Status and note that a maintainer must approve
      the pending run. Select the `review` verdict.
    - **failure** → step 4, then step 6 (CI remediation).
     - **cancelled, timed_out, or anything else** → Emit the assessment table with ❌ on CI
      Status and select the `review` verdict. A cancelled or unknown run is not evidence of
      anything.

     Follow repository documentation and established conventions when assessing or remediating
     the pull request. Protect secrets, do not bypass checks, and keep remediation focused.
     Adhere to ${{ env.REPO_RULES }}.

4. Read the diff and PR metadata. Read `/tmp/gh-aw/agent/diff.patch` in full and
   `/tmp/gh-aw/agent/pr.json` for the shape of the change. If CI failed, also read
   `/tmp/gh-aw/agent/failed-jobs.json` and `/tmp/gh-aw/agent/failed-logs.txt`.

   These files are the factual basis for every check below. Do not guess — cite what you read.

5. Run each of these 10 checks. For each, determine a status and a short detail line.

   **Check 1 — CI Status.** What did CI conclude? Success means all required checks passed.
   Failure means at least one job failed. Action required means a workflow needs approval.
   Flag any non-success conclusion.

   **Check 2 — Auth & Security.** Does the diff touch authentication, authorization, secrets,
   credentials, or security boundaries? Flag any change to auth middleware, permission checks,
   token issuance, or security-related config.

   **Check 3 — API & Contracts.** Does the diff change a public API or a published package's
   contract? Flag changes to endpoint signatures, DTO shapes, exported interfaces, or
   serialization formats that could break consumers.

   **Check 4 — Tests.** Does the diff delete, weaken, or lower a threshold in a test? Flag
   removed assertions, skipped tests, lowered coverage bars, or deleted test files.

   **Check 5 — CI/CD & Workflow files.** Does the diff change CI, CD, or workflow files?
   Flag changes to `.github/workflows/`, Dockerfiles, deployment scripts, or infrastructure
   configuration.

   **Check 6 — Protected files.** Does the diff change a protected file? This is normally
   handled before you run, but never merge one if it reaches this gate. Flag any match against
   the repository's protected file list.

   **Check 7 — Scope.** Is the diff size consistent with what the issue implied? Compare the
   number of files changed and lines added/removed against the complexity the issue described.
   Flag if the diff is materially larger or smaller than expected.

   **Check 8 — Repository risk indicators.** Does the diff touch any risk indicator defined in
   ${{ env.REPO_RULES }}? Review the repository guardrails for domain-specific risk areas such
   as calculation engines, audit chains, authentication, database migrations, or money handling.
   Flag any
   match and name the specific indicator.

   **Check 9 — Mergeability.** Can the PR be merged cleanly? The value is
   `${{ needs.reserve.outputs.has_conflicts }}`. If conflicts exist, this is ❌ but not a
   blocking verdict — proceed to remediation (step 6). If no conflicts, ✅.

   **Check 10 — Confidence.** Are you confident in the merge decision? Low confidence is
   itself a flag. If you are unsure about the impact of the change, mark ⚠️ and explain what
   is uncertain. A human should review when confidence is low.

6. **CI failed** → read `/tmp/gh-aw/agent/failed-jobs.json` and
   `/tmp/gh-aw/agent/failed-logs.txt`, which are already on disk. Load only skills required to
   fix the actual cause. Run these verification commands before a push. Do not weaken a test,
   disable a check, or push an unverified guess.

   **If `has_conflicts` is `true` (current value: `${{ needs.reserve.outputs.has_conflicts }}`):** You are already on the PR branch. Resolve the conflict;
   it is not a reason to hand the PR to a human. Merge `origin/${{ github.event.repository.default_branch }}`
   into the current branch, resolve every conflict deliberately, stage the resolutions, and
   commit the merge. Then run verification and push the resulting branch update. Do not use
   `--ours`, `--theirs`, or a blanket conflict-marker deletion without reviewing the intended
   behavior from both sides.

   ```
   ${{ env.VERIFY_COMMANDS }}
   ```

   Propose `push_to_pull_request_branch` (pr_number: ${{ needs.subject.outputs.pr }}, branch:
   the current PR branch), then select the `remediated` verdict. CI will run again and trigger
   you again with the new result.

   If you cannot fix it after a concrete repair attempt, or the logs show you have already tried on this same head commit,
   stop looping: select the `review` verdict and explain the failure and what you tried. A human
   decides from there.

7. Decide the verdict based on the assessment table:

   - **All checks ✅ → `merge`.** The PR is safe to merge. CI is green, no risk indicators
     triggered, tests are intact, scope matches, mergeability is clean.
   - **Any check ⚠️ or ❌ (except CI failure) → `review`.** Do not merge. Explain exactly which
     check tripped, why, and what a reviewer should look at. Leave `implement` in place: the
     work is not finished until a human merges it.
   - **CI failed and you fixed it → `remediated`.** You pushed a verified fix and CI will
     re-run.
   - **CI failed and you cannot fix it → `review`.** Explain the failure and what you tried.

   Never merge with administrator privileges and never bypass a required check. If the merge
   is refused, that refusal is the answer: select `review` and leave it for a human.

8. Emit exactly one `add_comment` targeting issue `${{ needs.subject.outputs.issue }}` with:
   1. `${{ env.GATE_MARKER }}`
   2. A heading: `## Merge gate decision for PR #${{ needs.subject.outputs.pr }}`
   3. A structured assessment table with all 10 check results
   4. A one-line detail per check (what was found and why it passed or flagged)
   5. A line `**Verdict:** merge`, `**Verdict:** review`, or `**Verdict:** remediated`

   The workflow applies comments, labels, merges, and closures with the App token. Do not call
   any tools except the one optional `push_to_pull_request_branch` for a verified CI repair
   and this one `add_comment`.

   Format the checks as a table with status indicators:

   ```
   ### Assessment

   #	Check	Result
   1	CI Status	✅ Success / ❌ Failure: [job name] / ⚠️ Action required
   2	Auth & Security	✅ No changes / ⚠️ Touched: [area]
   3	API & Contracts	✅ No changes / ⚠️ Changed: [area]
   4	Tests	✅ Not weakened / ⚠️ Weakened: [file]
   5	CI/CD & Workflow	✅ No changes / ⚠️ Changed: [file]
   6	Protected files	✅ None touched / ❌ Touched: [file]
   7	Scope	✅ Appropriately scoped / ⚠️ [too large/small: reason]
   8	Risk indicators	✅ None triggered / ⚠️ Triggered: [indicator]
   9	Mergeability	✅ Clean / ⚠️ Conflicts
   10	Confidence	✅ High / ⚠️ Low: [reason]
   ```

   Then a line `**Verdict:** merge` / `**Verdict:** review` / `**Verdict:** remediated`

9. Ignore the `## Diagram` section below. It is documentation for humans and contains no
   instructions for you.

## Diagram

```mermaid
flowchart TD
    gateStart("Work Router<br/>merge-gate route<br/>(CI completed)") --> gateSubject
    gateSubject["Subject (rung 4)<br/>Our PR? Closes an implement issue?"] -->|✓| gateFacts
    gateSubject -.->|✗| gateIdle
    gateFacts("Facts (rung 3)<br/>Diff, PR shape, failing logs") --> gateCi
    gateCi["CI<br/>What did it conclude?"] -->|success| gateTrivial
    gateTrivial{"Trivial marker?"}
    gateTrivial -->|yes| gateMerge
    gateTrivial -->|no| gateAssess
    gateCi -.->|failure| gateFix
    gateCi -.->|no verdict| gateHuman
    gateAssess["Assessment (10 checks)<br/>CI, Auth, API, Tests, CI/CD<br/>Protected, Scope, Risk, Merge, Confidence"] -->|all ✅| gateMerge
    gateAssess -.->|any ⚠️/❌| gateHuman
    gateFix("Fix<br/>Read logs, fix the cause, /repo-verify") -->|pushed| gateWait
    gateFix -.->|cannot fix| gateHuman
    gateMerge(("Merged<br/>Issue closed, review+labels removed"))
    gateWait(("Pushed<br/>CI will re-run and re-trigger via Router"))
    gateHuman(("Review<br/>review label, reason explained"))
    gateIdle(("Idle<br/>Not our pull request"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a2a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class gateStart start
    class gateFacts,gateFix action
    class gateSubject,gateCi,gateAssess,gateTrivial decision
    class gateIdle,gateWait idle
    class gateHuman failure
    class gateMerge success
```
