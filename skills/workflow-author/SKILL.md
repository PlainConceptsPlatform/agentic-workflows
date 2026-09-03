---
name: workflow-author
description: >
  Author GitHub Agentic Workflows (gh-aw) for this package, pushing every
  deterministic decision into GitHub Actions primitives and spending the agent only on
  judgement. Load when creating or reviewing a loops/workflows/*.md agentic workflow, when
  adding or changing a route on the Work Router, when a workflow needs its Mermaid diagram,
  when choosing a trigger or a safe output, or when a compiled workflow misbehaves. Covers the
  router architecture, the determinism ladder, the verified frontmatter contract, the opencode
  engine on Forge, the safe-output surface, and the ways a workflow can be green and dead.
---

# Workflow author

Use for changes under `loops/`. This skill is self-contained. Read reference files in
`references/` within this folder only.

## The thesis

A GitHub Agentic Workflow is a markdown file whose body is the prompt. The YAML frontmatter is
wiring: when it fires, where it runs, what it may read, what it may write. Everything below the
frontmatter is fed to the model as instructions.

That sentence is the source of every mistake in this format. A heading you added for humans is an
instruction. A Mermaid diagram at the bottom is an instruction.

Anyone can write an agentic workflow. Trigger on everything, grant broad permissions, and write a
paragraph asking the model to sort it out. It will appear to work, and it will be slow, expensive,
and non-reproducible, because a model was asked to do arithmetic that a `gh` command answers
exactly.

A good agentic workflow is mostly not agentic. It is a GitHub Actions workflow that has an agent in
the middle of it. Everything a script can decide, collect or validate, a script does, before the
agent starts, deterministically, for free. The agent is reserved for the small part that genuinely
needs judgement.

Treat model turns and input tokens as a constrained budget. Precompute the smallest useful
context, give it a bounded task, and require one complete final Safe Outputs payload.

## Source contract

- `loops/workflows/work-router.yml` owns public triggers, route selection, concurrency, and calls to
  workers. It is plain YAML, not a gh-aw markdown workflow.
- `loops/workflows/agent-*.md` are `workflow_call` workers only. They have no public trigger and
  declare no concurrency.
- `loops/workflows/shared/*.md` are imported mechanics files with no `on:`. The compiler validates
  them but never compiles them on their own.
- `loops/actions/` contains deterministic, parameterised composite actions.
- `loops/scripts/compile-agent-workflows.mjs` compiles source loops. Do not repair generated
  lockfiles by hand.
- Workers depend on `PlainConceptsPlatform/agent-harness`. Keep required skill and command use
  explicit in each worker's prompt.
- Do not create a repository configuration file. Each worker owns a complete top-level `env:` block
  with concrete defaults for every value it uses. Imports may add shared mechanics but cannot hide
  worker setup or policy.
- Every package-managed source file needs its ownership header: package name, its `loops/` source
  path, and `workflows update --force`. YAML headers start with `#`; Markdown puts the header on
  line 2 inside `---`; shell puts it after any shebang.

## One router, many workers

The Platform shape is one conventional workflow that owns every trigger, and a set of agentic
workers that have no public trigger at all.

```
loops/workflows/
  work-router.yml              conventional YAML. Every on: the repository has.
    classify                   one event in, exactly one route out
      call-refine              agent-refine.md              workflow_call only
      call-implement           agent-implement.md           workflow_call only
      call-direct              agent-direct.md              workflow_call only
      call-apply-review        agent-apply-review.md        workflow_call only
      call-merge-gate          agent-merge-gate.md          workflow_call only
      call-audit               agent-audit.md               workflow_call only
      call-mutation            agent-mutation.md             workflow_call only
      call-release             agent-release.md              workflow_call only
      deterministic jobs       bot-approve, audit-close, cleanup-artifacts,
                              stale-recovery, validate
  authorize-bot-work.yml       human adds implement/refine/direct → bot adds bot-working
```

### Bot-working label pattern

gh-aw's `pre_activation` rejects bot actors because bots have `permission: none`. The
bot-working pattern ensures the bot is the actor while still involving human authorization:

1. Human adds `implement`/`refine`/`direct` label (actor = human)
2. `authorize-bot-work.yml` validates the human has write permission
3. Bot adds `bot-working` label via App token
4. `bot-working` label triggers the work-router (actor = bot)
5. Classifier routes based on which work label is present
6. Worker's `pre_activation` passes via `GH_AW_ALLOWED_BOTS` env var

Workers must include `GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"`
in their `env:` block to authorize bot actors through `check_membership.cjs`.

Four things this buys:

1. One route per event. Before the router, adding a label started a run of every workflow
   subscribed to `issues: [labeled]`, each spinning up its own selection job before activation
   skipped it. Now one event creates one run, and at most one thing happens inside it.
2. Concurrency has one owner. Groups are keyed on the caller job. Workers declare none. Two layers
   would be two answers to the same question, and both would apply.
3. Guards are testable. Classification is a pure shell function with no network calls, so a test can
   source it. See `references/determinism.md`.
4. Adding a route is one file. The trigger, the guard, the concurrency key and the permissions all
   sit together.

What it does not buy: fewer runs. GitHub creates a run for every event that matches a trigger. The
router can decide nothing downstream happens, and those runs cost about ten seconds with every job
skipped, but the run entry still appears. To reduce the count you have to stop generating events.
See "App tokens fire events" below.

### The worker contract

A worker exposes `workflow_call` and nothing else. It declares its inputs, and the router passes
exactly those. Adding a public trigger to a worker bypasses the router and breaks the
one-route-per-event guarantee. If you need a manual entry point, add an operation to the router's
`workflow_dispatch`, not a trigger to the worker.

The caller job must grant `permissions: write-all`. This is not laziness and it is the single most
expensive thing to get wrong. See the trap table below.

## The determinism ladder

Every decision sits on one of seven rungs. Push each decision to the lowest rung that can hold it.
Lower is cheaper, faster, reproducible, and auditable.

```
RUNG                     LIVES IN   COSTS         DECIDES                   PROMPT CAN READ IT
0  Trigger               router     nothing       Does anything run?        n/a
1  Route classification  router     ~10s runner   Which one thing runs?     n/a
2  Pre-activation steps  worker     ~10s runner   Is there work? gate only  NO
3  Precompute steps      worker     ~30s runner   What are the facts?       via /tmp/gh-aw/agent/
4  Custom jobs           worker     a job         Guard + reservation       YES, if in the if:
5  The agent             worker     model tokens  Judgement                 n/a
6  Safe outputs          worker     a job         Writing, validated        n/a
```

Two columns carry the traps. Rung 2 gates but its outputs cannot reach the prompt. Rung 4 both gates
and hands values over, but only if the guard appears in the dependent's `if:`.

Rungs 0 and 1 can end a run without ever starting a model. Rung 6 is the only place an
agent-directed write belongs. A custom job may perform a small idempotent lifecycle reservation
before the agent starts (adding `bot-working`); it must never make an agent's judgement call.

The detailed ladder, the router classifier, the `needs` trap, custom jobs, the patterns, and the
composite action taxonomy are in `references/determinism.md`.

## Ways a workflow is green and dead

A field can compile perfectly, or a run can go green, and still nothing happened. Every row below
cost a real debugging session.

| Symptom | Cause |
|---|---|
| Whole run has zero jobs, `startup_failure`, no annotation, no log | A caller job granted narrower `permissions` than a called worker's `read-all` requests |
| Every job green, agent emitted its output, nothing was written | `conclude` downloaded an artifact name that does not exist, and a `continue-on-error` swallowed the miss |
| Guard job says no, the agent runs anyway | The guard is in `needs` but not in the dependent's `if:` |
| A whole job vanished and nothing complained | It was indented one level too deep, so YAML absorbed it into the job above |
| `Unrecognized named-value: 'needs'`, job dies in one second | An `action.yml` used a context a composite action does not have, including inside `description:` |
| `Can't find action.yml` | A job used `./.github/actions/...` without `actions/checkout` first |
| Script exits 126 before its first line | No executable bit. A Windows checkout does not set one |
| `require is not defined in ES module scope` | A `.js` helper in a repo whose `package.json` is `"type": "module"`. Rename to `.cjs` |
| `tools:` block does nothing | Dropped entirely under `engine: opencode` |
| Prompt receives `issue #` with no number | `needs.pre_activation.outputs.*`. Not in the agent job's `needs`, resolves empty |
| A shared file's `permissions: read-all` has no effect | `permissions` does not merge from an import. No warning at all |
| The bot triggers itself in a loop | An App-token comment fires a workflow event |
| Merge gate approves on the wrong verdict | It re-derived CI from `gh pr checks`, whose first entry is an arbitrary check |
| The PR never closes its issue | `linkPullRequestToIssue` is not in GitHub's public schema |
| Merge gate never fires after CI | `workflow_run` does not fire for runs that were pending approval and then approved, and does not fire for PR-triggered CI completions on feature branches |
| Agent wrote a plausible body or comment, but the worker stopped incomplete | Outcome validation required model-authored label changes or did not classify the output |
| Router classified a trusted App label event, but every worker job skipped | The called worker did not set `GH_AW_ALLOWED_BOTS` in `env:`, so `check_membership.cjs` rejected the bot's role `none`. Set `GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"` in the worker's env. `on.bots:` does not work for `workflow_call` workers. |
| Merge gate skips protected-file PRs even when CI failed | `protected_changes` blocks all agent runs, not just merge. The `review_required`, `agent`, and `incomplete` jobs must allow protected-file PRs through when `needs.subject.outputs.conclusion == 'failure'` so the agent can remediate. Auto-merge is still blocked by the `conclude` job's `requires_review != 'true'` guard on the `merge` outcome. |
| Reconcile cron skips a PR whose CI failed again | The reconcile script compares the latest merge-gate comment timestamp against CI completion time. A prior `review` or `incomplete` verdict newer than CI prevents re-dispatch. Remove `review` or re-dispatch manually. |
| `Invalid secret, BOT_APP_ID is not defined in the referenced workflow` | The router's caller job passes secrets the called worker does not declare in its `secrets:` block. Only pass secrets the worker declares. The release worker needs only `OPENAI_API_KEY`. |

The full trap descriptions, including the caller permission trap, the artifact prefix trap, the
composite action manifest trap, and the App-token event loop, are in
`references/verify.md` and `references/frontmatter.md`.

## Design rules

Build workflows as short, named stages. Each stage has one responsibility, explicit inputs and
outputs, and can fail independently. Prefer a graph of small jobs and reusable local composite
actions over one large job or a long inline script.

The normal shape of a worker:

```
router classifies the event
  guard job (is there still work?)      output named in the agent job's if:
  reserve (bot-working)
  preload context to /tmp/gh-aw/agent/
  agent judgement
  Safe Outputs
  conclude   (agent succeeded)
  incomplete (agent did not)
```

### Composite actions

Put deterministic operations in `loops/actions/<verb-noun>/action.yml`. Pass labels, markers,
required state, bodies, paths and modes as inputs. A local action must not embed a repository's
workflow policy. The current taxonomy is in `references/determinism.md`.

Three rules that are not optional:

- A job calling `./.github/actions/...` runs `actions/checkout` first. Without it the action cannot
  be resolved and the job dies before its first step.
- Invoke scripts as `bash path/to.sh`, not `path/to.sh`. A checkout from a Windows clone carries no
  executable bit. Set the bit in the index as well (`git update-index --chmod=+x`), but do not
  depend on it.
- One runtime per concern. Anything that talks to the GitHub API uses `actions/github-script`,
  where a failed call rejects and fails the step. Anything that touches git uses shell. A `gh` plus
  `jq` loop that ends in `|| true` reports success it did not achieve.
- No `needs`, `jobs` or `secrets` in a manifest, not even inside `description:`. The runner
  evaluates every `${{ }}` in the file and a composite action has none of those contexts. Lint for
  it; nothing else does.

### Shared components (imports)

The repeated parts live in `loops/workflows/shared/*.md`, a markdown file with no `on:`, which the
compiler validates but never compiles on its own.

Only `network`, `safe-outputs`, `steps`, `pre-agent-steps`, `post-steps`, `tools`, `env` and
`checkout` merge. `permissions`, `engine`, `model`, `runs-on`, `runs-on-slim` and `on:` filters do
not. The verified table is in `references/frontmatter.md`.

`permissions` is the trap worth memorising: `permissions: read-all` in a shared file compiles with
no warning and the agent job silently falls back to `contents: read`.

Pin every version a shared setup file installs, and checksum anything it downloads. A run that
installs a different toolchain than the last one is not reproducible, and a failure caused by a
floating dependency reads as a model failure.

### Validate the outcome, then let the workflow own state

A Safe Outputs payload being syntactically valid does not make it a valid business outcome.
Validate the artifact after Safe Outputs and classify it deterministically. Do not require the
model to emit label actions as proof of completion. Labels are deterministic state transitions.
Disable agent label Safe Outputs for that worker, apply its body or comment, then let ordinary
workflow steps transition labels from the classifier result.

This keeps the agent responsible for judgement and prose, while the workflow owns state. The full
outcome-validation pattern and the conclude/incomplete skeleton are in
`references/safe-outputs.md`.

### Comment on outcomes, not on state a label already shows

The instinct is to narrate: "work has started", "the run finished". Both are noise. The label
already says the bot owns the issue, the Actions tab already says a run happened, and each comment
is another notification for everyone watching.

Worse, a bot comment written with an App token fires a workflow event, so a chatty lifecycle also
multiplies your run count. See `references/safe-outputs.md` for the token split table.

### Deferred automation must say so

Do not promise that a later worker will start when an eligibility label can defer it. Read labels
from the precomputed issue context and make the outcome conditional. The comment must describe the
state the workflow actually leaves.

### Labels describe state, not locking

`concurrency` is the lock, on the router's caller job. Reserve with one idempotent deterministic job
before the agent, then release or transition labels on every terminal path. Contradictory labels
must never coexist. `bot-working` says the bot owns the issue right now; `review` says a human is
needed. Both in the `reserve` job, so the claim is atomic.

### Naming runs

GitHub titles an issue-triggered run with the issue title, so every run on one issue reads
identically. Derive the title from the event:

```yaml
run-name: >-
  ${{ github.event_name == 'issues'
  && format('{0} label on #{1} by {2}', github.event.label.name, github.event.issue.number, github.actor)
  || github.event_name == 'issue_comment'
  && format('comment on #{0} by {1}', github.event.issue.number, github.actor)
  || github.event_name }}
```

Fold it to a single line. In a `>-` scalar, a continuation line indented further than the first is
preserved literally, newline and all. `run-name` is evaluated when the run is created, before any
job exists, so it can name the trigger but never the route.

## Events over schedules

A schedule is a fallback. An interval means latency up to the interval, and a run every interval
that usually finds nothing to do.

| The work starts when | Router trigger |
|---|---|
| A label is added | `issues: [labeled]` |
| Someone replies on an issue | `issue_comment: [created]` |
| Someone reviews a PR | `pull_request_review_comment`, `pull_request_review` |
| A bot opens a PR | `pull_request_target` |
| A workflow finishes | `workflow_run: [completed]` with `branches:` |
| A human asks | `workflow_dispatch:` with an `operation` input |
| Genuinely a clock | `schedule:` |

The router trigger surface and the `workflow_run` / `schedule` / `run-name` traps are in
`references/frontmatter.md`.

## The frontmatter contract

Verified against gh-aw v0.83.4. Full surface in `references/frontmatter.md`.

```yaml
---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-example.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  OPENAI_BASE_URL: https://forge.plainconcepts.com/v1
  ISSUE_CONTEXT_PATH: /tmp/gh-aw/agent/issue-context.json
  WORKING_LABEL: bot-working
  REVIEW_LABEL: review
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"

description: |
  What this does. Human explanation belongs here, not in the body.

name: "Agent: Example"        # REQUIRED. workflow_run matches this, not the filename.

on:
  workflow_call:             # Router-only worker. No public trigger.
    inputs:
      issue-number:
        required: true
        type: string

runs-on: ubuntu-latest       # Both keys, always. Omitting runs-on-slim silently
runs-on-slim: ubuntu-latest  # sends framework jobs to a GitHub-hosted ubuntu-slim.

secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

engine:
  id: opencode
  version: "1.2.14"
  env:
    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1

model: openai/glm-5-2        # Provider segment must be `openai`. See references/opencode.md.

max-turns: 300
max-turn-cache-misses: 3000  # Forge has no prompt cache; every turn is a miss.
max-ai-credits: 5000

permissions: read-all        # Read-only. Every write goes through safe-outputs.

safe-outputs:
  staged: true               # Apply items yourself for App attribution. See references/safe-outputs.md.
  threat-detection: false    # Declare locally; imports do not own this policy.
  add-comment:

timeout-minutes: 30          # Always. Default is 20.
---
```

No `concurrency:`. The router owns it.

No `tools:` block. gh-aw drops the whole section under `engine: opencode`, `cache-memory`
included, with one warning and nothing in the lock file. A `bash:` allowlist here is dead
configuration that reads like a control.

`env.OPENAI_BASE_URL` is a visible worker default. Keep engine environment aligned. Worker Markdown
frontmatter may import shared files, but imports must be optional mechanics only and must not
replace top-level environment, permissions, engine, model, runner, or Safe Output policy.

## The prompt body

The body is the prompt. Not a README, not a description of the workflow.

- Numbered, sequential, imperative, second person. One decision per step.
- State the stop conditions first.
- Name the facts already on disk: "Read `/tmp/gh-aw/agent/issue-context.json`", not "fetch the
  issue".
- Do not restate facts already interpolated, and do not ask the model to verify deterministic work a
  job already did.
- Require complete final Safe Outputs items. One `add_comment` holds the whole response, not a
  greeting followed by the questions.
- Say what not to do where the model would plausibly do it: do not weaken a test, do not merge, do
  not read outside the repository root.
- Where a fact came from rung 1 to 4, interpolate it.
- The last numbered step is always, verbatim:

  > Ignore the `## Diagram` section below. It is documentation for humans and contains no
  > instructions for you.

Anything a human needs but the model does not goes in `description:`, which the compiler keeps out
of the prompt.

## The diagram

Every worker ends with a Mermaid flowchart under a final `## Diagram` heading. Node roles: `start`
(white, exactly one), `decision` (orange), `action` (purple), `success` (green terminal that
writes), `failure` (red terminal), `idle` (dark grey no-op). Pass paths are `-->|✓|`, fail paths
are `-.->|✗|`, node IDs are camelCase and never `end`.

Copy the six `classDef` lines verbatim from `references/diagram.md`.

## Your task

1. Place the trigger on the router. A new kind of work is a new route, not a new trigger. Done when
   the classifier maps the event to exactly one route, the route has a job, and the route matrix
   asserts both.

2. Walk the ladder. Done when:
   - No prompt step asks the model to count, sort, filter, select, or re-derive a fact.
   - Facts the agent needs are precomputed to `/tmp/gh-aw/agent/`.
   - Every guard output is named in the `if:` of what it guards, not only in `needs`.
   - Every `${{ needs.*.outputs.* }}` in the prompt names a custom job, never `pre_activation`.
   - Every job using a local action runs `actions/checkout` first.
   - Every write goes through `safe-outputs`, except an idempotent pre-agent reservation.

3. Wire the caller job. Done when `permissions: write-all`, the concurrency group is keyed on the
   thing that must not overlap, the inputs match the worker's declared inputs exactly, secrets are
   explicitly mapped (not `secrets: inherit`), and a comment records why `write-all`.

4. Write the prompt body. Done when a reader can follow it without the YAML, stop conditions come
   first, label items use `item_number` and `labels`, and the last step carries the `## Diagram`
   exclusion line verbatim.

5. Render the diagram. Done when every check in `references/diagram.md` passes.

6. Add the ownership header. Done when the first line (YAML) or second line (Markdown inside `---`)
   carries `# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/<file>. Update with
   \`workflows update --force\`; consumer edits may be overwritten.`

7. Verify. Done when `node loops/scripts/compile-agent-workflows.mjs` reports zero errors, the route
   matrix passes, every composite manifest lints, the compiled job list is the one you intended, and
   one real event has been observed end to end. The static checks cannot see a startup failure. See
   `references/verify.md`.

## Not-for boundaries

- Ordinary CI. A build-and-test workflow is plain YAML. A gate that sometimes reaches a different
  verdict is not a gate, so CI workflows must never involve a model.
- Public repositories on a self-hosted runner. A fork PR would execute arbitrary code on the box
  holding the credentials.

## Source repository policy

Generated `*.lock.yml` and `actions-lock.json` stay untracked in this source repository. Consumers
compile their own locks after installation. Do not commit generated artifacts to `loops/`.

## References

Load these as needed; do not read all of them up front.

| File | Read it when |
|---|---|
| `references/determinism.md` | Moving work down the ladder, shaping a workflow, the router classifier and its test, the patterns, the composite action taxonomy |
| `references/frontmatter.md` | Any frontmatter field: the verified surface, triggers, filters, the merge table for imports, the worker contract, step ordering, known gaps |
| `references/safe-outputs.md` | What a workflow may write, staged versus framework writes, the App token pattern, the conclude/incomplete skeleton |
| `references/opencode.md` | The engine, the Forge wiring, the `tools:` trap, budgets, bot PRs, self-hosted runners |
| `references/diagram.md` | Writing the `## Diagram` section. Contains the verbatim `classDef` lines |
| `references/verify.md` | Compiling, compiling on commit, quietening the agent log, linting, probing an unfamiliar field, debugging a failed run, what static checks cannot catch |
