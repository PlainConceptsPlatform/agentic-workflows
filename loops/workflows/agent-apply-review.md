---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-apply-review.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  REPO_RULES: "Apply only actionable outstanding reviewer feedback to the selected bot pull request. Make minimal changes that address each comment. Preserve architecture and do not weaken tests. Run full verification after changes."
  WORKING_LABEL: bot-working
  REVIEW_LABEL: review
  REVIEW_MARKER: "<!-- agent-apply-review -->"
  INCOMPLETE_COMMENT: "Automated review feedback ended without an outcome. The issue remains for a retry."
  ISSUE_CONTEXT_PATH: /tmp/gh-aw/agent/issue-context.json
  GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Applies reviewer feedback to an open pull request the bot authored, then pushes the fixes to
  the same branch. Called by the Work Router; does not trigger on public events.

  `target: triggering` is enough for the push here, so unlike the merge gate this needs no
  wildcard fetch: the event is the pull request and gh-aw has already checked out its head.

name: "Agent: Apply Review"

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
        description: Pull request number to apply review feedback on.
        required: true
        type: string
      linked-issue:
        description: Issue number the pull request closes. May be empty.
        required: false
        type: string

# Rung 4. Router has classified the event; this job validates PR ownership and checks for
# substantive feedback. A custom job, not `on.steps`, because the prompt needs these values.
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
      unresolved: ${{ steps.subject.outputs.unresolved }}
    steps:
      - name: Confirm this is our pull request and the feedback is substantive
        id: subject
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ inputs.pr-number }}
          LINKED_ISSUE: ${{ inputs.linked-issue }}
        run: |
          set -euo pipefail

          none() {
            echo "found=false" >> "$GITHUB_OUTPUT"
            echo "$1"
            exit 0
          }

          pr=$(gh pr view "$PR" --repo "$REPO" --json number,state,author,title,body)
          [ "$(printf '%s' "$pr" | jq -r '.state')" = "OPEN" ] || none "PR #$PR is not open"

          # Use GitHub's bot flag because App login formats differ across APIs.
          author=$(printf '%s' "$pr" | jq -r '.author.login')
          is_bot=$(printf '%s' "$pr" | jq -r '.author.is_bot')
          [ "$is_bot" = "true" ] || \
            none "PR #$PR was authored by $author, a human. Never push to a human's branch."

          # The issue this pull request closes, preferring the router-provided linked issue.
          if [ -n "$LINKED_ISSUE" ]; then
            issue="$LINKED_ISSUE"
          else
            issue=$(printf '%s' "$pr" | jq -r '.body // ""' \
                      | grep -oiE '(close[sd]?|fixe?[sd]?|resolve[sd]?) +#[0-9]+' \
                      | grep -oE '[0-9]+' | head -n 1 || true)
          fi

          # Unresolved review threads, from the API rather than from the model's reading of it.
          unresolved=$(gh api graphql -f query='
            query($owner:String!, $name:String!, $number:Int!) {
              repository(owner:$owner, name:$name) {
                pullRequest(number:$number) {
                  reviewThreads(first:100) { nodes { isResolved isOutdated } }
                }
              }
            }' \
            -f owner="${REPO%/*}" -f name="${REPO#*/}" -F number="$PR" \
            --jq '[.data.repository.pullRequest.reviewThreads.nodes[]
                   | select(.isResolved == false and .isOutdated == false)] | length')

          {
            echo "found=true"
            echo "pr=$PR"
            echo "issue=${issue:-}"
            echo "unresolved=$unresolved"
           } >> "$GITHUB_OUTPUT"
           echo "PR #$PR has $unresolved unresolved thread(s)"

  reserve:
    needs: subject
    if: needs.subject.outputs.found == 'true' && needs.subject.outputs.issue != ''
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
      - name: Mark the linked issue as in progress
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Clear the human-needed flag
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
  validate_output:
    needs: [activation, subject, agent, safe_outputs]
    if: always() && needs.agent.result == 'success' && needs.safe_outputs.result == 'success'
    runs-on: agents-arc
    permissions:
      contents: read
      pull-requests: read
    outputs:
      valid: ${{ steps.validate.outputs.valid }}
      outcome: ${{ steps.validate.outputs.outcome }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - id: output
        uses: ./.github/actions/download-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
      - name: Load unresolved review threads
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ needs.subject.outputs.pr }}
        run: |
          set -euo pipefail
          gh api graphql -f query='
            query($owner:String!, $name:String!, $number:Int!) {
              repository(owner:$owner, name:$name) {
                pullRequest(number:$number) {
                  reviewThreads(first:100) { nodes { id isResolved isOutdated } }
                }
              }
            }' -f owner="${REPO%/*}" -f name="${REPO#*/}" -F number="$PR" \
            --jq '.data.repository.pullRequest.reviewThreads.nodes' > /tmp/review-threads.json
      - id: validate
        uses: ./.github/actions/validate-review-output
        with:
          output-file: ${{ steps.output.outputs.output-file }}
          pr-number: ${{ needs.subject.outputs.pr }}
          review-threads-file: /tmp/review-threads.json
  conclude:
    needs: [activation, subject, agent, safe_outputs, validate_output]
    if: >
      needs.agent.result == 'success' &&
      needs.safe_outputs.result == 'success' &&
      needs.validate_output.outputs.valid == 'true'
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
      - name: Apply agent output
        uses: ./.github/actions/apply-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
          token: ${{ steps.app-token.outputs.token }}
          push-to-branch: 'true'
          apply-labels: 'false'
      - name: Release implemented review
        if: needs.validate_output.outputs.outcome == 'implemented'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag review outcome
        if: needs.validate_output.outputs.outcome != 'implemented'
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Release review outcome
        if: needs.validate_output.outputs.outcome != 'implemented'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
  incomplete:
    needs: [subject, agent, safe_outputs, validate_output]
    if: >
      always() &&
      needs.subject.outputs.found == 'true' &&
      (needs.agent.result != 'success' || needs.safe_outputs.result != 'success' || needs.validate_output.outputs.valid != 'true')
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
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag for human review
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.REVIEW_LABEL }}
      - name: Report missing review feedback outcome
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.REVIEW_MARKER }}
            ${{ env.INCOMPLETE_COMMENT }}
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})

if: needs.subject.outputs.found == 'true'

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

# Rung 3. A reviewer often makes one point across several comments, so the agent needs the
# whole conversation, not just the one that triggered it. Fetching all of it is deterministic.
steps:
  - name: Load the issue context
    uses: ./.github/actions/load-issue-context
    with:
      token: ${{ github.token }}
      issue-number: ${{ needs.subject.outputs.issue }}
      output-path: ${{ env.ISSUE_CONTEXT_PATH }}
  - name: Fetch the whole review conversation and the diff
    env:
      GH_TOKEN: ${{ github.token }}
      REPO: ${{ github.repository }}
      PR: ${{ inputs.pr-number }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh pr diff "$PR" --repo "$REPO" > /tmp/gh-aw/agent/diff.patch
      gh api "repos/$REPO/pulls/$PR/comments" --paginate \
        --jq '[.[] | {id, path, line, author: .user.login, body, in_reply_to_id}]' \
        > /tmp/gh-aw/agent/review-comments.json
      gh api "repos/$REPO/issues/$PR/comments" --paginate \
        --jq '[.[] | {author: .user.login, body}]' \
        > /tmp/gh-aw/agent/conversation.json
      gh api graphql -f query='
        query($owner:String!, $name:String!, $number:Int!) {
          repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
                  reviewThreads(first:100) {
                  nodes { id
                  isResolved isOutdated path
                  comments(first:50) { nodes { author { login } body } }
                }
              }
            }
          }
        }' \
        -f owner="${REPO%/*}" -f name="${REPO#*/}" -F number="$PR" \
        --jq '.data.repository.pullRequest.reviewThreads.nodes' \
        > /tmp/gh-aw/agent/review-threads.json

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  staged: true
  threat-detection: false
  push-to-pull-request-branch:
  add-comment:
    target: "*"


timeout-minutes: 45
---

1. You are applying review feedback to pull request
   **#${{ needs.subject.outputs.pr }}**, which has
   **${{ needs.subject.outputs.unresolved }}** unresolved review thread(s).

   It has already been confirmed that this pull request is open, that we authored it, and that
   the reviewer has write access. Do not re-check any of that.

2. Read `${{ env.ISSUE_CONTEXT_PATH }}`. It contains the issue body and discussion this pull
   request closes. The acceptance criteria there define what the implementation must still
   satisfy after the feedback is applied.

3. Read the whole conversation, not just the comment that triggered you. It is already on disk:

   - `/tmp/gh-aw/agent/review-threads.json` , every thread with its resolved and outdated state
   - `/tmp/gh-aw/agent/review-comments.json` , every inline comment with its file and line
   - `/tmp/gh-aw/agent/conversation.json` , every conversation comment
   - `/tmp/gh-aw/agent/diff.patch` , the current diff

   A reviewer often makes one point across several comments. Applying them one at a time
   produces contradictory commits, so read everything before changing anything.

4. Work out which items are genuinely actionable and still outstanding. Skip anything already
   addressed by a later commit, anything a bot wrote, anything from the pull request author,
   and anything that is a question rather than a request. You must account for every unresolved
   human review thread by its `PRRT_...` ID. Do not claim feedback was implemented when no branch
   change is needed: that requires reviewer confirmation.

 5. Load only skills required by the feedback, then apply it. Make only changes the feedback
    justifies: a review comment is not licence for unrelated refactoring. Never read outside this
     repository root. Follow repository documentation and established conventions. Keep changes
     focused, protect secrets, and do not modify generated files unless the feedback requires it.
     Adhere to ${{ env.REPO_RULES }}.

 6. Run the repository verification commands below. The issue context at
    `${{ env.ISSUE_CONTEXT_PATH }}` defines acceptance criteria the fix must satisfy. If a check
    fails, fix what you broke and run it again. Do not push a branch that does not pass.

     ```
     ${{ env.VERIFY_COMMANDS }}
     ```

7. Select one review outcome.

   - **implemented**: You made the requested change, verification passed, and you will propose
     exactly one `push_to_pull_request_branch`.
   - **already-satisfied**: The current branch already satisfies the request. Do not push; the
     reviewer must confirm this assessment.
   - **needs-human**: The feedback is ambiguous, unsafe, or cannot be applied. Do not push.

8. Emit exactly one `add_comment` on PR `${{ needs.subject.outputs.pr }}`. Include every
   unresolved human review thread ID and an explanation for it, then exactly one line:
   `**Review outcome:** implemented`, `**Review outcome:** already-satisfied`, or
   `**Review outcome:** needs-human`.

9. Do not merge, close, or change labels. The workflow validates your outcome and owns those
   state transitions.

10. Ignore the `## Diagram` section below. It is documentation for humans and contains no
    instructions for you.

## Diagram

```mermaid
flowchart TD
    fbStart("Work Router<br/>apply-review route<br/>(review on bot PR)") --> fbSubject
    fbSubject["Subject (rung 4)<br/>Our open PR? Substantive review?"] -->|✓| fbFacts
    fbSubject -.->|✗| fbIdle
    fbFacts("Facts (rung 3)<br/>Threads, comments, diff to disk") --> fbTriage
    fbTriage["Triage<br/>Anything actionable and outstanding?"] -->|✓| fbReserve
    fbTriage -.->|nothing| fbIdle
    fbReserve("Reserve<br/>Propose bot-working on the issue") -->|✓| fbApply
    fbApply("Apply<br/>Only what the feedback justifies") -->|✓| fbVerify
    fbApply -.->|✗| fbFail
    fbVerify["Verify<br/>/repo-verify passes?<br/>↻"] -->|✓| fbPush
    fbVerify -.->|✗| fbApply
    fbPush(("Pushed<br/>Same branch, bot-working removed"))
    fbIdle(("Idle<br/>Not ours, or nothing to do"))
    fbFail(("Fail<br/>review added, bot-working removed"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class fbStart start
    class fbFacts,fbReserve,fbApply action
    class fbSubject,fbTriage,fbVerify decision
    class fbIdle idle
    class fbFail failure
    class fbPush success
```
