---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-audit.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # The router dispatches this worker with the App token, so the run's actor is the bot, which the
  # pre-activation membership check refuses unless it is listed here.
  GH_AW_ALLOWED_BOTS: "${{ vars.BOT_LOGIN || 'platform-devbox[bot]' }},github-actions[bot]"
  # The model this worker's own session runs on. opencode.ci.json's `model` is the cheap default
  # every agent without its own model falls back to; the lead is where a wrong call costs a run,
  # so it names its model here. `model:` below only satisfies the compiler. A repository may
  # change it to any model its opencode.ci.json declares.
  AGENT_LEAD_MODEL: "awf-proxy/glm-5-2"
  # Every model a subagent in this run may name, so the harness declares them all on the
  # awf-proxy provider (shared/opencode.md). Per-agent model values are awf-proxy/<model>.
  GH_AW_OPENCODE_MODELS: "glm-5-2,glm-5-3"
  # Pins every harness tier (plan, build, fast) onto one model. The CI setup remaps whatever
  # harness.json names onto awf-proxy/<model> (shared/opencode-ci.md), so empty runs the tiers
  # harness.json names; set this only to override them.
  AGENT_TIER_MODEL: "awf-proxy/glm-5-2"
  # The fast tier alone, when a repository's account is not granted what harness.json names for it.
  AGENT_FAST_MODEL: "awf-proxy/glm-5-2"
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
  Read-only repository audit that starts from the repository's own engineering health data.
  The `select` job runs scripts/audit-select.mjs with no model: it reads the newest
  `engineering-excellence-worklist` of the default branch (or the facets, where a repository
  publishes no worklist yet) and picks what this week's audit works on, ranked by a fixed score
  and capped at AUDIT_MAX_STORIES. The agent reads only the files those items name and writes one
  story per item with its measured value and target, then a short judgement pass over a risk map
  for what no tool measures. When nothing is selected and the risk map is empty the agent does
  not start: the repository is clean, and the run summary says so. A repository that publishes
  no health data keeps the exploratory audit: 5-7 problems found by reading the repository.

  Every data-led run also closes the loop, with no model (`follow_up` job): a story whose fix is
  merged and measured within its bar is closed with its before and after numbers, one closed as
  done but still over its bar is reopened (once), and an open story keeps its slot, so fewer new
  stories are filed while old ones are unfinished. The report gains a "Since last audit" section.
  A check in report mode for two weeks gets one pull request that writes its baseline from the
  worklist and switches it to ratchet, held for a person to merge; when that baseline would
  freeze junk, one clean-up story is filed first.

  Either way it files a compact tracking report, labelled `audit` + `bug`, plus one story issue
  per finding up to AUDIT_MAX_STORIES, labelled `bug` + `refine` and linked to the report as
  sub-issues. Refine refines each story on its own; the report never goes to Refine. Every body
  is measured with refine's size rule before it is filed and trimmed to fit, because one issue
  holding every finding and three stories was over refine's limit every time and was refused.
  Replaces .loops/recipes/guardrails-audit-loop.yaml.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: trigger-kind(scheduled|manual).
  The router owns the weekly Monday schedule and manual dispatch.

  The `skip-if-match` below is backpressure, so the audit stops filing reports while three
  are still unactioned.

name: "Agent: Audit"
# The router dispatches this worker (gh workflow run), so it is a run of its own in the Actions
# tab. The title carries the number the bot-working sweep and the stuck-run janitor look for, and
# the concurrency group is the one the router's call job used to hold.
run-name: "Agent: Audit - ${{ inputs.trigger-kind }}"
concurrency:
  group: audit
  cancel-in-progress: false
  # The router starts this worker with gh workflow run, so each dispatch is its own run; give
  # it its own slot in the compiler-generated conclusion group too. The extension is stripped
  # from the lock.
  job-discriminator: ${{ github.run_id }}

# Shared: network policy only. This workflow owns its Safe Outputs and OpenCode configuration.
# permissions, engine, model and runs-on cannot be shared , see shared/platform-defaults.md.
imports:
  - shared/opencode.md
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
  # The router starts this worker with gh workflow run; the inputs match workflow_call's.
  workflow_dispatch:
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
  # The skip-if-match search runs in pre_activation with the run's own GITHUB_TOKEN. A worker the router
  # dispatches has no caller to inherit permissions from, and on a private repository a token without
  # issues: read gets "The listed users and repositories cannot be searched", which fails the run.
  permissions:
    issues: read

  # gh-aw folds the top-level `if:` into activation without depending on the job it reads, so
  # the reference would resolve to '' and the agent would never run.
  needs: [select]

# The clean exit. `select` decides, from the repository's health data and without a model, whether
# there is anything to audit this week. When there is not, activation is skipped and with it the
# agent, `conclude` and `empty_run`: no tokens, nothing filed, and the summary of `select` says why.
if: needs.select.outputs.run_agent == 'true'

runs-on: agents-arc
runs-on-slim: agents-arc

secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

engine:
  id: opencode
  # Lowered from gh-aw's default 3: a fix released yesterday is usable. Strict mode rejects zero.
  cooldown: 1
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
  # What `select` picked, where the agent reads it. The same artifact is what next week's
  # selection compares against.
  - name: Load this week's selection
    uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
    with:
      name: audit-selection
      path: /tmp/gh-aw/agent

jobs:
  # What this week's audit works on, from the app's own CI data. scripts/audit-select.mjs comes
  # with the quality-gates template; a repository without it, or one that publishes neither a
  # worklist nor a facet, gets `source: none` and the exploratory audit. A selection that cannot
  # be computed is never a reason to skip the audit: every failure here falls back to exploring.
  select:
    runs-on: agents-arc
    timeout-minutes: 10
    permissions:
      contents: read
      actions: read
      issues: read
      # The pull requests that close an open story: one is closed on the numbers only once its fix merged.
      pull-requests: read
    outputs:
      run_agent: ${{ steps.select.outputs.run_agent }}
      data_led: ${{ steps.select.outputs.data_led }}
      source: ${{ steps.select.outputs.source }}
      clean: ${{ steps.select.outputs.clean }}
      selected: ${{ steps.select.outputs.selected }}
      risk_files: ${{ steps.select.outputs.risk_files }}
      story_slots: ${{ steps.select.outputs.story_slots }}
      follow_up: ${{ steps.select.outputs.follow_up }}
    steps:
      # The whole history without file contents, so the risk map can ask which files changed lately.
      - name: Checkout with history
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
          filter: blob:none
      - name: Select this week's work from the health data
        id: select
        env:
          GH_TOKEN: ${{ github.token }}
          MAX_STORIES: ${{ env.AUDIT_MAX_STORIES }}
          SELECTION: ${{ runner.temp }}/audit-selection/audit-selection.json
        run: |
          set -uo pipefail
          mkdir -p "$(dirname "$SELECTION")"
          if [ -f scripts/audit-select.mjs ]; then
            if node scripts/audit-select.mjs --out "$SELECTION" --max-stories "$MAX_STORIES"; then
              exit 0
            fi
            reason="scripts/audit-select.mjs failed (see this step's log)"
            echo "::warning::${reason}. The audit explores the repository instead."
          else
            reason="scripts/audit-select.mjs is not installed (it comes with the quality-gates template)"
            echo "${reason}. The audit explores the repository."
          fi
          jq -n --arg reason "$reason" '{schemaVersion: 1, kind: "audit-selection", source: "none", trustworthy: true, problems: [$reason], clean: false, runAgent: true, selected: [], riskMap: []}' > "$SELECTION"
          {
            echo "source=none"
            echo "data_led=false"
            echo "run_agent=true"
            echo "clean=false"
            echo "selected=0"
            echo "risk_files=0"
            echo "story_slots=${MAX_STORIES}"
            echo "follow_up=false"
          } >> "$GITHUB_OUTPUT"
      - name: Keep the selection for the agent and for next week
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: audit-selection
          path: ${{ runner.temp }}/audit-selection/audit-selection.json
          if-no-files-found: error
          retention-days: 90

  # Closing the loop, with no model and whether or not the agent runs (a clean week still closes
  # what was fixed). `select` decided from the numbers what to close, confirm or reopen, and which
  # report-only check graduates; this carries it out with the App token. A graduation pull request
  # carries the merge train's hold label, so nothing merges it but a person.
  follow_up:
    needs: [select]
    if: needs.select.outputs.follow_up == 'true'
    runs-on: agents-arc
    timeout-minutes: 10
    permissions:
      contents: read
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
          repositories: ${{ github.repository }}
          permission-issues: write
          permission-contents: write
          permission-pull-requests: write
      - name: Load this week's selection
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: audit-selection
          path: ${{ runner.temp }}/audit-selection
      - name: Close, reopen and graduate on the numbers
        uses: ./.github/actions/audit-follow-up
        with:
          selection-file: ${{ runner.temp }}/audit-selection/audit-selection.json
          token: ${{ steps.app-token.outputs.token }}
          story-labels: |-
            bug
            refine
          graduation-labels: quality-graduation

  conclude:
    needs: [select, activation, agent, safe_outputs]
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
          repositories: ${{ github.repository }}
          permission-issues: write
      # Staged, so this is the only write: the report, then each story with its labels and a
      # link back, then the report's list of stories. Each body passes refine's size rule first.
      - name: Download agent output
        id: output
        uses: ./.github/actions/download-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
      # The report's "Since last audit" section comes from the selection, not from the model.
      - name: Load this week's selection
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: audit-selection
          path: ${{ runner.temp }}/audit-selection
      - name: File the report and its stories
        uses: ./.github/actions/file-audit-issues
        with:
          output-file: ${{ steps.output.outputs.output-file }}
          token: ${{ steps.app-token.outputs.token }}
          max-body-chars: ${{ env.AUDIT_MAX_BODY_CHARS }}
          max-work-units: ${{ env.AUDIT_MAX_WORK_UNITS }}
          # Open audit stories hold their slots, so this is AUDIT_MAX_STORIES less those.
          max-stories: ${{ needs.select.outputs.story_slots || env.AUDIT_MAX_STORIES }}
          selection-file: ${{ runner.temp }}/audit-selection/audit-selection.json
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
  # A repository `select` found clean never reaches this job: the agent does not start, so
  # `needs.agent.result` is `skipped` and this is skipped with it.
  #
  # Step 7 of the prompt (and step 18 of the data-led one) gives a clean codebase its own outcome -- call `noop` and stop -- and
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
# Sweeps the repository read-only and writes one findings issue. Observed around 45 minutes for
# the exploratory audit; the data-led one reads a handful of files.
timeout-minutes: 90
---

{{#if needs.select.outputs.data_led == 'true' }}
11. This is a read-only audit that starts from the repository's own engineering health data.
    Do not run a repository-wide audit, do not run `/repo-audit`, and do not explore the
    repository looking for problems: the selection below already says what to work on. Do not
    modify any file, do not commit, and do not push. Adhere to ${{ env.REPO_RULES }}

    Read `/tmp/gh-aw/agent/audit-selection.json` first. A script computed it before you started,
    from what this repository's CI measures on its default branch. You need these fields:
    - `selected`: the measured problems to write up, already ranked, deduplicated against open
      stories and capped. Each has `check`, `kind`, `rule`, `path`, `symbol`, `value` (what was
      measured), `target` (the bar it is held to), `reasons`, `files` (each with `path`, `line`,
      `symbol`, sometimes `lines`) and `marker`.
    - `judgement.slots` and `riskMap`: how many more stories you may add in step 13, and the
      only files you read for it. Open audit stories (`storiesHeld`) already hold their slots, so
      `selected` and `judgement.slots` are smaller while they are unfinished; never file a story
      for them.
    - `excluded.notEnforced`: checks that are measured and not enforced yet, for step 15.
    - `trustworthy` and `problems`: caveats about the data, for step 15.

    Do not re-rank the selected items, do not add measured problems of your own, and do not
    re-measure anything: the numbers are established.

12. For each entry of `selected`, in order, read only the files it names, around the lines given.
    An entry with no `files` is a count from a tool that lists its findings elsewhere (for
    example vulnerabilities by severity): read at most the manifest or configuration that owns
    it. Work out what a fix looks like in this code, which is the part no tool writes: which
    behaviour has no test, where the method splits and what the parts are, which package moves
    to which version, which export or file can go. If the code an entry names no longer exists,
    drop the entry and say so in the report.

13. The judgement pass. Skip this step when `judgement.slots` is 0 or `riskMap` is empty.
    Otherwise read only the files in `riskMap` (complex, poorly covered and recently changed)
    and look for what no tool measures, such as an N+1 query, an endpoint or handler with no
    authorization check, a test that asserts nothing, or a comment or document beside the code
    that contradicts it. From this repository's own list, keep to the items a tool does not
    already count: ${{ env.AUDIT_FOCUS }}

    Do not report coverage, complexity, duplication, dead code, analyzer findings or
    vulnerabilities here: they are measured, and step 12 covers the ones selected. Keep a
    finding only if it meets ALL of these:
    - A specific, reproducible problem in a specific file or component.
    - Has real impact: security risk, data loss, crash, or broken functionality.
    - Something a developer could pick up and fix without further investigation.
    Discard anything vague, stylistic, theoretical, or nice-to-have. Score each survivor from 1
    to 10 (severity high, likelihood medium, blast radius medium, ease of fix a low bonus) and
    keep at most `judgement.slots` of them, highest first. Finding none is a good result.

14. Read `/tmp/gh-aw/agent/open-issues.json`, which lists every open issue with its title and
    labels, and discard any judgement finding already tracked there, including the ones worded
    differently that mean the same thing. The selected entries were already matched against
    open stories by their marker; drop one only when an open issue plainly tracks the same fix.

    Call `memory_smart_search` for prior audits of this repository and drop any judgement
    finding that was already reported and consciously not acted on. A finding reported before
    that is genuinely still broken IS worth filing again. After you have decided what to file,
    call `memory_save` once with a compact record of this audit: the date, each finding's file
    and one-line description, and its disposition (filed, already tracked, or previously
    rejected). Keep it short; it is read by the next audit, not by a person.

15. File the report: call `create_issue` with title "Audit: <YYYY-MM-DD>" and nothing else in the title. Do NOT specify labels; the conclude job applies them. The report is a compact tracking list, not a story: Refine never reads it. One entry per finding, the selected entries first in their order and then the judgement findings by score, each exactly this shape and no longer than about 600 characters:

    ```
    ### <n>. <one-line problem> (<what was measured> <value>, target <target>)
    **Where:** `path/to/file.ext:line`, `other/file.ext:line`
    **Problem:** One or two sentences: what happens and its impact.
    **Fix:** One or two sentences: the change that resolves it.
    ```

    A judgement finding has no measured number: write `(judgement, score <s>)` in its heading. When `excluded.notEnforced` is not empty, end the report with this section, one line per check, with the change since the last audit when `change` is a number:

    ```
    ## Not yet enforced
    - <check>: <count> (<+n or -n since the last audit, or "first reading">)
    ```

    Do not write a "Since last audit" section: the workflow appends it from the selection, with the numbers. When `trustworthy` is false, start the report with one line saying that `quality.config.json` is not valid, so modes, floors and baselines were unknown to this audit. No bullet lists beyond that section, no Gherkin, no user stories, no reproduction walkthroughs. Do not write any issue number (`#123`) in the report: the workflow adds the links to the stories, and every number in it is read as work the report waits on.

16. File the stories: call skill("pc-plan-story") and write one user story per selected entry, then one per judgement finding you kept; that skill owns their shape. Call `create_issue` once per story, after the report, titled with the story's own title (never "Audit: ..."), no labels. Each story names the exact files, methods and lines, states the measured value and the target in words (for example "CRAP 186, target under 30" or "module at 54% line coverage, floor 70%"), and says what the fix looks like for this code. A story for a selected entry ends with that entry's `marker`, copied exactly, on a line of its own: it is how the next audit knows the item is tracked. A marker goes in exactly one story, and a judgement story carries none. Refine refines each story on its own, so each must stand alone: it names its own files and its own acceptance criteria, never "as above" or "see finding 2", and never mentions the other stories or the report. Keep each story well under ${{ env.AUDIT_MAX_BODY_CHARS }} characters and ${{ env.AUDIT_MAX_WORK_UNITS }} bullet lines: the workflow measures every issue against that limit before filing and cuts anything over it from the end.

17. Everything you file is public-facing text. Never paste a scanner's message or the code it matched: refer to a finding by its rule id, path and line. For a vulnerability name the package, the advisory id and the installed and fixed versions, and nothing about how to exploit it. Never include a secret or a value that looks like one.

18. If nothing is left to file (every selected entry was dropped in step 12 or 14 and the judgement pass kept nothing), call `noop` and stop.
{{/if}}
{{#if needs.select.outputs.data_led != 'true' }}
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
{{/if}}
