---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-audit.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # The model this worker's own session runs on. opencode.ci.json's `model` is the cheap default
  # every agent without its own model falls back to; the lead is where a wrong call costs a run,
  # so it names its model here. `model:` below only satisfies the compiler. A repository may
  # change it to any model its opencode.ci.json declares.
  AGENT_LEAD_MODEL: "forge/glm-5-2"
  # Every harness tier (plan, build, fast) on one model the CI's Forge account is granted.
  # harness.json names quasar-438b and carina-60b, which that account is not granted: Pliny-Bot
  # #823's build tasks failed on quasar. Empty runs the tiers harness.json names.
  AGENT_TIER_MODEL: "plainconcepts/glm-5-2"
  # The fast tier alone, while the CI's Forge account is not granted carina-60b.
  AGENT_FAST_MODEL: "plainconcepts/glm-5-2"
  REPO_RULES: "Read-only repository audit. Report only reproducible, actionable defects with evidence. Do not modify files, commit, push, or run write operations."
  # Split out of REPO_RULES, which carried both the read-only discipline above and the list
  # below. All four consuming repositories had customised the list and none could touch it
  # without restating the discipline; they are different kinds of rule with different owners.
  # One line: gh-aw joins a multi-line env value onto a single line when it compiles the lock.
  AUDIT_FOCUS: "Architectural layer violations and dependencies pointing the wrong way. Missing or misleading tests around behaviour that already shipped. Security gaps: unvalidated input, missing authorization, secrets in code. Performance anti-patterns, N+1 queries in particular. Documentation that no longer matches the code it describes."
  AUDIT_MARKER: "<!-- agent-audit -->"
  # The largest issue the audit files, measured with refine's own rule (issue-size.cjs). Three
  # quarters of agent-refine.md's REFINE_MAX_BODY_CHARS and REFINE_MAX_WORK_UNITS, so a story a
  # person edits a little still refines. A body over these is trimmed before it is filed.
  AUDIT_MAX_BODY_CHARS: "6000"
  AUDIT_MAX_WORK_UNITS: "18"
  AUDIT_MAX_STORIES: "3"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Read-only repository audit. Finds 5-7 problems, scores each 1-10, and files a compact
  tracking report of every finding, labelled `audit` + `bug`, plus one story issue for each of
  the top 3, labelled `bug` + `refine` and linked to the report as sub-issues. Refine refines
  each story on its own; the report never goes to Refine. Every body is measured with refine's
  size rule before it is filed and trimmed to fit, because one issue holding every finding and
  three stories was over refine's limit every time and was refused. Replaces .loops/recipes/guardrails-audit-loop.yaml.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: trigger-kind(scheduled|manual).
  The router owns the weekly Monday schedule and manual dispatch.

  The `skip-if-match` below is backpressure, so the audit stops filing reports while three
  are still unactioned.

name: "Agent: Audit"

# Shared: network policy only. This workflow owns its Safe Outputs and OpenCode configuration.
# permissions, engine, model and runs-on cannot be shared , see shared/platform-defaults.md.
imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.87.5
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

  # Rung 1. Do not pile reports on top of unactioned reports. Only the report carries `audit`;
  # its stories do not, or one audit would fill the three slots by itself.
  #
  # `-label:stale-audit` is what keeps this backpressure from becoming a stop. Three reports
  # nobody ever actioned used to disable the weekly audit for good: the query counted them
  # forever, the run skipped with a green tick, and no report was ever filed again. The
  # janitor labels a report `stale-audit` once it has sat open past its budget, which both
  # frees the slot and lists the report in the "Needs a human" digest. Backpressure now
  # means "three live reports", not "three reports, ever".
  skip-if-match:
    query: "is:issue is:open label:audit -label:stale-audit"
    max: 3

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
      # Staged, so this is the only write: the report, then each story with its labels and a
      # link back, then the report's list of stories. Each body passes refine's size rule first.
      - name: Download agent output
        id: output
        uses: ./.github/actions/download-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
      - name: File the report and its stories
        uses: ./.github/actions/file-audit-issues
        with:
          output-file: ${{ steps.output.outputs.output-file }}
          token: ${{ steps.app-token.outputs.token }}
          max-body-chars: ${{ env.AUDIT_MAX_BODY_CHARS }}
          max-work-units: ${{ env.AUDIT_MAX_WORK_UNITS }}
          max-stories: ${{ env.AUDIT_MAX_STORIES }}
          run-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          report-labels: |-
            audit
            bug
          story-labels: |-
            bug
            refine

  # An audit that produced nothing reported success. The whole run -- a full agent, its tokens,
  # its half hour -- ended with `conclude` skipped, because that job requires a processed item,
  # and a skipped job leaves the run green. Numa's audit on 2026-09-10 did exactly that:
  # `agent_output.json` 24 bytes, `safe-output-items.jsonl` empty, every job success, no report
  # filed and nothing anywhere saying so. The next scheduled audit would have looked identical.
  #
  # This fires when the agent succeeded and the safe-outputs handler processed nothing at all.
  #
  # Step 7 of the prompt gives a clean codebase its own outcome -- call `noop` and stop -- and
  # that outcome must not be reported as a failure. `noop` is a registered safe output here
  # (`noop: max 1`), so the handler receives it as a message and the processed count is not zero,
  # which keeps a deliberately empty audit out of this branch. That is read from the handler
  # configuration rather than observed in a run: no audit in these repositories has yet emitted a
  # noop. The direct signal, `noop_message`, belongs to gh-aw's `conclusion` job, and that job
  # depends on every custom job here, so naming it is a dependency cycle and the worker will not
  # compile -- the first version of this job was rejected for exactly that.
  #
  # If a genuinely clean audit ever fails here, that is the assumption breaking, and the fix is to
  # carry the noop through a job this one can depend on rather than to widen the condition.
  empty_run:
    needs: [agent, safe_outputs]
    if: >
      needs.agent.result == 'success' &&
      needs.safe_outputs.outputs.process_safe_outputs_processed_count == '0'
    runs-on: agents-arc
    permissions:
      contents: read
    steps:
      - name: Report an audit that produced no outcome
        env:
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          echo "::error::The audit agent finished without emitting a report or a noop. The prompt requires one of the two: create_issue with the findings, or noop when the codebase is clean. Nothing was filed and no reason was given, so this run is a failure rather than a clean audit. The next scheduled audit will try again. ${RUN_URL}"
          exit 1

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  threat-detection: false
  # The report and the stories are filed by `conclude`, after they are measured.
  staged: true
  # The report and up to three stories.
  create-issue:
    max: 4

# The fleet is two machines, so this clock is also how long a stuck run can hold half of it.
# 240 went on to every worker at once when the provider was slow, which fixed the deaths and
# made every worker equally expensive to hang. These numbers are per worker: enough headroom
# for a slow gateway on the work it actually does, and not four hours for a run that reads one
# issue. Turns remain the guard against a confused agent looping; the credit ceiling meters the
# Forge models at Multiverse's list prices, set in shared/opencode-ci.md.
#
# Sweeps the repository read-only and writes one findings issue. Observed around 45 minutes.
timeout-minutes: 90
---

1. Call skill("pc-repo-audit"), then run `/repo-audit` as a read-only audit of this
   repository. Do not modify any file, do not commit, and do not push.

2. Apply repository documentation and established conventions while auditing. Focus on
   concrete defects and avoid recommendations that weaken security, tests, or checks.
   Adhere to ${{ env.REPO_RULES }}. Look for: ${{ env.AUDIT_FOCUS }}

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

   Open issues only cover what is still open, so a finding reported weeks ago and closed
   without a fix, or deliberately rejected, would come back every single run. Before scoring,
   call `memory_smart_search` for prior audits of this repository and drop any finding that
   was already reported and consciously not acted on. After you have decided what to file,
   call `memory_save` once with a compact record of this audit: the date, each finding's file
   and one-line description, and its disposition (filed, already tracked, or previously
   rejected). Keep it short; it is read by the next audit, not by a person.

   A finding you have reported before and that is genuinely still broken IS worth filing
   again. What this prevents is re-filing something the team looked at and chose to live
   with, which is the noise that makes an audit backlog get ignored.

5. File the report: call `create_issue` with title "Audit: <YYYY-MM-DD>" and nothing else in the title. Do NOT specify labels; the conclude job applies them. The report is a compact tracking list, not a story: Refine never reads it. One entry per finding, highest score first, each exactly this shape and no longer than about 600 characters:

   ```
   ### <n>. <one-line problem> (score <s>)
   **Where:** `path/to/file.ext:line`, `other/file.ext:line`
   **Problem:** One or two sentences: what happens and its impact.
   **Fix:** One or two sentences: the change that resolves it.
   ```

   No bullet lists, no Gherkin, no user stories, no reproduction walkthroughs. Do not write any issue number (`#123`) in the report: the workflow adds the links to the stories, and every number in it is read as work the report waits on.

6. File the stories: call skill("pc-plan-story") and write the top ${{ env.AUDIT_MAX_STORIES }} findings by score as user stories; that skill owns their shape. Call `create_issue` once per story, after the report, titled with the story's own title (never "Audit: ..."), no labels. Refine refines each story on its own, so each must stand alone: it names its own files and its own acceptance criteria, never "as above" or "see finding 2", and never mentions the other stories or the report. Keep each story well under ${{ env.AUDIT_MAX_BODY_CHARS }} characters and ${{ env.AUDIT_MAX_WORK_UNITS }} bullet lines: the workflow measures every issue against that limit before filing and cuts anything over it from the end.

7. If nothing met the bar, call `noop` and stop. Filing nothing is the right outcome when
   the codebase is clean.
