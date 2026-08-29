---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-mutation.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  # What to mutate, and with which tests. Consumers override these: the defaults suit a .NET
  # solution whose calculation logic lives in a Domain project. Keep the scope narrow. Cost is
  # mutants times test time, so a whole solution takes hours and produces findings nobody
  # reads. Point it at the code where a silently wrong line would actually cost money.
  MUTATION_TARGET_PROJECT: "apps/api/src/Numa.Domain/Numa.Domain.csproj"
  MUTATION_TEST_PROJECT: "apps/api/tests/Numa.UnitTests/Numa.UnitTests.csproj"
  MUTATION_REPORT_DIR: /tmp/gh-aw/agent/mutation
  MUTATION_THRESHOLD_HIGH: "80"
  STRYKER_VERSION: "4.6.0"
  REPO_RULES: "Read-only mutation review. Report only surviving mutants that prove a real gap in test assertions. Never weaken a test, never delete a case, never change source to kill a mutant. Do not modify files, commit, push, or run write operations."
  MUTATION_MARKER: "<!-- agent-mutation -->"
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
description: |
  Weekly mutation test. Stryker rewrites small parts of the target project (a comparison
  flipped, a constant zeroed, a return inverted) and reruns the tests against each variant. A
  mutant the tests still pass is a line that could be silently wrong in production with
  nothing to catch it, which is what line coverage cannot tell you: coverage proves a line
  ran, a killed mutant proves its behaviour is pinned.

  The tool is deterministic, so the agent does not run the mutation; it reads the report and
  decides which survivors are worth a person's time. Most are not. Equivalent mutants, the
  ones semantically identical to the original and therefore unkillable, are the known reason
  teams abandon mutation testing, so the ones judged equivalent are remembered and never
  reported twice.

  Files one issue labelled `mutation` + `refine`, so Refine sizes it and splits a report of
  several unrelated gaps into one estimated issue per gap.

  Router-only worker: triggered exclusively via workflow_call from work-router.yml.
  Contract input: trigger-kind(scheduled|manual). The router owns the weekly schedule.

name: "Agent: Mutation Test"

# Shared: network policy only. This workflow owns its Safe Outputs and OpenCode configuration.
imports:
  - github/gh-aw/.github/workflows/shared/opencode.md@v0.87.5
  - shared/platform-defaults.md
  - shared/opencode-ci.md

on:
  workflow_call:
    inputs:
      trigger-kind:
        description: "Mutation trigger: scheduled or manual"
        required: false
        type: string
        default: manual

  # Do not pile reports on top of reports nobody has actioned yet.
  skip-if-match:
    query: "is:issue is:open label:mutation"
    max: 2

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
  - name: Run the mutation test
    id: stryker
    env:
      TARGET: ${{ env.MUTATION_TARGET_PROJECT }}
      TESTS: ${{ env.MUTATION_TEST_PROJECT }}
      OUT: ${{ env.MUTATION_REPORT_DIR }}
      VERSION: ${{ env.STRYKER_VERSION }}
    run: |
      set -uo pipefail
      mkdir -p "$OUT"

      # A tool failure must not read as a clean report. The agent checks status.txt first and
      # reports the failure rather than inventing findings from a missing file.
      fail() { echo "$1" > "$OUT/status.txt"; echo "::warning::$1"; exit 0; }

      command -v dotnet >/dev/null 2>&1 || fail "dotnet is not on PATH; mutation testing did not run."
      [ -f "$TARGET" ] || fail "Target project $TARGET does not exist; nothing to mutate."
      [ -f "$TESTS" ] || fail "Test project $TESTS does not exist; nothing to run mutants against."

      dotnet tool install dotnet-stryker --version "$VERSION" --tool-path /tmp/stryker >/dev/null 2>&1 \
        || fail "Could not install dotnet-stryker $VERSION."

      # Build first: a compile error inside Stryker surfaces as an unhelpful mutant failure
      # rather than as the build error it actually is.
      dotnet build "$TARGET" -c Release > "$OUT/build.log" 2>&1 \
        || fail "The target project does not build; see build.log. Mutation testing skipped."

      # concurrency 2 matches the runner: these VMs have 2 vCPUs, and oversubscribing makes
      # every mutant time out rather than run faster.
      /tmp/stryker/dotnet-stryker \
        --project "$(basename "$TARGET")" \
        --test-project "$TESTS" \
        --reporter json --reporter progress \
        --output "$OUT" \
        --concurrency 2 \
        > "$OUT/stryker-stdout.log" 2>&1 || true

      report=$(find "$OUT" -name 'mutation-report.json' | head -1 || true)
      if [ -z "$report" ]; then
        tail -40 "$OUT/stryker-stdout.log" > "$OUT/failure-tail.log" 2>/dev/null || true
        fail "Stryker produced no report; the tail of its output is in failure-tail.log."
      fi

      [ "$report" = "$OUT/mutation-report.json" ] || cp "$report" "$OUT/mutation-report.json"
      python3 "${GITHUB_WORKSPACE}/.github/actions/summarize-mutation-report/summarize.py" \
        "$OUT/mutation-report.json" "$OUT/survivors.json" \
        || fail "The report exists but could not be summarised."
      echo "ok" > "$OUT/status.txt"

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
      - name: Apply agent output
        id: agent-output
        uses: ./.github/actions/apply-agent-output
        with:
          artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
          token: ${{ steps.app-token.outputs.token }}
          create-issues: 'true'
      - name: Apply mutation labels to created issues
        if: steps.agent-output.outputs.first-issue-number != ''
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ steps.agent-output.outputs.first-issue-number }}
          labels: |
            mutation
            refine

safe-outputs:
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  threat-detection: false
  create-issue:
    max: 1

timeout-minutes: 180
---

1. Read `${{ env.MUTATION_REPORT_DIR }}/status.txt` first.

   If it holds anything other than `ok`, the mutation run itself failed. Call `create_issue`
   once titled `Mutation test could not run: <date>`, quote the status line and, where it
   exists, `failure-tail.log`, and stop. A broken tool reported plainly is useful; findings
   invented from a missing report are not.

2. Read `${{ env.MUTATION_REPORT_DIR }}/survivors.json`. It holds the mutation score, the
   totals by status, and every surviving mutant with its file, line, the original line of
   code and its replacement. Do not read `mutation-report.json`: it is megabytes of JSON and
   the digest already carries what you need.

   A **surviving mutant** means the code was changed and every test still passed. Either a
   test should have caught it and does not, or the change makes no observable difference.
   Telling those two apart is the whole job.

3. Discard the survivors nobody should spend time on:

   - **Equivalent mutants**, where the change cannot alter observable behaviour, so no test
     could ever kill it: an unreachable defensive null check, `<=` versus `<` on a bound that
     cannot be hit, a cache size, a log message. These are the reason teams abandon mutation
     testing. They can never be fixed and they return every week.
   - Mutations in code with no business meaning: `ToString`, logging, guard clauses whose
     only job is to throw.

   Before ranking, call `memory_smart_search` for prior mutation reviews of this repository
   and drop any survivor previously judged equivalent, matched on file, line and mutator.

4. For each survivor that remains, decide what it proves. A good one reads as a bug report
   about a test: *"`QuoteCalculator.cs:88` changed `>=` to `>` and every test still passed,
   so nothing pins the behaviour exactly at the threshold."* Rank by what the wrong behaviour
   would cost: money maths and rounding first, then permission and validation boundaries,
   then the rest.

   Keep between **3 and 7**. If none survive that filter, call `noop` and stop: a suite that
   kills everything meaningful is the outcome this workflow exists to confirm.

5. Call `create_issue` **once**, titled `Mutation gaps: <date>`. Do NOT set labels; the
   conclude job applies them. The body must carry:

   **Section 1, the numbers.** The mutation score, the totals by status, and a sentence on
   whether the score is above or below `${{ env.MUTATION_THRESHOLD_HIGH }}%`. Say plainly that
   the score covers `${{ env.MUTATION_TARGET_PROJECT }}` only, not the repository.

   **Section 2, the gaps.** One numbered entry per survivor you kept, each with its file and
   line, the original expression and its replacement, and one sentence naming the behaviour no
   test currently pins. Write each entry self-contained, with its own file and its own
   acceptance criterion: this issue goes to Refine, which sizes it and splits a multi-gap
   report into one issue per gap, and "same as gap 2" does not survive that split.

   Every acceptance criterion is about **adding or strengthening a test** so the mutant would
   die. Never propose changing the source to make a mutant unreachable, and never propose
   deleting or weakening a test. Adhere to ${{ env.REPO_RULES }}.

6. Finally call `memory_save` once with a compact record: the date, the score, and for each
   survivor you judged equivalent its file, line and mutator, so the next run does not report
   it again. Keep it short; the next run reads it, not a person.
