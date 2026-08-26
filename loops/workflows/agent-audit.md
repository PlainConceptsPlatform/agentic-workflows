---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-audit.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  REPO_RULES: "Read-only repository audit. Report only reproducible, actionable defects with evidence. Look for: architectural layer violations, missing tests, security gaps, performance issues, and documentation drift. Do not modify files, commit, push, or run write operations."
  AUDIT_MARKER: "<!-- agent-audit -->"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Read-only repository audit. Finds 5-7 problems, scores each 1-10, files a single issue
  with all findings listed and the top 3 refined as actionable user stories. The issue is
  labelled `audit` + `bug` + `implement`. Replaces .loops/recipes/guardrails-audit-loop.yaml.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: trigger-kind(scheduled|manual).
  The router owns the weekly Monday schedule and manual dispatch.

  The `skip-if-match` below is backpressure, so the audit stops filing reports while three
  are still unactioned.

name: "Agent: Audit"

# Shared: network policy only. This workflow owns its Safe Outputs and OpenCode configuration.
# permissions, engine, model and runs-on cannot be shared , see shared/platform-defaults.md.
imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.86.2
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      trigger-kind:
        description: "Audit trigger: scheduled or manual"
        required: false
        type: string
        default: manual

  # Rung 1. Do not pile reports on top of unactioned reports.
  skip-if-match:
    query: "is:issue is:open label:audit"
    max: 3

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

max-turns: 300
max-turn-cache-misses: 3000
max-ai-credits: 5000

permissions: read-all

steps:
  - name: List what is already tracked
    uses: ./.github/actions/list-open-issues
    with:
      token: ${{ github.token }}
      repo: ${{ github.repository }}

jobs:
  conclude:
    needs: [activation, agent, safe_outputs]
    if: >
      needs.agent.result == 'success' &&
      needs.safe_outputs.result == 'success' &&
      needs.safe_outputs.outputs.process_safe_outputs_processed_count != '0'
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
      - name: Apply agent output
        id: agent-output
        uses: ./.github/actions/apply-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
          token: ${{ steps.app-token.outputs.token }}
          create-issues: 'true'
      - name: Apply audit labels to created issues
        if: steps.agent-output.outputs.first-issue-number != ''
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ steps.agent-output.outputs.first-issue-number }}
          labels: |
            audit
            bug
            implement

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  staged: true
  threat-detection: false
  create-issue:
    max: 1
  add-comment:


timeout-minutes: 45
---

1. Call skill("pc-repo-audit"), then run `/repo-audit` as a read-only audit of this
   repository. Do not modify any file, do not commit, and do not push.

  2. Apply repository documentation and established conventions while auditing. Focus on
     concrete defects and avoid recommendations that weaken security, tests, or checks.
     Adhere to ${{ env.REPO_RULES }}.

    From the audit report, find **5 to 7 problems**. For each finding, verify it meets ALL
   of these criteria before keeping it:
   - A specific, reproducible problem in a specific file or component.
   - Has real impact: security risk, data loss, crash, or broken functionality.
   - Something a developer could pick up and fix without further investigation.
   Discard anything vague, stylistic, theoretical, or nice-to-have. If you cannot find 5 that
   meet this bar, file as many as you can. If you find zero, call `noop` and stop , that is a
   good result.

3. **Score each surviving finding from 1 to 10**, based on:
   | Factor | Weight |
   |---|---|
   | Severity (how bad is the impact?) | high |
   | Likelihood (how often does it trigger?) | medium |
   | Blast radius (how many users/components affected?) | medium |
   | Ease of fix (can it be fixed in one PR?) | low bonus |

   Write the score next to each finding in your reasoning.

4. Read `/tmp/gh-aw/agent/open-issues.json`, which lists every open issue with its title and
   labels. Discard any finding already tracked there. Exact-title duplicates are rejected for
   you; your job is the ones worded differently that mean the same thing.

5. Call `create_issue` **once** with title "Audit: <date>". Do NOT specify labels , the
   conclude job will apply them. The body MUST have two sections:

   **Section 1 , All findings:** A numbered list of every finding (5-7) with its score,
   file path, and a one-line description. Order by score descending.

   **Section 2 , Top 3 to implement:** Call skill("pc-plan-story") and refine the top 3
   findings by score into user stories in Mike Cohn's As a / I want to / so that format
   with Given/When/Then acceptance criteria, edge cases, and likely files to change. Mark
   this section clearly with a heading like `## Top 3 , To Implement`.

6. If nothing met the bar, call `noop` and stop. Filing nothing is the right outcome when
   the codebase is clean.

## Diagram

```mermaid
flowchart TD
    auditStart("Work Router<br/>audit route<br/>(Mondays or dispatch)") --> auditBackpressure
    auditBackpressure["Backpressure (rung 1)<br/>Fewer than 3 open reports?"] -->|✓| auditTracked
    auditBackpressure -.->|✗| auditIdle
    auditTracked("Tracked (rung 3)<br/>Open issue titles to disk") --> auditRun
    auditRun("Audit<br/>/repo-audit, read-only") -->|✓| auditTriage
    auditRun -.->|✗| auditFail
    auditTriage["Triage<br/>Find 5-7 problems, score 1-10, dedupe"] -->|✓| auditPropose
    auditTriage -.->|nothing found| auditQuiet
    auditPropose("Propose<br/>Single issue: all findings + top 3 refined") -->|✓| auditReport
    auditPropose -.->|✗| auditFail
    auditReport(("Conclude<br/>audit+bug+implement on single issue"))
    auditQuiet(("Quiet<br/>Nothing actionable, nothing proposed"))
    auditIdle(("Idle<br/>Reports still awaiting action"))
    auditFail(("Fail<br/>Audit or proposal failed"))
    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a2a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class auditStart start
    class auditTracked,auditRun,auditPropose action
    class auditBackpressure,auditTriage decision
    class auditQuiet,auditIdle idle
    class auditFail failure
    class auditReport success
```
