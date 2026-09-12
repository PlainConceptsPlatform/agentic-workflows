---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-merge-gate.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  VERIFY_COMMANDS: ""
  REPO_RULES: "Review the selected bot pull request for defects and report what you verified. Do not decide the outcome: the workflow computes it from your report and from facts it measured before you ran."
  # Where to look first, not what to escalate on. This list used to be the check that decided
  # whether a machine merged without a human, and it decided by category: the prompt told the
  # agent that a match "is not a defect, it is a reason this pull request needs a person". In a
  # layered application every feature PR touches an entity or a contract, so the gate escalated
  # almost everything and, measured on a consumer, auto-merged 31% of terminal verdicts while
  # finding zero defects. The areas are still worth naming; they are now the review pass's
  # attention list. What decides is evidence, in the decision table the validator owns.
  # One line: gh-aw joins a multi-line env value onto a single line when it compiles the lock.
  RISK_INDICATORS: "Any diff touching authentication, authorization or session handling. Any change to a calculation or pricing engine, or to code handling money. Any database migration, or a change to an entity or schema. Any change to an audit or event log, or anything that could break its continuity. Any change to a public API contract or a shared library other repositories consume."
  # Paths a bot may change but never merge on its own: an extended regular expression matched
  # against every changed path in the pull request. The default names this stack's dependency
  # and toolchain manifests plus everything under a dotted directory, and is wrong for a
  # repository built on anything else, which is the failure worth knowing about: an unmatched
  # list protects nothing and reports nothing. A match holds the merge for a human; it does not
  # stop the agent repairing failed CI on the same files.
  PROTECTED_PATHS: '^(\.|AGENTS\.md$|ARCHITECTURE\.md$|opencode\.jsonc$|package\.json$|pnpm-lock\.yaml$|Directory\.Packages\.props$|global\.json$)'
  # Paths whose change needs the person who owns them. A match forces OWNER REVIEW REQUIRED and
  # sets blast radius high on its own, whatever the diff's size. CODEOWNERS names who is asked
  # when the repository has that file; it is never a prerequisite, because a repository without
  # one must still be able to protect its auth and its infrastructure.
  #
  # Matches a path segment or a file stem, in both spellings, because the same default has to
  # work for `src/auth/`, `src/Api/Identity/` and `AuthEndpoints.cs`. The lowercase-only,
  # directory-only version this replaced matched nothing at all in a .NET consumer: replayed
  # against that repository's last eighteen gated pull requests it caught none of them, while
  # this one catches exactly three and they are the three that deserved an owner (a database
  # migration, a change to the platform role definitions, and a downstream token service).
  OWNER_PATHS: '(^|/)([Aa]uth|[Aa]uthn|[Aa]uthz|[Aa]uthentication|[Aa]uthorization|[Ii]dentity|[Ss]ecurity|[Ss]ecrets?|[Mm]igrations|[Ii]nfra|terraform|helm|k8s|deploy)(/|[A-Z][A-Za-z]*\.[a-z]+$)'
  # Paths worth a second look that do not, alone, need a person. A match raises the floor to
  # medium, and medium with acceptable recoverability still auto-merges. This is the line that
  # separates "look here" from "stop here", which the old RISK_INDICATORS list could not.
  SENSITIVE_PATHS: '(^|/)([Dd]omain|entities|[Cc]ontracts)/'
  # Diff shape. Size and spread are the honest deterministic signal for a change that touches no
  # path a regex would name: the one pull request in the measured sample that genuinely wanted an
  # owner matched no sensitive path and was identified by 29 files and ~1600 lines across five
  # architectural layers.
  BLAST_HIGH_FILES: "20"
  BLAST_HIGH_LINES: "800"
  BLAST_MEDIUM_FILES: "5"
  BLAST_MEDIUM_LINES: "200"
  # Agent confidence below which the pull request goes to a human. The agent reports the number;
  # this decides what it means.
  CONFIDENCE_THRESHOLD: "0.8"
  WORKING_LABEL: bot-working
  IMPLEMENT_LABEL: implement
  REVIEW_LABEL: review
  # Sits alongside `review`, never instead of it, so every board query that already asks for
  # `review` keeps working. What it adds is the distinction the single label could not carry:
  # `owner-review` says a named area changed, `blocked` says the machine could not proceed rather
  # than chose not to. The belt does not retry a blocked pull request.
  OWNER_REVIEW_LABEL: owner-review
  BLOCKED_LABEL: blocked
  # Marks a park the machine caused — a crash, a timeout, an empty output — as opposed to one it
  # decided on. The janitor retries these after a while and never touches a decision park, because
  # re-running a decision produces the same decision. Created idempotently where it is applied.
  STALLED_LABEL: stalled
  PR_PENDING_LABEL: pr-pending
  GATE_MARKER: "<!-- agent-merge-gate -->"
  ATTEMPT_MARKER: "<!-- agent-merge-gate-attempt -->"
  MAX_ATTEMPTS: "6"
  PARK_AT_ATTEMPT: "5"
  # A smaller budget for the one failure that repeating does not fix. A crashed or timed-out run
  # is a machine failure and worth repeating; a run that finished and handed back a report the
  # validator could not read is a formatting problem, and the third attempt looks like the first.
  # The cost is not hypothetical: every retry is a fresh agent run with this worker timeout, and
  # `call-merge-gate` holds the repo-wide `merge-belt` slot while it runs, so five attempts on
  # one unusable report can keep every other bot pull request in the repository waiting.
  PARK_AT_UNUSABLE_OUTPUT: "2"
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
      attempts_so_far:
        description: Failed gate attempts already made against this CI verdict. Parked when it reaches the cap.
        required: false
        type: string
        default: '0'
  # gh-aw folds the top-level `if:` below into the generated activation job but does not carry
  # the jobs that `if:` reads into activation's `needs`: only prompt-referenced custom jobs with
  # no `needs:` of their own are hoisted (subject). protected_changes needs subject, so without
  # this entry activation read needs.protected_changes.outputs.requires_review before
  # protected_changes had started; the value was '' and the clause was always true
  # (Pliny-Bot run 34042143350: activation finished 18 s before protected_changes began).
  needs: [protected_changes]

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
      run-id: ${{ steps.subject.outputs.run-id }}
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
          ci-run-id: ${{ inputs.ci-run-id }}
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
          # A transient API failure must not kill the gate (the reconcile cron can push the
          # token into secondary rate limits). Three tries, then default to not blocked; the
          # agent re-reads the review state itself before any merge.
          decision=""
          for _ in 1 2 3; do
            if decision=$(gh pr view "$PR" --repo "$REPO" --json reviewDecision --jq '.reviewDecision // ""'); then
              break
            fi
            sleep 5
          done
          echo "review_blocked=$([ "$decision" = 'CHANGES_REQUESTED' ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

  # Rung 4b. Everything the merge decision needs that a shell can establish, measured once,
  # before any model reads the diff. The job kept its name and its `requires_review` and
  # `holds_review` outputs because eight guards across this file and the route matrix read them;
  # what it gained is the blast radius those guards never had.
  protected_changes:
    needs: subject
    if: needs.subject.outputs.found == 'true'
    runs-on: agents-arc
    permissions:
      contents: read
      pull-requests: read
    outputs:
      requires_review: ${{ steps.blast.outputs.requires_review }}
      files: ${{ steps.blast.outputs.files }}
      level: ${{ steps.blast.outputs.level }}
      signals: ${{ steps.blast.outputs.signals }}
      owner_hits: ${{ steps.blast.outputs.owner_hits }}
      sensitive_hits: ${{ steps.blast.outputs.sensitive_hits }}
      required_owners: ${{ steps.blast.outputs.required_owners }}
      files_changed: ${{ steps.blast.outputs.files_changed }}
      lines_changed: ${{ steps.blast.outputs.lines_changed }}
      owner_hit: ${{ steps.blast.outputs.owner_hit }}
      sensitive_hit: ${{ steps.blast.outputs.sensitive_hit }}
      # The decision, computed once. A protected path holds the merge for a human, but it must
      # not stop the agent repairing failed CI on those same files: blocking there strands the
      # pull request with nobody able to fix it. That pair of conditions used to be restated at
      # eight call sites, five of them steps of one job, and the trap table documents it because
      # it has already been got wrong. `holds_review` is the only place it is decided now.
      holds_review: ${{ steps.blast.outputs.requires_review == 'true' && needs.subject.outputs.conclusion != 'failure' }}
    steps:
      - name: Checkout workflow actions
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Assess blast radius
        id: blast
        uses: ./.github/actions/assess-blast-radius
        with:
          token: ${{ github.token }}
          pr-number: ${{ needs.subject.outputs.pr }}
          protected-paths: ${{ env.PROTECTED_PATHS }}
          owner-paths: ${{ env.OWNER_PATHS }}
          sensitive-paths: ${{ env.SENSITIVE_PATHS }}
          high-files: ${{ env.BLAST_HIGH_FILES }}
          high-lines: ${{ env.BLAST_HIGH_LINES }}
          medium-files: ${{ env.BLAST_MEDIUM_FILES }}
          medium-lines: ${{ env.BLAST_MEDIUM_LINES }}

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
        if: needs.protected_changes.outputs.holds_review == 'true'
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Create bot token
        if: needs.protected_changes.outputs.holds_review == 'true'
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      # Only the reservation comes off. pr-pending says a pull request for this issue is open
      # and waiting, which is still true when the gate hands it to a human, so taking it off
      # here left a board where three issues with three open pull requests looked like they
      # had none. The merge path is the one place the label stops being true.
      - name: Release the issue
        if: needs.protected_changes.outputs.holds_review == 'true'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Flag owner review
        if: needs.protected_changes.outputs.holds_review == 'true'
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: |-
            ${{ env.REVIEW_LABEL }}
            ${{ env.OWNER_REVIEW_LABEL }}
      - name: Explain the merge hold
        if: needs.protected_changes.outputs.holds_review == 'true'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.GATE_MARKER }}
            PR #${{ needs.subject.outputs.pr }} changes protected files and cannot be auto-merged.
            The `review` and `owner-review` labels are set: the person who owns these files
            decides, and merges.

            Protected files:
            ${{ needs.protected_changes.outputs.files }}

            Required owners: ${{ needs.protected_changes.outputs.required_owners || 'none configured' }}

            **Verdict:** owner-review

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
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Create bot token
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - name: Check for merge conflicts
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
      # First attempt only. Retries are recorded by the incomplete job's attempt comment, and
      # every App comment is a router event: one issue collected sixteen of these in a day.
      - name: Comment on issue - problems found, solving them
        if: needs.subject.outputs.conclusion == 'failure' && (inputs.attempts_so_far || '0') == '0'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            Problems found in PR #${{ needs.subject.outputs.pr }}. ${{ steps.conflicts.outputs.has_conflicts == 'true' && 'Merge conflicts detected.' || 'CI failed.' }}
            Bot is working on fixing it.
  validate_output:
    needs: [activation, subject, protected_changes, agent, safe_outputs]
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
      # Where the decision is made. The agent contributed evidence; these inputs are the facts
      # protected_changes measured before it ran. Neither half can produce a disposition alone.
      - name: Compute the merge-gate disposition
        id: validate
        uses: ./.github/actions/validate-merge-gate-output
        with:
          output-file: ${{ steps.output.outputs.output-file }}
          issue-number: ${{ needs.subject.outputs.issue }}
          ci-conclusion: ${{ needs.subject.outputs.conclusion }}
          blast-level: ${{ needs.protected_changes.outputs.level }}
          protected-hit: ${{ needs.protected_changes.outputs.requires_review }}
          owner-hit: ${{ needs.protected_changes.outputs.owner_hit }}
          confidence-threshold: ${{ env.CONFIDENCE_THRESHOLD }}
  conclude:
    needs: [activation, subject, protected_changes, agent, safe_outputs, validate_output]
    # `protected_changes.result == 'success'` is stated rather than relied on. GitHub skips a job
    # whose needs failed, so this condition was never reached on that path, but every clause in
    # it read as safe on a job that never ran: `requires_review` is '' when protected_changes
    # fails, and '' != 'true'. A guard whose safety comes from somewhere else is a guard that
    # stops working the moment someone adds always() to this job.
    if: >
       needs.agent.result == 'success' &&
        needs.safe_outputs.result == 'success' &&
        needs.protected_changes.result == 'success' &&
        needs.validate_output.outputs.valid == 'true' &&
       (needs.protected_changes.outputs.requires_review != 'true' || needs.validate_output.outputs.outcome != 'auto-merge')
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
      # GITHUB_TOKEN on purpose: an App-token comment on a pull request is an issue_comment
      # event, and GITHUB_TOKEN raises none. The full assessment lives on the issue, where the
      # lifecycle is; this is what a reviewer opening the pull request sees. Carrying the
      # marker and the Verdict line makes the router's verdict detection independent of
      # whether the model remembered the marker.
      # One block so the reader sees the whole disposition at once instead of reconstructing it
      # from a word. Everything on it was either measured before the agent ran or computed from
      # what the agent proved; nothing here is the model's own summary of its mood.
      - name: Show the disposition on the pull request
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ github.token }}
          issue-number: ${{ needs.subject.outputs.pr }}
          body: |
            ${{ env.GATE_MARKER }}
            **Verdict:** ${{ needs.validate_output.outputs.outcome }}

            | | |
            |---|---|
            | Disposition | `${{ needs.validate_output.outputs.outcome }}` |
            | CI | ${{ needs.subject.outputs.conclusion }} |
            | Blast radius | ${{ needs.protected_changes.outputs.level }} |
            | Files / lines | ${{ needs.protected_changes.outputs.files_changed }} / ${{ needs.protected_changes.outputs.lines_changed }} |
            | Protected paths | ${{ needs.protected_changes.outputs.requires_review == 'true' && 'yes' || 'no' }} |
            | Owner paths | ${{ needs.protected_changes.outputs.owner_hit == 'true' && 'yes' || 'no' }} |
            | Required owners | ${{ needs.protected_changes.outputs.required_owners || 'none configured' }} |

            Why this blast radius:
            ```
            ${{ needs.protected_changes.outputs.signals }}
            ```

            Findings and verification on the linked issue: #${{ needs.subject.outputs.issue }}. [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
      - name: Merge approved pull request
        if: needs.validate_output.outputs.outcome == 'auto-merge'
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
      # `review` goes on for all three parked dispositions, so every board query and every
      # authorize-bot-work handoff that already reads it keeps working. The second label is what
      # tells a person which kind of parking this is.
      - name: Flag a parked outcome
        if: contains(fromJson('["human-review","owner-review","blocked"]'), needs.validate_output.outputs.outcome)
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: |-
            ${{ env.REVIEW_LABEL }}
            ${{ needs.validate_output.outputs.outcome == 'owner-review' && env.OWNER_REVIEW_LABEL || '' }}
            ${{ needs.validate_output.outputs.outcome == 'blocked' && env.BLOCKED_LABEL || '' }}
      # Asking the owner is best effort on purpose. A CODEOWNERS entry can name a team this App
      # cannot request, and a failed request must not strand a pull request whose label and
      # comment already say who is wanted.
      - name: Request the owners named by CODEOWNERS
        if: needs.validate_output.outputs.outcome == 'owner-review' && needs.protected_changes.outputs.required_owners != ''
        continue-on-error: true
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          REPO: ${{ github.repository }}
          PR: ${{ needs.subject.outputs.pr }}
          OWNERS: ${{ needs.protected_changes.outputs.required_owners }}
        run: |
          set -euo pipefail
          for owner in $OWNERS; do
            case "$owner" in
              *@*) continue ;;                                  # an email address is not a reviewer
              @*/*) gh pr edit "$PR" --repo "$REPO" --add-reviewer "${owner#@}" || true ;;
              @*)   gh pr edit "$PR" --repo "$REPO" --add-reviewer "${owner#@}" || true ;;
            esac
          done
      # The reservation only. The pull request is still open and still waiting, so pr-pending
      # stays until the merge path below retires it.
      - name: Release a parked outcome
        if: contains(fromJson('["human-review","owner-review","blocked"]'), needs.validate_output.outputs.outcome)
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}
      - name: Clear merged issue labels
        if: needs.validate_output.outputs.outcome == 'auto-merge'
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: |
            ${{ env.IMPLEMENT_LABEL }}
            ${{ env.WORKING_LABEL }}
            ${{ env.REVIEW_LABEL }}
            ${{ env.OWNER_REVIEW_LABEL }}
            ${{ env.BLOCKED_LABEL }}
            ${{ env.PR_PENDING_LABEL }}
  incomplete:
    needs: [subject, protected_changes, agent, safe_outputs, validate_output]
    if: >
       always() &&
       needs.subject.outputs.found == 'true' &&
       needs.protected_changes.outputs.holds_review != 'true' &&
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
      # The attempt record comes first. The belt bounds its retries by counting attempt comments
      # newer than the CI verdict, not by labels; releasing the labels before the record existed
      # meant a failure in either step below un-reserved the issue with nothing to count, and the
      # belt re-dispatched the same crash every cycle. The steps stay sequential on purpose: an
      # always() release after a failed park would strip bot-working from an issue that was
      # meant to be parked with review.
      # attempts_so_far is a workflow_call input and arrives as '' when the caller passes an
      # empty expression, declared default or not; fromJson('') is a hard failure, so the empty
      # case reads as 0.
      #
      # Which budget applies is decided once, here, rather than restated in each step condition:
      # the same pair of conditions spread across four `if:` expressions is what the trap table
      # already records going wrong for the protected-files hold.
      - name: Choose the budget this failure gets
        id: budget
        env:
          ATTEMPTS: ${{ inputs.attempts_so_far || '0' }}
          AGENT_RESULT: ${{ needs.agent.result }}
          SAFE_RESULT: ${{ needs.safe_outputs.result }}
          OUTPUT_VALID: ${{ needs.validate_output.outputs.valid }}
          PARK_AT_ATTEMPT: ${{ env.PARK_AT_ATTEMPT }}
          PARK_AT_UNUSABLE_OUTPUT: ${{ env.PARK_AT_UNUSABLE_OUTPUT }}
        run: |
          set -euo pipefail
          attempts=${ATTEMPTS:-0}
          # The agent ran, published, and produced something the validator refused. Repeating
          # that reproduces it; a person reading the comment costs less than three more runs
          # holding the merge belt.
          if [ "$AGENT_RESULT" = success ] && [ "$SAFE_RESULT" = success ] && [ "$OUTPUT_VALID" != true ]; then
            threshold="$PARK_AT_UNUSABLE_OUTPUT"
            kind=unusable
          else
            threshold="$PARK_AT_ATTEMPT"
            kind=machine
          fi
          echo "kind=$kind" >> "$GITHUB_OUTPUT"
          echo "threshold=$threshold" >> "$GITHUB_OUTPUT"
          echo "park=$([ "$attempts" -ge "$threshold" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
      - name: Report the failed attempt
        if: steps.budget.outputs.park == 'false' 
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.ATTEMPT_MARKER }}
            Attempt ${{ inputs.attempts_so_far || '0' }} of ${{ env.MAX_ATTEMPTS }} on PR #${{ needs.subject.outputs.pr }} ended without an outcome.
            This failure parks at ${{ steps.budget.outputs.threshold }}. The issue keeps `implement`; the merge belt will retry.
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
      - name: Report the exhausted attempt budget
        if: steps.budget.outputs.park == 'true' && steps.budget.outputs.kind == 'machine'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.ATTEMPT_MARKER }}
            Attempt ${{ inputs.attempts_so_far || '0' }} of ${{ steps.budget.outputs.threshold }} on PR #${{ needs.subject.outputs.pr }} ended without an outcome.
            The attempt budget for this CI verdict is exhausted. The review label is set: a human must take over.
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
      # A verdict, not an attempt record, and this is the point of the whole split. The belt
      # bounds its own retries by counting attempt comments to MAX_GATE_ATTEMPTS, so a worker
      # that merely stopped parking would still be dispatched to the cap: the budget above would
      # have saved nothing. A comment carrying the gate marker and a Verdict line is the contract
      # the belt already respects -- it parks the pull request until a new commit moves the head
      # past it -- and an unusable report is a decision, not a failure to repeat. It carries no
      # attempt marker, so it is counted once, as what it is.
      - name: Record an unusable report as a decision
        if: steps.budget.outputs.park == 'true' && steps.budget.outputs.kind == 'unusable'
        uses: ./.github/actions/create-issue-comment
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          body: |
            ${{ env.GATE_MARKER }}
            The agent finished on PR #${{ needs.subject.outputs.pr }} but its report could not be
            read, ${{ steps.budget.outputs.threshold }} times on this head. Repeating it reproduces
            it, so the belt stops here rather than spending the rest of the budget holding the
            merge slot. The run log holds the output the gate refused.

            **Verdict:** human-review
            [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
      # `stalled` means a park the machine caused, and the janitor retries those. An unusable
      # report is a park the machine caused and retrying reproduces it, so it gets `review`
      # alone: the janitor's own rule is retry a failure, report a decision.
      - name: Park the issue for a human
        if: steps.budget.outputs.park == 'true'
        uses: ./.github/actions/add-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: |-
            ${{ env.REVIEW_LABEL }}
            ${{ steps.budget.outputs.kind == 'machine' && env.STALLED_LABEL || '' }}
      # The reservation only. A failed attempt does not close the pull request, so pr-pending
      # is still true and the board should keep saying so.
      - name: Release the issue
        uses: ./.github/actions/remove-issue-labels
        with:
          token: ${{ steps.app-token.outputs.token }}
          issue-number: ${{ needs.subject.outputs.issue }}
          labels: ${{ env.WORKING_LABEL }}

  agent:
    # The top-level guard reads both outputs. GitHub Actions does not make a
    # dependency's dependencies available through `needs` transitively.
    needs: [subject, protected_changes]
    if: always() && needs.protected_changes.outputs.holds_review != 'true' && needs.subject.outputs.review_blocked != 'true'

if: always() && needs.subject.outputs.found == 'true' && needs.protected_changes.outputs.holds_review != 'true' && needs.subject.outputs.review_blocked != 'true'

runs-on: agents-arc
runs-on-slim: agents-arc

secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

engine:
  id: opencode
  version: "1.2.14"
  env:
    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1

model: openai/glm-5-3

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
  # gh-aw checks out the router's ref. Its own "Checkout PR branch" step runs only when the event
  # carries a pull request, which a router dispatch does not, so the agent would start on main.
  # apply-agent-output fast-forwards origin/<branch> to the bundle tip and refuses anything else,
  # and gh-aw builds that bundle from what the agent committed on top of the checkout; both need
  # the agent to start on the branch it pushes to.
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
  # Every merge into the default branch invalidates every other open pull request that added a
  # changelog entry, because they all insert at the top of the same list. The conflict is real
  # and never interesting: both entries belong, newest first. Without a driver it costs a model
  # run per sibling pull request, and it recurs on every merge while more than one is in flight.
  # A consumer opts in by naming its own changelog in .gitattributes with `merge=changelog`;
  # repositories that do not are unaffected, because git only calls a driver a path asks for.
  - name: Teach git how to merge a changelog
    run: |
      set -euo pipefail
      git config merge.changelog.name "newest-first changelog entries"
      git config merge.changelog.driver "node $GITHUB_WORKSPACE/scripts/merge-changelog.mjs %O %A %B"
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
      RUN_ID: ${{ needs.subject.outputs.run-id }}
      CONCLUSION: ${{ needs.subject.outputs.conclusion }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh pr diff "$PR" --repo "$REPO" > /tmp/gh-aw/agent/diff.patch
      gh pr view "$PR" --repo "$REPO" --json title,body,files,additions,deletions \
        > /tmp/gh-aw/agent/pr.json
      if [ "$CONCLUSION" = "failure" ] && [ -n "$RUN_ID" ]; then
        gh run view "$RUN_ID" --repo "$REPO" --log-failed \
          > /tmp/gh-aw/agent/failed-logs.txt 2>/dev/null || \
          echo "logs unavailable" > /tmp/gh-aw/agent/failed-logs.txt
        gh run view "$RUN_ID" --repo "$REPO" --json jobs \
          --jq '[.jobs[] | select(.conclusion == "failure") | {name, conclusion}]' \
          > /tmp/gh-aw/agent/failed-jobs.json
      elif [ "$CONCLUSION" = "failure" ]; then
        echo "[]" > /tmp/gh-aw/agent/failed-jobs.json
        echo "CI run ID unavailable, cannot fetch logs" > /tmp/gh-aw/agent/failed-logs.txt
      fi

safe-outputs:
  # Path B. Without this, gh-aw's own safe_outputs job writes as well as the conclude job, and
  # it runs first: it pushed a flattened, single-parent commit with GITHUB_TOKEN while conclude
  # was still waiting, so the agent's merge commit was lost, the pull request stayed
  # conflicting, and GITHUB_TOKEN raises no events, so no CI ran on the new head and the belt
  # stalled (Pliny-Bot run 34051821011). Staged runs everything and writes nothing; conclude
  # applies the bundle and the comment with the App token, which does start CI.
  staged: true
  # A failed run is already a red run. An issue per failure buries the real backlog
  # under noise nobody closes.
  report-failure-as-issue: false
  threat-detection: false
  # target "*" because these workers are dispatched, not triggered by the pull request:
  # the default "triggering" target has no pull request in context and rejects the push
  # with "requires pull request context", so the agent's fix is computed and discarded.
  push-to-pull-request-branch:
    target: "*"
    required-title-prefix: "[bot] "
    # A failed bot PR may already contain protected files. Permit a verified repair push,
    # but protected_changes still prevents the later green-CI cycle from auto-merging it.
    protected-files: allowed
  add-comment:
    target: "*"

# The fleet is two machines, so this clock is also how long a stuck run can hold half of it.
# 240 went on to every worker at once when the provider was slow, which fixed the deaths and
# made every worker equally expensive to hang. These numbers are per worker: enough headroom
# for a slow gateway on the work it actually does, and not four hours for a run that reads one
# issue. Turns remain the guard against a confused agent looping; for a custom model the credit
# ceiling is models.dev fallback pricing and guards nothing.
#
# Reads CI failure evidence and may fix, verify and re-push, so it can do implement's work on a smaller diff.
timeout-minutes: 120
---

1. You are gating pull request **#${{ needs.subject.outputs.pr }}**, which closes issue
   **#${{ needs.subject.outputs.issue }}**. CI concluded
   **${{ needs.subject.outputs.conclusion }}**.

   It has already been confirmed that this is an open pull request we authored, that it closes
   an issue, and that the issue carries `implement`. Do not re-check any of that, and do not
   poll for checks: the conclusion above is the answer.

   You are on the pull request branch. Never rebase, reset, amend or otherwise rewrite
   history: the workflow applies your commits as a bundle with a fast-forward-only push and
   discards anything that is not a descendant of the branch tip. The
   `push_to_pull_request_branch` tool's own description recommends rebasing; in this
   repository that advice is wrong. Merge, commit, and let the workflow push.

2. Read `${{ env.ISSUE_CONTEXT_PATH }}`. It contains the issue body and its discussion. The
   acceptance criteria there define what this implementation had to satisfy, and step 5c asks
   you to check the diff against them.

3. Branch on the conclusion.

   You do not choose the outcome. The workflow computes it from your report and from facts it
   measured before you started. Two of those facts are already decided and you cannot argue with
   either: CI concluded what it concluded, and the blast radius below was measured from the
   changed paths and the diff shape.

   **Measured blast radius: `${{ needs.protected_changes.outputs.level }}`**
   (${{ needs.protected_changes.outputs.files_changed }} files,
   ${{ needs.protected_changes.outputs.lines_changed }} lines changed)

   ```
   ${{ needs.protected_changes.outputs.signals }}
   ```

   - **success** → step 4, then step 5 (review the change).
   - **failure** → step 4, then step 6 (CI remediation).
   - **action_required, cancelled, timed_out, or anything else** → CI did not produce a usable
     verdict, so there is nothing to merge on. Do step 5 anyway so the report is on the record,
     and say in `reason` which conclusion you saw. The workflow blocks on a non-success
     conclusion without needing you to.

     Follow repository documentation and established conventions when assessing or remediating
     the pull request. Protect secrets, do not bypass checks, and keep remediation focused.
     Adhere to ${{ env.REPO_RULES }}.

4. Read the diff and PR metadata. Read `/tmp/gh-aw/agent/diff.patch` in full and
   `/tmp/gh-aw/agent/pr.json` for the shape of the change. If CI failed, also read
   `/tmp/gh-aw/agent/failed-jobs.json` and `/tmp/gh-aw/agent/failed-logs.txt`.

    These files are the factual basis for everything below. Do not guess — cite what you read.

4b. **Merge conflict when CI is green.** If the conclusion is `success` and
    `has_conflicts` is `true` (current value: `${{ needs.reserve.outputs.has_conflicts }}`),
    resolve the conflict before assessing risk. You are already on the PR branch.
    Merge `origin/${{ github.event.repository.default_branch }}` into it
    (`git merge origin/${{ github.event.repository.default_branch }}`), resolve every
    conflict deliberately, commit the merge, and run the verification commands below. Do not
    use `--ours`, `--theirs`, or a blanket conflict-marker deletion without reviewing the
    intended behavior from both sides, and never rebase: the push is fast-forward only.

    Scope verification to the files the merge touched: pass changed file paths to
    lint/format tools instead of running them repository-wide (see step 6's scoped
    verification guidance).

    ```
    ${{ env.VERIFY_COMMANDS }}
    ```

    Push the merged branch using `push_to_pull_request_branch` (pr_number: ${{ needs.subject.outputs.pr }},
    branch: the current PR branch), then emit the `add_comment` with
    **Verdict:** remediated. CI will re-run on the updated branch and the merge gate
    will be triggered again — the next cycle will see a clean, conflict-free PR and can
    reach a real disposition.

    If the merge cannot be completed or the conflicts are genuinely ambiguous, do not push.
    Report `assessed`, and say in `reason` which conflicts could not be resolved safely. An
    unresolved conflict is not a mergeable state, so the workflow will not merge it.

    If the conclusion is `success` and `has_conflicts` is `false`, skip this step and
    proceed to step 5.

5. Review the change. This is the part no deterministic check can do, so spend the run here.

   **5a. Find defects.** Read the diff and the code it touches. You are looking for problems
   that would matter after this merges: correctness, missing edge cases, broken contracts,
   regressions, security, tests that do not actually test the behaviour they name.

   Keep a candidate only if it passes all three:

   - A specific, reproducible problem in a specific file or component.
   - Real impact: security risk, data loss, crash, or broken functionality.
   - Something a developer could pick up and fix without further investigation.

   Discard anything vague, stylistic, theoretical, or nice-to-have. **Finding nothing is a good
   result.** An empty `findings` array on a clean change is the correct output and costs you
   nothing. Do not pad the list.

   Read `${{ env.RISK_INDICATORS }}` as a list of places worth looking first in this repository.
   It is an attention list, not a verdict. Touching one of those areas is not a finding. A
   defect you can demonstrate in one of them is.

   **5b. Have each candidate verified independently.** Do not be the one who checks your own
   work. Hand each candidate off for verification as a claim on its own: the file, the line,
   what you think is wrong, and what would settle it. Do not pass on the reasoning that produced
   it, and do not say what you hope comes back. A verifier that has read the code fresh and
   tried to disprove the claim is the check you cannot perform on yourself.

   Take the answer. Not verified means the finding is a warning at most, whatever you believed
   when you wrote it. Verified means the verification string comes back with it, and that string
   is the evidence the merge decision will rest on: a command with its observed output, or a
   code path quoted end to end. Never "this looks wrong" or "this could fail if".

   Two things make this cheap to do honestly. An unverified finding is capped at a warning by the
   workflow whatever severity you claim, so overstating one gains you nothing. A verified high or
   critical finding blocks the merge, so inventing one costs somebody a morning.

   With no candidates, verify nothing and move on. This step exists for claims, not for
   reassurance about their absence.

   **5c. Check the acceptance criteria.** The issue context at `${{ env.ISSUE_CONTEXT_PATH }}`
   says what this change was supposed to do. Confirm the diff does it. Set
   `acceptanceCriteriaMet` to false only when you can name a criterion the diff does not
   satisfy.

   **5d. Answer the recoverability checklist.** How easy would this be to undo if it were
   wrong? Cite the diff for each answer, and record the ones that fired in
   `recoverabilitySignals`:

   - behind a feature flag
   - revertible by reverting the commit, with no manual step
   - no persistent data mutated
   - no irreversible migration
   - backward compatible with existing callers and stored data
   - observable after deploy
   - small affected surface

   `high` when the change can be reverted cleanly and touches no persistent state. `medium` when
   a revert works but something (a cache, a config, a client) needs attention. `low` when a
   revert would not restore the previous behaviour: a migration that drops or rewrites data, a
   contract other repositories already consume, anything that leaves state behind.

   **A `low` rating must name what cannot be undone**, in `recoverabilitySignals`. `low` parks
   the pull request for a person, so it is the one judgement of yours that can hold up a merge on
   its own, and the same rule applies to it as to a finding: unevidenced, it does not count. A
   `low` with an empty `recoverabilitySignals` is read as `medium`. This is not an invitation to
   pad the list — it is the difference between "this rewrites the plan rows in place" and a
   reflex.

   **5e. Raise the blast radius if the paths missed something.** The measured level came from
   file paths and diff shape. If the change introduces something those rules cannot see — a new
   authorization decision point, a new trust boundary, a write to shared state from a path that
   never wrote before — set `blastRadiusRaise` with the level and the reason. You can only raise
   it. A lower value is ignored.

   **5f. State your confidence.** A number between 0 and 1, for the whole assessment, not for
   any one finding. Below ${{ env.CONFIDENCE_THRESHOLD }} sends the pull request to a person, so
   it is the honest way to say you could not get comfortable. Use it when the change is in an
   area you could not fully trace, not as a reflex.

6. **CI failed** → read `/tmp/gh-aw/agent/failed-jobs.json` and
   `/tmp/gh-aw/agent/failed-logs.txt`, which are already on disk. Load only skills required to
   fix the actual cause. Run these verification commands before a push. Do not weaken a test,
   disable a check, or push an unverified guess.

   **Empty failure evidence is not a reason to ask for review.** If `failed-jobs.json` is `[]`
   or the logs say they were unavailable, then no CI run judged this head. That is the normal
   state of a conflicting pull request: GitHub cannot build `refs/pull/N/merge` while the
   conflict lasts, so no `pull_request` CI can run on it and there is nothing to read. The
   conflict is the failure to fix. Resolve it as described above, push, and select
   `remediated`; CI runs on the result and the next cycle gets a real verdict. Select `review`
   for missing evidence only when `has_conflicts` is `false`, because then there is genuinely
   nothing to act on.

   **Scoped verification.** The commands below are the full suite. This runner has limited
   memory, and a whole-repo lint or build can be killed mid-run. Scope verification to the
   files you actually changed first, and only escalate to the full suite when the scoped run
   passes and you are still unsure:
   - Lint/format (biome, eslint, prettier, ruff, etc.): pass the changed file paths as
     arguments so the tool checks only those files (e.g. `pnpm exec biome check <files>`),
     never the whole repository.
   - Build: prefer building only the project(s) containing the changed files; use the full
     solution build only when the change crosses project boundaries.
   - Tests: run the test project covering the changed files; run the full suite only when
     the change is cross-cutting.
   If verification of exactly the CI-failing job is what you need, reproduce just that job's
   command, not the entire pipeline.

   A PR that already contains protected files still requires remediation. You may include those
   files in the verified repair push, but the next green-CI cycle will require human review and
   must not auto-merge the PR.

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

   If you cannot fix it after a concrete repair attempt, or the logs show you have already tried
   on this same head commit, stop looping: report `assessed` with no push, and say in `reason`
   what failed and what you tried. CI is not green, so the workflow blocks the pull request and
   a person decides from there.

7. Say which of two things you did, and nothing more.

   - **`remediated`** — CI failed or the branch conflicted, you fixed it, you verified the fix,
     and you are pushing it. Exactly one `push_to_pull_request_branch` goes with this word.
   - **`assessed`** — you reviewed the change and are reporting what you found. No push.

   These are the only two words the workflow accepts. You do not write `merge`, `review`,
   `auto-merge`, `blocked`, or any other outcome: the workflow computes the disposition from
   your report and from the facts it measured, and a word it does not recognise parks the pull
   request. Never merge with administrator privileges and never bypass a required check.

8. Emit exactly one `add_comment` targeting issue `${{ needs.subject.outputs.issue }}`,
   containing, in this order:

   1. `${{ env.GATE_MARKER }}`
   2. A heading: `## Merge gate review of PR #${{ needs.subject.outputs.pr }}`
   3. A line `**Verdict:** assessed` or `**Verdict:** remediated`
   4. Prose a person can read: what this change does, what you looked at, what you found or did
     not find, and what you ran to check. If you remediated, say what failed and what you
     changed. Short. Nobody reads a wall.
   5. A fenced `json` block, exactly one, as the last thing in the comment.

   The JSON block is what the workflow reads. Every field is required except
   `blastRadiusRaise`, which is omitted when the measured level stands:

   ```json
   {
     "findings": [
       {
         "severity": "critical|high|medium|low",
         "confidence": 0.0,
         "verified": true,
         "verification": "the command you ran and what it printed, or the code path quoted end to end",
         "category": "correctness|security|contract|tests|regression",
         "file": "src/...",
         "line": 0,
         "finding": "one sentence: what is wrong",
         "evidence": "what in the diff or the code shows it",
         "suggestedFix": "what would fix it"
       }
     ],
     "recoverability": "high|medium|low",
     "recoverabilitySignals": ["revertible with no manual step", "no persistent state written"],
     "blastRadiusRaise": { "to": "high", "reason": "adds a new authorization decision point" },
     "acceptanceCriteriaMet": true,
     "confidence": 0.0,
     "reason": "one sentence a person would accept as the summary"
   }
   ```

   `"findings": []` on a clean change is the expected output, not a failure to do the job.

   The workflow applies comments, labels, merges, and closures with the App token. Reading the
   repository, running verification commands and delegating a finding to be checked are all part
   of the job. What is restricted is what leaves this run: the only safe outputs you may call are
   the one optional `push_to_pull_request_branch` for a verified repair and this one
   `add_comment`.
