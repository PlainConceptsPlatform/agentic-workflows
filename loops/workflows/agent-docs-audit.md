---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-docs-audit.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # The model this worker's own session runs on. See agent-audit.md for why it names one.
  AGENT_LEAD_MODEL: "forge/glm-5-2"
  # Every harness tier on one model the CI's Forge account is granted; see agent-audit.md.
  AGENT_TIER_MODEL: "plainconcepts/glm-5-2"
  AGENT_FAST_MODEL: "plainconcepts/glm-5-2"
  REPO_RULES: "Read-only documentation audit. Report only stale documentation you can prove with evidence from both the document and the code. Do not modify files, commit, push, or run write operations."
  # What this repository counts as its entry documents, and what the scan leaves out. Archives,
  # parked material and generated documents belong in the exclusions: a broken link in a record
  # of the past is not drift.
  DOCS_AUDIT_ENTRY_DOCS: "README.md,ARCHITECTURE.md,AGENTS.md,CLAUDE.md,CONTRIBUTING.md,docs/README.md"
  DOCS_AUDIT_EXCLUDE: ".github/workflows/,.agents/,.claude/,.opencode/,node_modules/"
  DOCS_AUDIT_FOCUS: "Components, modules or bounded contexts the documents list against the ones that exist. Counts that no longer hold. Infrastructure, hosting or tooling that was retired but is still described. Workflows, scripts and commands that no longer exist. Decisions superseded in practice that still read as current. Two documents stating the same fact differently."
  # The Platform documentation standard, read before the agent starts. A repository that keeps
  # its own may point this elsewhere. Empty skips the structure check.
  DOCS_STANDARD_URL: "https://raw.githubusercontent.com/PlainConceptsPlatform/foundations/main/ai/DOCUMENTATION.md"
  # No commit in this many days means nothing can have drifted since the last run, so a scheduled
  # run stops before the model starts. 17 is the longest gap between runs on days 1 and 15.
  DOCS_AUDIT_QUIET_DAYS: "17"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Read-only documentation audit. Checks that the repository's documentation still matches its
  code and the Platform documentation standard. When it does not, files a single issue of
  findings with evidence from both sides, labelled `docs-audit` + `refine`, so Refine sizes it
  and splits it into one issue per finding. When the documentation is current, files nothing.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: trigger-kind(scheduled|manual).
  The router owns the fortnightly schedule and manual dispatch.

  The `skip-if-match` below is backpressure: one unactioned report is enough, because a second
  one would mostly restate the first.

name: "Agent: Docs Audit"

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
        description: "Docs audit trigger: scheduled or manual"
        required: false
        type: string
        default: manual

  # Rung 1. `-label:stale-audit` keeps this from becoming a stop: audit-close labels a report
  # nobody actioned, which frees the slot and lists it in the "Needs a human" digest. Without it
  # one abandoned report would disable this worker for good, with a green run every fortnight.
  skip-if-match:
    query: "is:issue is:open label:docs-audit -label:stale-audit"
    max: 1

  # gh-aw folds the top-level `if:` into activation without depending on the job it reads, so
  # the reference would resolve to '' and the agent would never run.
  needs: [recent_commits]

if: needs.recent_commits.outputs.changed == 'true'

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

max-turns: 150
max-turn-cache-misses: 1500
max-ai-credits: 2500

permissions: read-all

steps:
  - name: List what is already tracked
    uses: ./.github/actions/list-open-issues
    with:
      token: ${{ github.token }}
      repo: ${{ github.repository }}
  - name: Collect documentation drift
    uses: ./.github/actions/collect-doc-drift
    with:
      entry-docs: ${{ env.DOCS_AUDIT_ENTRY_DOCS }}
      exclude: ${{ env.DOCS_AUDIT_EXCLUDE }}
  # Fetched here rather than by the agent, whose network is closed. A standard that cannot be
  # read costs the structure check, not the run: the prompt says to report it.
  - name: Fetch the documentation standard
    env:
      STANDARD_PATH: /tmp/gh-aw/agent/documentation-standard.md
    run: |
      set -uo pipefail
      mkdir -p "$(dirname "$STANDARD_PATH")"
      if [ -n "$DOCS_STANDARD_URL" ] && curl -fsSL --max-time 30 "$DOCS_STANDARD_URL" -o "$STANDARD_PATH"; then
        echo "Read the documentation standard from $DOCS_STANDARD_URL"
      else
        rm -f "$STANDARD_PATH"
        echo "::warning::No documentation standard could be read from '${DOCS_STANDARD_URL}'. The audit runs without its structure check."
      fi

jobs:
  # The cheap exit. A repository with no commits since the last run cannot have drifted, and a
  # full agent run to say so would hold half of a two-machine fleet. A dispatch always runs: a
  # person asking for an audit has a reason.
  recent_commits:
    runs-on: agents-arc
    timeout-minutes: 5
    permissions:
      contents: read
    outputs:
      changed: ${{ steps.commits.outputs.changed }}
    steps:
      - name: Count recent commits on the default branch
        id: commits
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          TRIGGER_KIND: ${{ inputs.trigger-kind }}
          QUIET_DAYS: ${{ env.DOCS_AUDIT_QUIET_DAYS }}
        run: |
          set -uo pipefail
          if [ "$TRIGGER_KIND" != "scheduled" ]; then
            echo "changed=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          since="$(date -u -d "${QUIET_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
          # An unanswered API call must not read as "nothing changed": that is a green run that
          # audited nothing. Run the audit instead.
          if ! commits="$(gh api "repos/${REPO}/commits?since=${since}&per_page=1" --jq 'length')"; then
            echo "::warning::Could not list recent commits; running the audit anyway."
            commits=1
          fi
          if [ "$commits" = "0" ]; then
            echo "No commits since ${since}: nothing can have drifted, so the agent does not run."
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

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
      # The safe_outputs job already created the issue. Only the labels are left, and they are
      # applied with the App token so that `refine` reaches the router as a trusted event.
      - name: Apply labels to the report
        if: needs.safe_outputs.outputs.created_issue_number != ''
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.safe_outputs.outputs.created_issue_number }}
          labels: |
            docs-audit
            refine

  # An agent that ended without a report or a noop would otherwise be a green run that audited
  # nothing; see the same job in agent-audit.md.
  empty_run:
    needs: [agent, safe_outputs]
    if: >
      needs.agent.result == 'success' &&
      needs.safe_outputs.outputs.process_safe_outputs_processed_count == '0'
    runs-on: agents-arc
    permissions:
      contents: read
    steps:
      - name: Report a docs audit that produced no outcome
        env:
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          echo "::error::The docs audit agent finished without emitting a report or a noop. Nothing was filed and no reason was given, so this run is a failure rather than a clean audit. ${RUN_URL}"
          exit 1

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog.
  report-failure-as-issue: false
  threat-detection: false
  create-issue:
    max: 1

# Reads documents and the code they describe, and writes one issue. Unobserved so far: audit, the
# nearest worker, takes about 45 minutes over a whole repository, and this one reads less.
timeout-minutes: 60
---

1. This is a read-only documentation audit. Do not modify any file, do not commit, and do not
   push. Adhere to ${{ env.REPO_RULES }}.

2. Read the facts already collected for you, so you do not re-derive them:
   - `/tmp/gh-aw/agent/doc-drift.json`: `brokenLinks` and `missingPaths`, each with its file and
     line, plus `missingEntryDocuments`. These are established; do not check them again.
   - `/tmp/gh-aw/agent/documentation-standard.md`: the Platform documentation standard. If this
     file does not exist, skip step 4 and say so in one line of the report.
   - `/tmp/gh-aw/agent/open-issues.json`: every open issue with its title and labels.

3. Read the entry documents in `doc-drift.json`, then compare what they state with the code.
   Look for: ${{ env.DOCS_AUDIT_FOCUS }}

   Every finding needs evidence on both sides: the document's `file:line` and what it says, and
   the `file:line` or directory that shows otherwise. A claim you cannot back with both is not a
   finding. Prefer what misleads a reader acting on it over what is merely imprecise, and do not
   report style, tone or missing polish.

4. Compare the repository's documentation structure with the standard. Report a required
   section that is missing, or that exists and is empty. A section the standard marks as not
   applicable to this kind of repository is not a finding.

5. Group the broken links and missing paths from step 2 into findings by document or by cause,
   such as one renamed directory, rather than one finding per link. State their counts as they
   appear in `doc-drift.json`.

6. Discard any finding already tracked in `open-issues.json`. Exact-title duplicates are rejected
   for you; your job is the ones worded differently that mean the same thing.

   Before filing, call `memory_smart_search` for prior documentation audits of this repository
   and drop any finding that was reported and consciously not acted on. After you have decided
   what to file, call `memory_save` once with the date and, for each finding, its file, a
   one-line description and its disposition. Keep it short; it is read by the next audit.

7. If no finding is left, call `noop` and stop. Filing nothing is the right outcome when the
   documentation is current.

8. Call `create_issue` **once** with title "Docs audit: <date>". Do NOT specify labels, the
   conclude job applies them. List every finding, the most misleading first, each with:
   - the document's `file:line` and the stale statement;
   - the evidence from the code, with its `file:line` or path;
   - what the document should say, or the section that has to be added.

   The issue goes to Refine, which sizes it and splits it into one issue per finding, so write
   each finding to survive that: self-contained, naming its own files, never "as above".

   Refer to people by role, never by name, and include no personal contact details, even when
   a document you are quoting contains them.
