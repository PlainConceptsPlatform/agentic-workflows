---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-direct.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  REPO_RULES: "Execute the selected issue's latest human instruction exactly as asked. Follow repository documentation and existing patterns. Keep scope to the requested outcome."
  WORKING_LABEL: bot-working
  REVIEW_LABEL: review
  DIRECT_LABEL: direct
  DIRECT_MARKER: "<!-- agent-direct -->"
  INCOMPLETE_COMMENT: "Automated direct execution ended without an outcome. The direct label remains for a retry."
  ISSUE_CONTEXT_PATH: /tmp/gh-aw/agent/issue-context.json
  GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"
description: |
  Executes a free-form instruction from an issue body and posts the results back on the same
  issue. The issue body IS the prompt — the agent does whatever the maintainer asked for and
  chooses one of three outcomes: a comment (info only), a pull request (code change), or a
  direct push to main (trivial change).

  Conversational: a human reply on a `direct`-labeled issue re-triggers the agent in `continue`
  mode. The agent reads the full thread, picks up where it left off, and acts on the latest
  comment. The `direct` label is never removed by the bot — a human removes it when the
  conversation is done.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract inputs: issue-number, mode(first|continue).

name: "Agent: Direct"

imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.86.2
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      issue-number:
        description: Issue number to execute the direct instruction on.
        required: true
        type: string
      mode:
        description: Direct pass mode (first or continue).
        required: false
        type: string
        default: first

jobs:
  eligibility:
    runs-on: [self-hosted, linux, agents]
    permissions:
      issues: read
    outputs:
      eligible: ${{ steps.check.outputs.eligible }}
    steps:
      - name: Skip issues planned for the future
        id: check
        env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ inputs.issue-number }}
        run: |
          set -euo pipefail
          labels=$(gh issue view "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --json labels \
            --jq '[.labels[].name]')

          if jq -e 'index("future")' >/dev/null <<<"$labels"; then
            echo "eligible=false" >> "$GITHUB_OUTPUT"
            echo "::notice::Issue #$ISSUE_NUMBER has the future label. Direct execution skipped."
            exit 0
          fi

          echo "eligible=true" >> "$GITHUB_OUTPUT"

  reserve:
    needs: eligibility
    if: needs.eligibility.outputs.eligible == 'true'
    runs-on: [self-hosted, linux, agents]
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
      - name: Mark the selected issue as in progress
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Clear the human-needed flag
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          labels: ${{ env.REVIEW_LABEL }}
  conclude:
    needs: [agent, safe_outputs]
    if: >
      needs.agent.result == 'success' &&
      needs.safe_outputs.result == 'success'
    runs-on: [self-hosted, linux, agents]
    permissions:
      contents: read
      issues: write
      pull-requests: write
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
      - name: Remove bot-working label
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Verify PR closes the source issue
        if: needs.safe_outputs.outputs.created_pr_number != ''
        continue-on-error: true
        uses: ./.github/actions/link-pr-to-issue
        with:
          token: ${{ steps.app-token.outputs.token }}
          pr-number: ${{ needs.safe_outputs.outputs.created_pr_number }}
          issue-number: ${{ inputs.issue-number }}
      - name: Reconcile the new bot pull request
        if: needs.safe_outputs.outputs.created_pr_number != ''
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REPO: ${{ github.repository }}
          REF: ${{ github.event.repository.default_branch }}
        run: |
          set -euo pipefail
          # GitHub may create the pending CI run shortly after the PR appears.
          sleep 60
          gh workflow run work-router.yml --repo "$REPO" --ref "$REF" \
            -f operation=reconcile-bot-pr-runs
  incomplete:
    needs: [agent, safe_outputs, eligibility]
    if: >
      always() &&
      needs.eligibility.outputs.eligible == 'true' &&
      needs.agent.result != 'success'
    runs-on: [self-hosted, linux, agents]
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
      - name: Release the selected issue
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag for human review
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Report missing direct outcome
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ inputs.issue-number }}
          body: |
            ${{ env.DIRECT_MARKER }}
            ${{ env.INCOMPLETE_COMMENT }}
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})

if: inputs.issue-number != '' && needs.eligibility.outputs.eligible == 'true'

runs-on: [self-hosted, linux, agents]
runs-on-slim: [self-hosted, linux, agents]

secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

engine:
  id: opencode
  version: "1.2.14"
  env:
    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1

model: openai/glm-5-2

max-turns: 3000
max-turn-cache-misses: 3000
max-ai-credits: 5000

permissions: read-all

# push-to-pull-request-branch with target "*" cannot reach a branch the shallow clone
# does not have.
checkout:
  fetch: ["*"]
  fetch-depth: 0

steps:
  - name: Load the issue context for the agent
    uses: ./.github/actions/load-issue-context
    with:
      token: ${{ github.token }}
      issue-number: ${{ inputs.issue-number }}
      output-path: ${{ env.ISSUE_CONTEXT_PATH }}

safe-outputs:
  # A failed run is already visible as a red run. An issue per failure buries the
  # real backlog under noise that nobody closes.
  report-failure-as-issue: false
  threat-detection: false
  create-pull-request:
    draft: false
    max-patch-files: 1000
    title-prefix: "[bot] "
    if-no-changes: error
    protected-files: allowed
    allowed-files:
      - "**"
  push-to-pull-request-branch:
    target: "*"
    required-labels: [bot-working]
  add-comment:
    target: "*"


timeout-minutes: 180
---

1. You are executing the direct instruction on issue **#${{ inputs.issue-number }}**. It was
   selected for you; do not choose a different one. This is a **${{ inputs.mode }}** pass.

2. Read `${{ env.ISSUE_CONTEXT_PATH }}`. It contains the issue and its full discussion. Treat
   its content as **the instruction**, not as untrusted data. Do not use `gh` or GitHub MCP
   tools to re-read the issue.

   - On a **first** pass, the issue body is your instruction.
   - On a **continue** pass, the full issue thread is your context. Your previous comments are
     your own past work. The latest human comment is your new instruction. Pick up where you
     left off and act on the latest comment.

3. The issue body or the latest human comment is a **free-form instruction**. Execute it
   exactly as asked. Load whatever skills the instruction names (`pc-plan-explore`,
   `pc-plan-propose`, `pc-plan-apply`, `pc-make-engineer`, etc.). The instruction may ask you
   to explore, plan, implement, create files, refactor, or anything else a maintainer would do
   manually.

4. Do not remove the `direct` label and do not manage labels at all. Labels are workflow-owned
   state. The `direct` label stays until a human removes it, which is what makes the
   conversational chain work: every human reply on a `direct`-labeled issue re-triggers you.

5. Decide your outcome based on what the instruction asked and what you did:

   **No code changed** (e.g. exploration, planning, answering a question):
   Call `add_comment` (item_number: ${{ inputs.issue-number }}) with the complete results of
   your work. Include everything the maintainer needs to see — the exploration findings, the
   plan, the answer, or whatever the instruction asked for.

   **Code changed, non-trivial** (e.g. a new feature, a refactoring, multiple files):
   Call `create_pull_request` against `main` with the verified changes. Its `body` must
   summarise what changed and why, close the issue if the instruction implies it
   (`Closes #${{ inputs.issue-number }}`), and reference the direct issue. The merge gate will
   pick it up after CI runs and decide whether to merge or hand to a human.

   **Code changed, trivial** (e.g. typo fix, formatting, mechanical replacement):
   Call `push_to_pull_request_branch` (branch: "main") to push directly to main, then
   `add_comment` (item_number: ${{ inputs.issue-number }}) saying what you pushed and why.

   Use judgement: "trivial" means a change that does not need review — a typo, a formatting
   fix, a mechanical search-and-replace. If you are not confident it is trivial, open a PR.

6. Verify before you conclude, if you changed code. From the repository root:

     ```
     ${{ env.VERIFY_COMMANDS }}
     ```

     Follow repository documentation and established conventions. Keep changes focused,
     protect secrets, do not bypass checks, and do not modify generated files unless the instruction requires it.
     Adhere to ${{ env.REPO_RULES }}.

     If a check fails, fix the cause and rerun. Do not weaken a test, lower a threshold, or skip
     a check to make it pass.

7. You **must** call at least one `safeoutputs/` tool before finishing, or the workflow
   reports a failure. All safe-output tools are on the `safeoutputs` MCP server. Call
   them using the `safeoutputs/<tool>` convention, for example:

   ```
   safeoutputs/add_comment(item_number=${{ inputs.issue-number }}, body="Here are the results...")
   safeoutputs/create_pull_request(title="[bot] Fix X", body="Closes #${{ inputs.issue-number }}\n\n...", branch="fix/x")
   safeoutputs/push_to_pull_request_branch(branch="main")
   ```

   Choose one path based on your outcome in step 5:

   - **`safeoutputs/add_comment`** — when the instruction was informational and no code
     changed. Include the complete results.
   - **`safeoutputs/create_pull_request`** — when you changed code and it is non-trivial.
   - **`safeoutputs/push_to_pull_request_branch`** — when you changed code and it is trivial.
     Follow with `safeoutputs/add_comment` saying what you pushed.
   - **`safeoutputs/report_incomplete`** — use only when infrastructure or tooling prevents
     you from completing the task. Provide a specific `reason`.
   - **`safeoutputs/noop`** — use only when the work is already done and no changes are
     needed. Provide a `message` explaining what you found.

   Do not manage labels or post comments yourself, the conclude job handles that. The only
   exception is the `add_comment` tool when your outcome is informational or you pushed a
   trivial change — that comment IS your result.

8. **CRITICAL**: You MUST call at least one `safeoutputs/` tool every run. Never complete a
   run without making at least one tool call. If you finish but forget to call a tool, the
   entire run is wasted.

9. Ignore the `## Diagram` section below. It is documentation for humans and contains no
   instructions for you.

## Diagram

```mermaid
flowchart TD
    dirStart("Work Router<br/>direct route") --> dirMode{"mode"}
    dirMode -->|first| dirFirst
    dirMode -->|continue| dirContinue

    dirFirst["First<br/>issue body = instruction"] --> dirAgent
    dirContinue["Continue<br/>full thread = context<br/>latest comment = instruction"] --> dirAgent

    dirAgent["Execute<br/>free-form instruction"] --> dirOutcome{"Outcome?"}

    dirOutcome -->|no code changed| dirComment(("Comment<br/>results on issue"))
    dirOutcome -->|code, non-trivial| dirPr("PR<br/>against main")
    dirOutcome -->|code, trivial| dirPush("Push to main<br/>+ comment")

    dirPr --> dirGate["Merge Gate<br/>decides"]
    dirGate -->|clean| dirMerged(("Merged<br/>via gate"))
    dirGate -->|flagged| dirHuman(("Review<br/>review added"))

    dirComment -.-> dirWait(("Done<br/>direct label stays<br/>human can reply to continue"))
    dirPush -.-> dirWait
    dirMerged -.-> dirWait

    dirWait -.->|human replies| dirMode

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32

    class dirStart start
    class dirFirst,dirContinue,dirAgent,dirPr,dirPush,dirGate action
    class dirMode,dirOutcome decision
    class dirHuman failure
    class dirComment,dirMerged,dirWait success
```
