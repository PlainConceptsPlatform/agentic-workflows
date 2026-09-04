# The determinism ladder, in practice

Verified against gh-aw v0.83.4.

The rungs are defined in `SKILL.md`. This file shows the work of moving a decision down one.

The test to apply, over and over: could a shell command answer this exactly? If yes, the model must
not be the one answering it.

---

## The two splitting rules

### Split on a wait

A workflow that waits is a workflow holding a runner for nothing. Polling CI for ten minutes costs a
runner slot doing nothing, plus a timeout branch for the case where CI was merely slow. The workflow
form is to stop at the pull request and let CI's completion trigger the next route:

```yaml
on:
  workflow_run:
    workflows: ["App: CI"]
    types: [completed]
    branches: ["fix/*", "bugfix/*", "feature/*", "bot/*", "patch/*", "hotfix/*"]
```

The wait becomes free, the timeout branch disappears, and the conclusion arrives as a fact instead
of something to be parsed out of `gh pr checks`.

### Split on a different trigger

If two chains never touch each other, they were two workflows sharing an entry point because polling
only gives you one. Each gets its own route on the router and the task that chose between them is
deleted.

Do not split on a phase boundary within one trigger. An implement workflow that codes, verifies and
opens a pull request is one workflow, because nothing external happens in between and splitting it
would mean handing state between runs for no reason.

---

## Rung 0 and 1: the router

### The classifier is a pure function

The whole route table is one shell function that reads the environment and writes `key=value` lines.
No network, no `gh`, no state:

```bash
classify_route() {
  local route="none" issue_number="" refine_mode=""

  case "${EVENT:-}" in
    issues)
      if [ "${ACTION:-}" = "labeled" ]; then
        case "${LABEL:-}" in
          refine)    route="refine"; refine_mode="first"; issue_number="${EVENT_ISSUE_NUMBER:-}" ;;
          implement) route="implement"; issue_number="${EVENT_ISSUE_NUMBER:-}" ;;
        esac
      fi
      ;;
    ...
  esac

  cat <<EOF
route=${route}
issue-number=${issue_number}
refine-mode=${refine_mode}
EOF
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  classify_route
fi
```

The last three lines are the point. The file runs standalone when the action calls it, and sources
cleanly into a test, so the test exercises the same code the router runs:

```bash
source "${HERE}/../classify-route/classify-route.sh"

assert_route "the bot's own comment never re-enters refine" none \
  EVENT=issue_comment COMMENT_ON_PR=false COMMENT_SENDER_TYPE=Bot \
  'ISSUE_LABELS=["refine"]' EVENT_ISSUE_NUMBER=42
```

A test that restates the implementation instead of sourcing it cannot fail. You edit both together
and it stays green through any bug you introduce. If the test file contains a copy of the `case`
statement, delete the copy or delete the test.

The matrix should also assert the wiring, which the classifier cannot know about:

```bash
for route in refine implement direct apply-review merge-gate audit propose bot-approve \
             audit-close cleanup-artifacts stale-recovery validate; do
  grep -q "route == '${route}'" "$ROUTER_YML" || fail "no job for route ${route}"
done
```

That catches the case where someone adds a route to the classifier and forgets the job, and the
reverse.

### Anything needing the network stays out of the pure part

Resolving the issue a gated pull request closes needs an API call, so it is a second step in the
composite action, gated on the route:

```yaml
- name: Resolve the issue the pull request closes
  id: linked-issue
  if: steps.classify.outputs.route == 'merge-gate' || steps.classify.outputs.route == 'apply-review'
  run: |
    issue="$(gh pr view "$PR_NUMBER" --repo "$REPO" \
      --json closingIssuesReferences --jq '.closingIssuesReferences[0].number // empty')"
    echo "issue=${issue}" >> "$GITHUB_OUTPUT"
```

This is what makes the concurrency guarantee real. `write-pipeline-<issue>` only serialises
implement against merge-gate if the gate knows the issue number.
`github.event.workflow_run.pull_requests[0].number` is the pull request number, and it is also
frequently empty, so guard for that and route to `none`.

### Guards belong in the classifier, not the prompt

Before, as a prompt instruction:

```
1. On an `issue_comment` event: continue only if the comment author is the issue author
   or an assignee, and the comment was not written by you.
```

That is a security control implemented as a polite request to a language model that reads the
untrusted comment in the same context window. After, as three lines of shell:

```bash
issue_comment)
  if [ "${COMMENT_ON_PR:-false}" = "true" ]; then
    route="apply-review"; pr_number="${EVENT_ISSUE_NUMBER:-}"
  elif [ "${COMMENT_SENDER_TYPE:-}" = "Bot" ]; then
    error="comment authored by a bot"
  elif ! has_label refine; then
    error="issue does not carry the refine label"
  else
    route="refine"; refine_mode="rerefine"
  fi
  ;;
```

Both guards are load-bearing. Without the bot check, the comment the worker posts when it starts
re-enters the refine route and the bot triggers itself. Without the label check, a comment on any
issue in the repository starts a model run that rewrites that issue.

---

## Rung 2 and 4: deterministic decisions inside the worker

Two places to run shell before the model, and choosing wrongly fails silently.

| | Rung 2, `on.steps` | Rung 4, `jobs:` |
|---|---|---|
| Runs in | the `pre_activation` job | its own job |
| Cost | a step on an existing slim job | one extra job |
| Gates the run | yes, via `<id>_result` | only if named in the dependent's `if:` |
| Prompt can read its outputs | no | yes |

`needs` is not transitive. The compiler wires custom jobs into the agent job's `needs`, so
`${{ needs.<job>.outputs.x }}` resolves. It does not wire `pre_activation`, so
`${{ needs.pre_activation.outputs.x }}` resolves to an empty string, without an error.

Verify in the compiled output rather than trusting it:

```bash
awk '/^  agent:/{f=1} f&&/^    needs:/{g=1;next} g&&/^      - /{print $2; next} g{exit}' \
  .github/workflows/my-workflow.lock.yml
```

### `needs` is not a gate

This is the mistake that looks most like working code:

```yaml
jobs:
  eligibility:              # exits 0 with eligible=false when there is nothing to do
    outputs:
      eligible: ${{ steps.check.outputs.eligible }}

  reserve:
    if: needs.eligibility.outputs.eligible == 'true'    # correctly skipped

if: inputs.issue-number != ''                            # agent job: says nothing about eligibility
```

The compiler puts `eligibility` in the agent job's `needs`, so the guard looks wired. But a `needs`
job that succeeds lets its dependents run, whatever its outputs say, and a job that is skipped also
satisfies `needs`. The agent ran on every issue the guard rejected.

The fix is one clause:

```yaml
if: inputs.issue-number != '' && needs.eligibility.outputs.eligible == 'true'
```

Check it after compiling:

```bash
awk '/^  agent:/{f=1} f&&/^    if:/{print; exit}' .github/workflows/agent-implement.lock.yml
```

### A custom job has no checkout

The compiler does not add `actions/checkout` to a custom job, so `gh` has no git remote to infer
the repository from:

```
fatal: not a git repository (or any of the parent directories): .git
```

Pass `--repo "$REPO"` on every `gh issue`, `gh pr` and `gh run` call, with
`REPO: ${{ github.repository }}` in the job `env`. Rung-3 `steps:` do not have this problem because
they run in the agent job, which is checked out. That asymmetry is the trap: the same line works in
one block and fails in the other.

The same absence bites harder with local actions. `uses: ./.github/actions/whatever` cannot be
resolved at all without a checkout, and the job fails before its first step:

```
Can't find 'action.yml' under '/home/runner/work/Repo/Repo/.github/actions/whatever'
```

Three scheduled maintenance jobs shipped in this state and could never have run. Nothing in the
compile, the lint, or a local test sees it.

Testing locally hides the `--repo` bug, because your shell is usually inside a clone. Run the script
from a directory with no `.git`:

```bash
mkdir -p /tmp/nogit && cd /tmp/nogit
GH_TOKEN=$(gh auth token) REPO=owner/repo GITHUB_OUTPUT=/tmp/nogit/out bash ./pick.sh
```

---

## Rung 3: precompute steps

Top-level `steps:` run inside the agent job, after checkout and before the model. Anything written
to `/tmp/gh-aw/agent/` is visible to the agent and uploaded as an artifact.

Before, three vague instructions each costing several tool round-trips:

```
2. Read the issue and every comment on it.
3. Read the diff in full.
4. Read the failing job's logs.
```

After, on disk before the model wakes up:

```yaml
steps:
  - name: Load the issue context
    uses: ./.github/actions/load-issue-context
    with:
      token: ${{ github.token }}
      issue-number: ${{ inputs.issue-number }}
      output-path: ${{ env.ISSUE_CONTEXT_PATH }}
```

Same information, one deterministic fetch, and the artifact survives the run so a human can see
exactly what the model was looking at when it decided.

Issue context is mandatory on any worker that implements, verifies, or gates work. The agent cannot
judge whether the work satisfies acceptance criteria it has never read.

Precompute when the fetch is predictable. Leave it to the agent when the next fetch depends on what
the last one said, such as following a reference chain.

### Do not re-derive a fact you were handed

The router passes the CI conclusion from `workflow_run` as an input. A guard action that ignores it
and calls `gh pr checks --jq '[.[] | select(.conclusion != null)] | .[0].conclusion'` has replaced a
known fact with the verdict of an arbitrary check in an unspecified order. The gate can then merge
on a green from an unrelated check while the CI it was told about failed.

Worse, the prompt above it said "the conclusion above is the answer, do not poll", so the lie was
documented as a guarantee. If an input exists, use it.

---

## Rung 5: the agent

| Belongs to the agent | Never the agent's job |
|---|---|
| Reading code and deciding whether it is correct | Counting, sorting, set membership |
| Weighing merge risk across a diff | Finding the lowest-numbered open issue |
| Writing a user story, or prose a human will read | Checking whether all referenced issues are closed |
| Interpreting what a reviewer meant | Parsing JSON that `jq` could parse |
| Fixing a failing test | Deciding whether the actor has write access |
| Deciding whether a finding is worth filing | Detecting which event fired |

`max-turns: 300` bounds the tool loop. Set it where an honest run finishes comfortably and a confused
one stops.

---

## Patterns we use

### RouterOps

One conventional workflow owns every trigger and calls at most one worker per event. This is the
default.

The router is plain YAML on purpose. It has no prompt, therefore no prompt-injection surface, and it
can be linted by actionlint and tested by a shell script. Do not put a model in it.

### IssueOps

Issue events drive the work; safe outputs write back. `agent-refine` and `agent-implement`.

### DeterministicOps

Precompute with real steps, reason with the agent, post-process deterministically.

```
steps: (gh CLI to /tmp/gh-aw/agent/)  ->  agent reads files  ->  safe outputs applied
```

### MonitorOps

A route triggered by another workflow's completion. `merge-gate` is this. The trap is the `name:`
match: `workflows: ["App: CI"]` must equal the target's `name:` exactly, and renaming either side
breaks it silently.

A second trap is that `workflow_run` does not fire for `pull_request`-triggered CI completions on
feature branches. The trigger works for push-to-main, but bot PRs whose CI was triggered by
`pull_request` never produce the event. The `stale-recovery` action (2h cron) is the fallback: it
polls for bot PRs with failed CI and dispatches the merge-gate via `workflow_dispatch`.

### LifecycleOps

Use this shape when a human can answer an agent's questions and resume the same work:

```
route -> guard -> reserve -> preload context -> agent -> safe outputs -> conclude | incomplete
```

Guard, reserve, context loading, and fixed lifecycle comments are deterministic. Implement them as
parameterised local composite actions, not prompt instructions.

Keep the command label (`refine`) so an authorised comment can trigger the response pass, and add a
separate state label (`review`) to tell people input is needed. Remove the working label before
asking questions. On success remove all transient labels and add the terminal one.

`review` must be in both `add-labels.allowed` and `remove-labels.allowed` on any worker that can
stop for human input. Implement must skip issues carrying `review`; refine must not, because a
refine issue with `review` is waiting for the author's reply.

### DispatchOps

The router's `workflow_dispatch` carries an `operation` input covering every route plus a `validate`
operation that runs the route matrix on a runner. Workers get no dispatch trigger of their own.

---

## Patterns we deliberately do not use

**WorkQueueOps.** GitHub labels already are our queue, and events already tell us when an item joins
it. The cache-memory variant does not work under opencode.

**BatchOps.** Matrix fan-out with deterministic sharding. Right for 50+ independent items. Our
volumes do not reach it.

**MemoryOps.** `cache-memory` and `repo-memory` are both dropped under opencode. Store state where
GitHub already stores it: a label, a comment, an issue body.

**CorrectionOps.** Store what the workflow predicted, compare against what humans later decided, feed
the difference back. Experimental.

---

## The composite action taxonomy

Deterministic stages live in `loops/actions/<verb-noun>/action.yml`. A local action must not embed a
repository's workflow policy: pass labels, markers, required state, bodies, paths and modes as
inputs.

**Routing**

| Action | Responsibility |
|---|---|
| `classify-route` | The route table plus closing-issue resolution. Wraps `classify-route.sh` |
| `verify-route-matrix` | Sources the classifier, asserts every event and every route's wiring |

**Reading**

| Action | Responsibility |
|---|---|
| `load-issue-context` | Issue body, labels and comment stream to JSON. Mandatory for implement, gate and review |
| `list-open-issues` | All open issues to JSON, so the agent does not spend turns finding duplicates |
| `identify-gate-subject` | Is this our pull request, what does it close, does that issue carry the required label |

**Applying agent output**

| Action | Responsibility |
|---|---|
| `apply-agent-output` | Downloads the artifact and applies its items in one fixed order. The single entry point |
| `download-agent-output` | Downloads the artifact; exposes output JSON, bundle file, item count |
| `apply-agent-comments` / `apply-agent-labels` | One safe-output type each |
| `create-agent-issues` / `update-agent-issues` / `close-agent-issues` | Issue lifecycle from agent output |
| `merge-agent-pr` / `push-agent-branch` / `apply-agent-bundle` | The write path |

**Explicit operations**

| Action | Responsibility |
|---|---|
| `add-issue-labels` / `remove-issue-labels` | Label lifecycle. Removal ignores 404 |
| `create-issue-comment` | Post a fixed Markdown comment |
| `link-pr-to-issue` | Ensure the pull request body carries a closing reference |

**Checks**

| Action | Responsibility |
|---|---|
| `verify-composite-actions` | Parse every manifest and reject contexts a composite action lacks |

**Refine validation**

| Action | Responsibility |
|---|---|
| `verify-refine-output` / `validate-refine-output` | Validate the refinement outcome before terminal transitions |

**Scheduled maintenance**

| Action | Responsibility |
|---|---|
| `audit-close` | Close audit reports whose referenced issues are all closed |
| `cleanup-artifacts` | Delete artifacts past the retention window |
| `stale-recovery` | Reconcile `bot-working` claims older than the threshold |

### Rules

- A job calling one of these runs `actions/checkout` first.
- Any action that writes an input path creates its parent directory first.
- One runtime per concern. API work uses `actions/github-script`, where a failed call rejects and
  fails the step. Git work uses shell. Do not mix, and do not write a `gh` plus `jq` loop whose every
  mutation ends in `|| true` while a counter increments regardless; that reports work it did not do.
- A shared `require`-able helper must be `.cjs` if the repository's `package.json` declares
  `"type": "module"`, because `actions/github-script` loads with `require`.
- Pass the helper's path explicitly via `${{ github.action_path }}` in the step `env`.
  `GITHUB_ACTION_PATH` inside a nested `uses:` step refers to that nested action, not yours.
- A manifest may not reference `needs`, `jobs` or `secrets`, not even inside `description:`. The
  runner evaluates every `${{ }}` in an `action.yml`, so an expression written as documentation still
  fails the action at load time with `Unrecognized named-value`. Neither `gh aw compile` nor
  actionlint reads these files, so lint them:

  ```bash
  grep -oE '\$\{\{[^}]*\}\}' "$manifest" | grep -E '\b(needs|jobs|secrets)\.'
  ```

- Invoke a script as `bash "${GITHUB_ACTION_PATH}/thing.sh"`, never by path alone. A checkout from a
  Windows clone carries no executable bit and the step exits 126 before its first line.

### The write path is the part to get right

`apply-agent-bundle` is the model for everything that touches git:

```bash
git bundle verify "$BUNDLE_FILE"
mapfile -t BUNDLE_HEADS < <(git bundle list-heads "$BUNDLE_FILE")
[ "${#BUNDLE_HEADS[@]}" -eq 1 ] || fail "Git bundle must expose exactly one ref"
[ "$(git rev-parse FETCH_HEAD)" = "$BUNDLE_TIP" ] || fail "Fetched commit did not match"
git merge-base --is-ancestor "$TARGET_TIP" "$BUNDLE_TIP" || fail "cannot fast-forward"
git merge --ff-only "$BUNDLE_TIP"
```

Verify, require exactly one ref, require the fetched tip to match the listed one, require a
fast-forward, then push. `merge-agent-pr` does the same job with `--match-head-commit`, so GitHub
refuses the merge if the head moved after the agent looked at it.

---

## When to convert an agentic workflow to plain YAML

Strike out every prompt step a shell command could do exactly. If what remains would not be worth a
model call on its own, the workflow is a script.

What you gain: no tokens, no threat-detection job, no engine setup, reproducible output. What you
give up: prose a human will read. A fair trade for a maintenance sweep, a bad one for anything a
person is meant to engage with.

A deterministic route with `issues: write` is safer than the agentic workflow it replaces, because
there is no prompt and therefore no prompt-injection surface.
