# Frontmatter reference

Verified against gh-aw v0.83.4. Where the published docs and the installed compiler disagree, the
compiler wins and the disagreement is noted.

Anything marked Platform is part of the contract in `SKILL.md`; anything marked *avoid* has a reason
attached.

---

## Identity

| Field | Notes |
|---|---|
| `name:` | Platform: required. The display name in Actions, and the string `workflow_run.workflows` matches. Not the filename |
| `description:` | Platform: required. Free prose, compiled into a comment in the `.lock.yml`. Kept out of the prompt, so this is where the human explanation belongs |
| `emoji:` / `labels:` / `metadata:` | Cosmetic or categorising |
| `source:` | `owner/repo/path@ref`. Set by `gh aw add`; enables `gh aw update` |
| `tracker-id:` | Min 8 chars. Tags every asset the workflow creates |

---

## The worker contract

A Platform agentic workflow is a router-only worker: it exposes `workflow_call` and nothing else.

```yaml
on:
  workflow_call:
    inputs:
      issue-number:
        description: Issue number to refine.
        required: true
        type: string
      mode:
        description: Refinement pass mode (first or rerefine).
        required: false
        type: string
        default: first
```

Rules the compiler will not enforce for you:

- The router must pass exactly the declared inputs. Passing an undeclared input, or omitting a
  required one, is a startup failure with no jobs and no annotation.
- A worker declares no `concurrency:`. The router owns it. Both layers apply if you set both, and the
  narrower one silently wins.
- A worker declares no public trigger. Adding one bypasses the router and breaks the
  one-route-per-event guarantee. For a manual entry point, add an operation to the router's
  `workflow_dispatch`.

### The caller job

```yaml
call-refine:
  needs: classify
  if: needs.classify.outputs.route == 'refine'
  uses: ./.github/workflows/agent-refine.lock.yml
  concurrency:
    group: refine-${{ needs.classify.outputs.issue-number }}
    cancel-in-progress: false
  permissions: write-all
  with:
    issue-number: ${{ needs.classify.outputs.issue-number }}
    mode: ${{ needs.classify.outputs.refine-mode }}
  secrets:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}
    BOT_APP_ID: ${{ secrets.BOT_APP_ID }}
    BOT_PRIVATE_KEY: ${{ secrets.BOT_PRIVATE_KEY }}
```

`permissions: write-all` is mandatory, and the reason is not obvious. Every gh-aw agent job compiles
to `permissions: read-all`, which requests read on every scope. A caller granting a tidier explicit
map cannot satisfy that, and GitHub rejects the reusable workflow call before creating any job:

```yaml
permissions:          # looks like least privilege
  contents: read      # is a startup failure: zero jobs, no annotation, no log
  issues: write
  actions: write
```

There is no `read-all plus these writes` syntax. `write-all` at the caller is correct because it is
not the boundary that matters: the worker's own `permissions: read-all` keeps the agent read-only
and `safe-outputs.allowed` lists enumerates every write. Put the reason in a comment next to the
grant, or the next reader will tidy it away.

Keys allowed on a job that calls a reusable workflow: `name`, `needs`, `if`, `permissions`, `uses`,
`with`, `secrets`, `strategy`, `concurrency`. Anything else, including `runs-on`, `env`, `steps` and
`timeout-minutes`, is a syntax error.

Do not use `secrets: inherit`. It hands the called workflow every secret in the repository, and
Semgrep's `github-actions.security.secrets-inherit` rule blocks it, which is enough to keep a deploy
pipeline red on every push. Name what the worker needs explicitly.

That is the engine key, its documented `CODEX_API_KEY` fallback, and the App credentials the
`reserve` and `conclude` jobs mint a token from. gh-aw declares several more on every worker
(`GH_AW_GITHUB_TOKEN`, `GH_AW_GITHUB_MCP_SERVER_TOKEN`, `GH_AW_CI_TRIGGER_TOKEN`,
`COPILOT_GITHUB_TOKEN`), all optional; if the repository does not define them, inheriting them was
already passing nothing.

Check before narrowing, because passing a secret the called workflow does not declare is a startup
failure:

```bash
gh secret list
```

### What stops applying without a public trigger

gh-aw's rung-1 filters are compiled into the activation job's condition and evaluated against a
triggering event. A `workflow_call` worker has no triggering event, so `names:`, `roles:`, `bots:`,
`skip-bots:`, `skip-author-associations:`, `forks:` and `skip-if-*` have nothing to filter. Their
job moves to the router's classifier, where it is ordinary shell and can be tested.

`pre_activation` and `activation` jobs are still generated, and a top-level `if:` is still folded
into the activation condition, so rung 2 remains available.

### Authorizing bot actors for workflow_call workers

gh-aw's `pre_activation` runs `check_membership.cjs`, which checks `github.actor` permission.
Bots like `platform-devbox[bot]` always return `permission: none` because GitHub does not treat
app bots as repository collaborators with write access.

`on.bots:` does not work for `workflow_call` workers (it has no triggering event to filter).
The bypass is `GH_AW_ALLOWED_BOTS`, a workflow-level `env:` variable that `check_membership.cjs`
reads via `parseAllowedBots()`. When the actor matches an entry, the script checks if the bot
is installed on the repository via `getCollaboratorPermissionLevel`. If the API returns 200
(the bot exists and is visible), `isActive: true` is set and `is_team_member: true` flows
through to the `activation` job's condition.

```yaml
env:
  GH_AW_ALLOWED_BOTS: "platform-devbox[bot],github-actions[bot]"
```

This is paired with the **bot-working label pattern**: a human adds `implement`/`refine`/`direct`,
`authorize-bot-work.yml` validates the human's permission and the bot adds `bot-working`, which
triggers the agentic workflow with the bot as `github.actor`.

---

## Router triggers

The router is plain YAML (`loops/workflows/work-router.yml`), so this is the standard Actions surface.

| The work starts when | Trigger |
|---|---|
| A label is added | `issues: [labeled]` |
| An issue is opened | `issues: [opened]` |
| Someone comments on an issue or PR | `issue_comment: [created]` |
| Someone comments on a PR's code | `pull_request_review_comment: [created]` |
| Someone submits a review | `pull_request_review: [submitted]` |
| A PR opens or gets new commits | `pull_request: [opened, synchronize]` |
| A bot opens a PR, with base-repo secrets | `pull_request_target:` |
| A workflow finishes | `workflow_run: [completed]` |
| A human clicks a button | `workflow_dispatch:` |
| Genuinely a clock | `schedule:` |

### `workflow_run`

The chaining trigger, with the sharpest edge: `workflows:` matches the workflow `name:`, not the
filename. Renaming either side breaks it silently.

```yaml
on:
  workflow_run:
    workflows: ["App: CI"]
    types: [completed]
    branches: ["fix/*", "bugfix/*", "feature/*", "bot/*", "patch/*", "hotfix/*"]
```

`branches:` is not optional in practice; the compiler warns without it, because otherwise the workflow
fires for runs on every branch.

`conclusion:` is documented but rejected in v0.83.4. Read
`github.event.workflow_run.conclusion` and branch on it, which is reading a fact rather than making a
judgement.

`github.event.workflow_run.pull_requests[0].number` is frequently empty, notably for forks and for
heads in another repository. Guard for it and route to `none` rather than passing an empty number
down. It is also the pull request number, never the issue number, so do not use it to key an
issue-scoped concurrency group.

`workflow_run` does not fire for PR-triggered CI completions on feature branches. This is not a gh-aw
limitation; it is GitHub's. The trigger works for `push`-to-main CI runs, but `pull_request`-triggered
CI on feature branches does not produce a `workflow_run` event. The merge-gate never hears about the
failure, and the bot PR sits open.

The mitigation is the `stale-recovery` action, which runs on a 2h cron. It queries open bot PRs,
checks if their latest CI run concluded `failure`, and dispatches the merge-gate via
`workflow_dispatch` with `operation=merge-gate`. This requires `actions: write` on the
`stale-recovery` job. See `references/opencode.md` for the full trap description.

### `schedule`

Prefer fuzzy syntax over cron where the exact minute does not matter; the compiler scatters it so
many repositories do not fire at once:

```yaml
on:
  schedule: daily around 14:00
```

The router uses raw cron because the classifier maps each cron string to a route, and that map must
be exact. Keep the cron list in the `on:` block and the mapping in the classifier, and have the route
matrix assert that every cron in the workflow selects a route.

### `run-name`

GitHub titles an issue-triggered run with the issue title, so every run on one issue reads
identically. Derive it from the event:

```yaml
run-name: >-
  ${{ github.event_name == 'issues'
  && format('{0} label on #{1} by {2}', github.event.label.name, github.event.issue.number, github.actor)
  || github.event_name == 'issue_comment'
  && format('comment on #{0} by {1}', github.event.issue.number, github.actor)
  || github.event_name }}
```

The `A && B || C && D || E` chain is the standard idiom: `&&` binds tighter, so each pair yields its
`format()` when the event matches and falls through otherwise.

Two traps. In a `>-` folded scalar, a continuation line indented further than the first is preserved
literally, newline included, so keep every line at the same indent or the expression arrives with
newlines in it. And `run-name` is evaluated when the run is created, before any job exists, so it can
name the trigger but never the route the classifier picks. Allowed contexts are `github`, `inputs` and
`vars`.

---

## Where it runs

| Field | Notes |
|---|---|
| `runs-on:` | Platform: `ubuntu-latest`. The agent job |
| `runs-on-slim:` | Platform: `ubuntu-latest`. The framework jobs. Defaults to `ubuntu-slim` if omitted |
| `timeout-minutes:` | Platform: always set. Default 20, which is too short |
| `env:` | Top-level pairs available to agent `steps:` and interpolated into the prompt. Use for labels, markers, paths, comment templates |
| `concurrency:` | Platform: never on a worker. The router owns it |
| `environment:` | Ties the run to an Actions environment, so protection rules apply |

### Concurrency

The compiler generates a group when you do not, keyed by trigger type: per issue number for `issues`,
per PR number for `pull_request` (and cancels in progress), per ref for `push`, per workflow otherwise.

For a `workflow_call` worker none of that is meaningful, which is another reason the router owns the
key. The groups this package uses:

| Route | Group | Effect |
|---|---|---|
| `refine` | `refine-<issue>` | Issues refine in parallel, one run per issue |
| `implement` | `write-pipeline-<issue>` | One writer per issue |
| `merge-gate` | `write-pipeline-<issue>` | Shares the group with implement, so the two never race |
| `apply-review` | `pr-feedback-<pr>` | Pull requests take feedback in parallel |
| `audit` | `audit` | Singleton |

Sharing a group only works if both sides key on the same thing, which is why the router resolves the
gated pull request's closing issue before dispatching.

---

## What model

| Field | Notes |
|---|---|
| `engine:` | `id`, `model`, `version`, `command`, `args`, `env`, `permission-mode`, `agent`, `api-target`, `bare`. Platform: `opencode` via Forge, see `references/opencode.md` |
| `model:` | Provider segment must be one of `copilot`, `anthropic`, `openai`, `codex` |
| `max-turns:` | Platform: `300`. Tool-loop budget, the real guard against a confused agent looping |
| `max-turn-cache-misses:` | Platform: `3000`. Forge has no prompt cache; every turn is a miss |
| `max-ai-credits:` | Platform: `5000`. Only engages when traffic passes gh-aw's proxy accounting |
| `models:` | `allowed:` / `blocked:` globs, plus pricing overrides |

---

## What it may read

| Field | Notes |
|---|---|
| `permissions:` | Platform: `read-all`. Every write goes through `safe-outputs` |
| `network:` | Platform: explicit. `allowed:` ecosystems and hostnames, plus `blocked:` |
| `tools:` | Ignored under `engine: opencode`. See `references/opencode.md` |
| `mcp-servers:` | Also ignored under opencode |
| `checkout:` | Overrides the default shallow checkout. `fetch-depth`, `fetch`, `repository`, `path`, `sparse-checkout`, `submodules`, `lfs` |
| `cache:` | Standard Actions cache |
| `secrets:` | Platform: map `OPENAI_API_KEY` here for Forge; `engine.env` is rejected by strict compilation |

### Network

`allowed:` accepts ecosystem identifiers and hostnames. Identifiers are validated at compile time, so
a typo is caught rather than silently ignored.

```
defaults  github  local  dev-tools  containers  playwright  chrome  fonts
python  node  go  java  ruby  rust  swift  php  dart  haskell  perl
terraform  bazel  linux-distros  dotnet
```

Prefer ecosystem identifiers over individual hostnames. `dotnet` expands to every NuGet-related
domain and `node` does the same for npm, pnpm and yarn. The compiler will suggest the swap on every
compile if you list hostnames instead.

One leading wildcard is allowed (`*.cdn.example.com`); more is a compile error. A bare hostname
already covers its subdomains.

---

## Deterministic steps

| Field | Runs | Use for |
|---|---|---|
| `on.steps:` | Pre-activation job | Rung 2: gate only |
| `on.permissions:` | Grants scopes to that job | Whatever `on.steps` needs |
| `pre-steps:` | Agent job, before checkout | Minting a token |
| `steps:` | Agent job, after checkout, before the model | Rung 3: precompute into `/tmp/gh-aw/agent/` |
| `pre-agent-steps:` | Agent job, immediately before the model | Setup that must survive the base-branch restore |
| `post-steps:` | Agent job, after the model | Collecting evidence |
| `jobs:` | Separate jobs in the graph | Rung 4: guards, reservation, terminal jobs |

### Which job's outputs the prompt can read

| Job | In the agent job's `needs` | `${{ needs.<job>.outputs.* }}` in the prompt |
|---|---|---|
| a custom `jobs:` entry | yes | resolves |
| `pre_activation` (`on.steps`) | no | empty string |
| `activation` | yes | resolves |

`needs` is not transitive. `activation` depends on `pre_activation` and `agent` depends on
`activation`, but that does not put `pre_activation` in the agent job's `needs` context. The compiler
still emits an env var for the reference, which makes it look supported. It is not, and the symptom is
an empty value rather than an error.

### Being in `needs` does not gate anything

A custom job appearing in the agent job's `needs` means "waits for", not "is gated by". A guard job
that succeeds with a false output lets the agent run, and a guard job that is skipped also satisfies
`needs`.

```yaml
if: inputs.issue-number != '' && needs.eligibility.outputs.eligible == 'true'
```

The second clause is the gate. Without it the guard only ever stopped the jobs that named it in their
own `if:`. Confirm after compiling:

```bash
awk '/^  agent:/{f=1} f&&/^    if:/{print; exit}' .github/workflows/agent-implement.lock.yml
```

### Step ordering inside the agent job

```
Checkout repository
steps:                                         <- rung 3
Checkout PR branch
Restore agent config folders from base branch  <- reverts GH_AW_AGENT_FILES
pre-agent-steps:                               <- after the restore
Write OpenCode Config
Execute OpenCode CLI
```

`GH_AW_AGENT_FILES` covers `AGENTS.md`, `CLAUDE.md`, `opencode.jsonc` and friends, restored from the
base branch on pull-request events. Anything that edits one of those files must run in
`pre-agent-steps:`, or the restore silently undoes it on PR-triggered runs only.

---

## Composition

| Field | Notes |
|---|---|
| `imports:` | Shared markdown. Relative, `.github/`-rooted, or `owner/repo/path@ref`. Append `#Section` for one section, `?` to make it optional |
| `import-schema:` | Declares typed inputs for a shared file |
| `inlined-imports:` | Embeds imports into the lock file. Needed for cross-org `workflow_call` |
| `skills:` | External skill references, `owner/repo@<sha>` |

### What actually merges from an import

Verified by compiling and reading the lock file. Guessing here is expensive, because the failures are
silent.

| Field | Merges? |
|---|---|
| `network` | yes, `allowed` domains unioned |
| `safe-outputs` | yes, each type once, main wins on conflicts |
| `steps` | yes, imported ones prepended |
| `pre-agent-steps` | yes, prepended |
| `post-steps` | yes, appended |
| `tools`, `mcp-servers`, `env`, `checkout` | yes |
| `permissions` | no, validation only |
| `engine`, `model` | no, silently ignored |
| `runs-on`, `runs-on-slim` | no, warns `Ignoring unexpected frontmatter fields` |
| `on:` and its filters | no, except `skip-*` keys, `github-token`, `github-app` |

`permissions` is the trap. `permissions: read-all` in a shared file compiles with no warning at all,
and the agent job silently falls back to `contents: read`. `runs-on` at least warns.

`env` merging is what makes a shared setup file able to carry its own version pins, so the importing
workflow does not have to restate them.

A file appears at most once in an import graph, and circular imports fail at compile time.

This package's shared files:

| File | Merges |
|---|---|
| `loops/workflows/shared/platform-defaults.md` | `network`, `env`, runtime pins, caches |
| `loops/workflows/shared/opencode-ci.md` | `pre-agent-steps`, `env` for OpenCode CI config merge |

The worker owns `permissions`, `engine`, `model`, `runs-on`, `runs-on-slim`, `safe-outputs` policy,
`timeout-minutes`, and trigger inputs. If a value is policy, it must live in the worker, not in an
import.

---

## Templating in the body

| Form | Notes |
|---|---|
| `${{ github.event.* }}` | Event payload |
| `${{ inputs.* }}` | `workflow_call` inputs. The normal way a worker reads its contract |
| `${{ needs.<job>.outputs.<name> }}` | Custom job outputs. Verified to reach the prompt |
| `${{ steps.sanitized.outputs.text }}` | Sanitised triggering comment text. Use this, never the raw body |
| `{{#if expr }}...{{/if}}` | Conditional block |
| `{{#runtime-import path }}` | Inlines a file at runtime; supports `file:45-52` line ranges |

`secrets.*`, `needs.pre_activation.outputs.*`, `env.*`, `vars.*` and `toJson()` are rejected in the
body. That is deliberate: the body is a prompt, and a secret interpolated into a prompt is a leaked
secret.

---

## Known gaps between docs and v0.83.4

| Documented | Reality |
|---|---|
| `on.workflow_run.conclusion: [failure]` | Rejected: `Unknown property: conclusion`. Branch on the payload instead |
| `tools:` under any engine | Dropped entirely under `engine: opencode` |
| `needs.pre_activation.outputs.*` in the prompt | Compiles, resolves empty |
| `github.event.workflow_run.name` in the body | Rejected by the expression allowlist |
| `merge-pull-request`, `link-sub-issue` | Valid, flagged experimental |
| A caller job may narrow `permissions` | Only down to what the worker's `read-all` needs, which in practice means `write-all` |
| `linkPullRequestToIssue` GraphQL mutation | Not in GitHub's public schema. Edit the pull request body |

Before relying on any field this file does not confirm, probe it. `references/verify.md` has the
procedure.

---

## Safety notes

- Unsafe triggers get permission checks by default. Do not disable them with `roles: "all"` without a
  reason you would defend.
- `pull_request_target` runs with the base repository's secrets against a fork's code. The router
  uses it only for the `bot-approve` route, guarded on `github.actor`, with no checkout of the head.
- Untrusted text belongs in `${{ steps.sanitized.outputs.text }}`, never the raw body.
- A workflow is not triggered by its own `GITHUB_TOKEN` writes. It is triggered by writes made with a
  GitHub App installation token, which is the usual cause of a bot triggering itself. See
  `references/safe-outputs.md`.
