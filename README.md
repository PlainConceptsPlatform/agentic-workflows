# Agentic Workflows

Source repository for Platform GitHub agentic workflows and the `@plainconceptsplatform/workflows` CLI.

## Layout

- `loops/`: standalone copyable workflow source, arranged like a consumer `.github/`: `actions/` for composite actions, `workflows/` for workers, shared imports, and router, and `scripts/` for compilation.
- `cli/`: TypeScript installer and updater.
- `docs/`: ownership and consumer guidance.
- `skills/`: workflow-author and workflow-consumer skills.
- `runners/`: the ephemeral VM Scale Set fleet the agent workers run on, and the app that scales it.

Consumer repositories generate and commit their own `*.lock.yml` files. This repository does not store generated workflow locks.

## Runner host

The agent workers target `runs-on: agents-arc`. [`runners/`](runners/) builds that fleet,
and [`docs/self-hosted-runners.md`](docs/self-hosted-runners.md) explains what the compiled lock
files do differently from what gh-aw generates, and why. Read the second one before changing
`loops/scripts/compile-agent-workflows.mjs`.

## The workflows

[`docs/diagrams.md`](docs/diagrams.md) draws all of it: the router's one-event-one-route
selection, how the routes chain into each other, and one diagram per worker. Those diagrams used
to sit at the bottom of each worker's markdown, which is the prompt, so every run paid for about
240 lines of Mermaid and then read an instruction telling it to ignore them. `verify-route-matrix.sh`
now fails if one reappears in a prompt.

Every worker is a `workflow_call` reusable workflow. Nothing triggers itself: `work-router.yml`
owns all the triggers, classifies the event into exactly one route, and calls one worker. That
is why a worker can be added or removed without touching the others, and why the route matrix
in `verify-route-matrix.sh` is the thing to run after changing any of them.

| Route | Worker | Starts when | Produces |
|---|---|---|---|
| `triage` | `agent-triage.md` | someone outside the organisation opens an issue | a comment, and either the `refine` label when it passes, the `review` label when it needs a person, or a close when it is genuinely rejected |
| `refine` | `agent-refine.md` | the `refine` label is added | a refined story wrapped in the repository's own issue template with a Fibonacci estimate, or a temporal draft plus questions for the author, or a split into several right-sized issues |
| `implement` | `agent-implement.md` | the `implement` label is added | one branch, one pull request, one issue closed |
| `merge-gate` | `agent-merge-gate.md` | the merge train hands it the oldest open pull request, the bot's or a writer's | one of `auto-merge`, `human-review`, `owner-review` or `blocked`, or a fix pushed to the same branch; a pull request parked for a person gets its screenshots before the decision |
| `apply-review` | `agent-apply-review.md` | someone comments on a bot pull request or requests changes | the requested changes pushed to that pull request. An approval is not feedback: `merge-approved` merges the approved commit when the gate had parked it for a person |
| `audit` | `agent-audit.md` | Mondays, or on demand | one issue of findings, labelled `refine` so it gets sized and split |
| `docs-audit` | `agent-docs-audit.md` | days 1 and 15 of the month, or on demand. Optional: `workflows add docs-audit` | one issue of documentation findings, labelled `docs-audit` + `refine`, only when something is stale |
| `release` | `agent-release.md` | on demand (`operation=release`) | a `chore(release): vX.Y.Z` pull request with auto-merge; `release-tag.yml` tags it and publishes the GitHub Release once it merges |

Plus the plumbing, which has no agent in it: `work-router.yml` (the router itself),
`authorize-bot-work.yml` (a human's label is checked, then the bot re-labels so the workers see
a trusted actor), `release-tag.yml` (installed with the `release` route: tags a merged release
pull request), `evidence.yml` (when a pull request merges, replays the verification plan its
implementation wrote, `pc-repo-verify`, in headless Chromium and archives one screenshot per
waypoint in an `evidence/` folder beside the plan on the default branch, with one comment on the
pull request; when the gate parks a pull request for a person it runs first and keeps a preview on
the `evidence-previews` branch; no model, no secret), and the
`classify-route` / `verify-route-matrix` composite actions.

A plan normally signs in in its first waypoint. One that starts signed in instead says `login:`
(the form every early plan was written in: `login: mock-sso`, and the account in prose), and the
replay signs it in with the repository's own `.github/evidence/sign-in.yml`, read from the default
branch so replays of older pull requests find it too. The repository owns that file; an update
never writes it. `{account}` is the account the plan asks for ("Sign in as Bob Builder"), or the
first one listed:

```yaml
accounts: [Alice Admin, Bob Builder, Carol Chen]
steps:
  - open: /
  - click: { role: button, name: "{account}" }
  - wait: { role: button, name: New bot }
```

Without the file such a plan replays signed out, and its comment says why. A plan that says
`login:` but clicks one of those accounts in its first waypoint already signs itself in, and is
left to.

### Keeping itself running

Two deterministic jobs exist because the measured problem was never bad decisions, it was
silence. Across four consumers, 58 of the 237 issues closed since 1 August were closed by the
bot: autonomy between 6% and 50%. The rest stopped somewhere and told nobody.

| Job | Runs | Does |
|---|---|---|
| `housekeeping` | `23 */6 * * *` | retries work that **stalled** (a crash, a timeout, an empty output) after 6h, up to 3 times; drops `pr-pending` from issues no open pull request closes; closes a split parent once every child is closed; **stacks**: closes feature and child issues whose pull requests landed but whose close was lost, and reports held, orphaned and unfinished stacks in the digest; deletes branches whose pull requests are all finished and bot-authored; rewrites one issue, **Needs a human**, listing what genuinely needs a person |
| `audit-close` | `43 3 * * *` | closes an audit report once every issue it references is closed, and labels a report nobody actioned `stale-audit` after 14 days so it stops blocking the next audit |

The rule that shapes the janitor: **retry a failure, report a decision.** `stalled` marks a park
the machine caused, and those are worth running again. A triage `needs-maintainer`, a refine
`questions` or any merge-gate disposition other than `auto-merge` is a decision reached on
purpose, and re-running a decision only reproduces it, so those are listed in the digest and
never retried.

The digest also carries the gate's own scoreboard: the share of dispositions that were
`auto-merge` over the last fortnight, the split across the rest, and how many auto-merged pull
requests were later reverted. That last number is the one that has to stay flat while the first
one climbs.

It runs on the App token, because GitHub starts no workflow run from an event raised with
`GITHUB_TOKEN` -- with the default token every retry would be a green no-op. Every write goes
through one wrapper, which is the only place `dry-run` is read, so `operation=housekeeping` with
`dry-run` on prints exactly what it would change and writes nothing. `verify-route-matrix.sh`
asserts all of that, including that it closes only two kinds of issue.

### How the routes chain

The normal life of a piece of work is `refine` → `implement` → CI → `merge-gate` → merged, with
no human in the loop unless a worker asks for one. Refine decides the size: an estimate of 8 or
more is split into children of 3 to 5 points, and each child walks the same path on its own. A
slice smaller than 3 points is a fragment and is folded into a sibling. Audit
creates work rather than consuming it, and files into `refine` rather than straight to
`implement`, so a report of several unrelated findings becomes one properly sized issue per
finding instead of one pull request that has to fix them all.

Comments and tests are measured, not requested. When the repository has agent-harness 3.2.0 or
later, implement and apply-review run its `.opencode/scripts/check-diff.mjs` with their
verification, and the merge gate runs it on the pull request head before the agent starts. A
failing `check-diff` never auto-merges: the gate agent deletes what it lists and pushes, like a
CI repair. The shape of the tests is a trophy, not a pyramid (mostly integration, unit tests only
for logic with real branching, few E2E); `check-diff` enforces how much a change may add, and the
guidance on shape lives in Foundations (`backend.mdx`, `frontend.mdx`) and is repeated in the
implement and apply-review prompts.

Workers verify with the repository's own command. A full-stack (.NET + pnpm) or Node repository
gets `VERIFY_COMMANDS: "pnpm verify"`, and that script should run what CI blocks on. `update`
replaces a value the package wrote earlier, keeps one a person wrote, and warns when the
repository has no `verify` script.

### Stacked features

When a split's children build on each other rather than standing alone, refine can open a
**stack**: one feature branch `feat/<issue>`, a root pull request on it (the spec and a failing
acceptance journey, open from the start, based on the default branch), and each child implemented
as an ordinary issue with `implement` whose pull request targets the feature branch. The router's
`check-stack-branch` job reads the child's `stack-root-branch` marker and dispatches implement
with `ref:` set to the feature branch, so the same worker that writes flat work writes stacked
work; merge-gate auto-merges children into the feature branch with the risk assessment
unchanged, and closes each child issue exactly as it does on the default branch.

A root is held while children are still landing. When the last child lands, the router's
stack-completion check announces on the root pull request that the feature is ready, and the merge
gate then decides the root like any pull request: it merges itself unless the blast radius, a
protected path or a finding sends it to a person (`STACK_ROOT_AUTOMERGE: "false"` keeps every root
for a person). The merge closes the feature issue. Housekeeping backstops the races around that: a child issue left open
by a lost close is closed when its pull request has merged, and a finished-but-never-announced
or held-for-days root gets one line in the digest.

All of it is gated on markers, not labels: a repository whose issues carry no
`stack-root-branch` / `stack-root-pr` markers runs the flat pipeline above, byte for byte what
it ran before stacks existed, with no new labels and no new routes firing.

### Unattended

`UNATTENDED: "true"`, set on both the router and the merge gate, is for a repository that is left
to work alone: the people refine and answer questions by day, the pipeline builds by night.

- The merge gate merges a pull request whose only reason for a person is a judgement call: agent
  confidence under the threshold, acceptance criteria reported unmet, a change reported hard to
  undo. Its comment names what was accepted. A measured fact still stops the merge: CI, a
  verified critical or high finding, a protected or owner path, a high blast radius, a failing
  check-diff, anything the workflow could not measure.
- Features chain. A feature issue blocked by another (GitHub's "blocked by" relation, or a
  `Blocked by #N` line in its body) keeps its children held until that feature's stack root merges.
  The router's `stack-landed` job then merges the default branch into the waiting feature's branch,
  releases its children, and opens an **Unattended report** issue listing the pull requests that
  merged, labelled `needs-human` when any merged on a judgement call. A branch that will not merge
  cleanly keeps its feature held and labels it `needs-human`.

With `"false"`, the default, none of this runs.

### The merge train

Open pull requests merge one at a time, the lowest number first, whether the bot or a person
with write access opened them. The router's `merge-train` job moves the one in front a single
step and leaves the rest alone:

| The oldest pull request that can move | The train |
|---|---|
| CI still running | waits |
| green but behind its base branch | merges the base in (never rebases), so CI judges it against what it will land on |
| red, or conflicting | hands it to the merge gate, which repairs and pushes |
| green and up to date | hands it to the merge gate, which reviews and squash-merges |
| parked for a person, a draft, or labelled `hold` | passes it by, so it never blocks the line |

It ticks on every merge, every CI completion, after every gate, and hourly as the fallback. Merges are one at a time; a red pull request is repaired in parallel with the others (`MERGE_TRAIN_REPAIRS`), because a repair pushes to its own branch and never merges, so a
night or a weekend of pull requests drains without anyone merging by hand. Before the train, every
eligible pull request was sent to the gate at once; each merge then moved the default branch under
the rest, and a parked verdict never expired, so a batch left on Friday was still waiting on Monday.

Only what is genuinely dangerous to merge unseen waits for a person: a change under `.github/`, a
secret (a `secrets` file or directory, an `.env` file, a key or certificate), or more than 10000
changed lines not counting tests, docs, translations and generated code. Auth, identity,
migrations and infrastructure are review hints now, not stops; a change the agent shows cannot be
undone, a verified high finding, or low confidence from the agent still parks.

A merge-gate verdict parks the **code** it was given on, not the CI run that prompted it. The train
compares the standing verdict against the newest commit on the branch: re-run CI as often as you
like and an owner or human review holds, but push a commit -- which is what apply-review and a
`remediated` verdict both do -- and the gate decides again, because that is new code nobody has
ruled on. A `blocked` verdict, or a merge that did not happen, expires when the base branch moves,
up to `MERGE_TRAIN_MAX_RETRIES` times: the failure may have been the base's.

A consumer CI hands its verdict to the train from its last job (`dispatch-merge-train` in
`templates/ci`), because GitHub sends no `workflow_run` event for CI a bot started. A CI that still
dispatches `operation=merge-gate` is treated as the same handover until it is updated.

Three labels are the controls a person has: `review` parks anything for a human, `future`
holds a refined issue back from implementation until it is removed, and `hold` keeps a pull
request off the merge train. A third label, `pr-pending`,
marks issues whose bot PR is open and awaiting merge-gate it is informational only and does
not route or block anything.

### Timeouts

Two different things carry a timeout and only one of them is ours.

**The agent step.** `timeout-minutes:` in a worker's frontmatter compiles to a
`timeout-minutes` on the `Execute OpenCode CLI` step: the wall clock the agent has to read,
think and call its safe-output tools. This is the one that matters and the one to change.

**The framework's own job timeout.** gh-aw puts 45 minutes on the deterministic jobs it
generates around the agent (`safe_outputs`, `validate_output`, `conclusion`). It is not read
from our frontmatter and there is nothing to tune; if you see 45 in a lock file next to a
number you did not write, that is what it is.

| Worker | Agent step | Why |
|---|---|---|
| `agent-implement.md` | 90 | Writes code, runs a build and a test suite, and pushes a branch. |
| `agent-merge-gate.md` | 120 | Reviews the diff for defects, and may fix failed CI and re-push. |
| `agent-refine.md` | 60 | Reads the repository to ground a story, then rewrites one issue body. |
| `agent-apply-review.md` | 45 | Applies review comments to an existing branch. |
| `agent-audit.md` | 45 | Sweeps the repository and writes one findings issue. |
| `agent-release.md` | 30 | Reads the commit log and writes release notes. |
| `agent-triage.md` | 30 | Judges one issue and comments. |

#### What a timeout looks like

Not like a timeout. The issue gets the worker's ordinary incomplete comment *"ended
without an outcome"*, with the label left in place for a retry which reads as though the
agent had nothing to say. The real cause is one line in the agent job's log:

```
##[error]The action 'Execute OpenCode CLI' has timed out after 40 minutes.
```

So when a worker keeps producing no outcome on the same issue, read the agent job's
conclusion before reading its output. `failure` with `validate_output` skipped is a killed
step; `success` with an `incomplete` job that ran is an agent that finished and produced
something the validator rejected. Those are unrelated problems.

#### Choosing a number

The binding constraint is usually the model's pace rather than the size of the work. Refine
sat at 40 minutes and was raised to 60 on the evidence of a run that died having done the
job: 36 model turns, most of them returning under 110 output tokens and still taking over a
minute each, with turn 32 producing 6,479 tokens the finished story and the clock running
out in the few short turns that would have submitted it. Forty minutes bought about
thirty-six turns whatever it was asked to refine.

The token table at the end of every agent job log is where to look: turn count, output tokens
and duration per turn. An agent that is looping shows many turns with small outputs and no
large one; an agent that ran out of clock shows the large one near the end.

#### A run keeps the timeout it was dispatched with

A workflow run reads its lock when it starts. Raising a timeout and pushing does nothing for
runs already in flight they finish, or die, on the old number. Re-trigger after the push if
you want the new one.

## Releasing

`agent-release.md` prepares a release as a pull request, so `main` can require pull requests and
status checks. Trigger it manually via `workflow_dispatch` with `operation=release`. The agent
reads the commit log since the last tag, categorizes commits by conventional-commit prefix, and
writes release notes to `/tmp/gh-aw/agent/release-notes.md`. A deterministic `conclude` job then
bumps the version (`auto` detects `BREAKING CHANGE` → major, `feat:` → minor, else → patch) on a
`release/v<version>` branch, opens a pull request titled `chore(release): v<version>` whose body is
the release notes, and enables squash auto-merge. Nothing is pushed to `main` and nothing is tagged
by the worker.

```bash
gh workflow run work-router.yml --repo PlainConceptsPlatform/<repo> -f operation=release -f version-bump=auto
```

When that pull request merges, `release-tag.yml` (shipped with the route) sees the
`chore(release): v<version>` commit on `main`, tags it `v<version>`, and publishes the GitHub
Release with the notes from the pull request body. It is idempotent: a release that already exists
is left alone.

Tokens are split on purpose:

- The branch push, the pull request and auto-merge use the Platform App token (`BOT_APP_ID` /
  `BOT_PRIVATE_KEY`), because a `GITHUB_TOKEN` push starts no workflows and the required checks
  would never report.
- The tag and the GitHub Release use `GITHUB_TOKEN`, because a `GITHUB_TOKEN` write starts no
  workflows. A repository that deploys to production on `v*` tags therefore does not deploy
  because a release was cut, exactly as before the release became a pull request.
- A merge into the default branch also posts a `repository_dispatch` of type
  `agentic-post-merge`, with the merge commit in `client_payload.sha`. GitHub does not always create
  a push run for a merge the App performs, so a consumer that deploys on push adds that event to its
  deploy workflow's triggers.

`version-bump` accepts `auto`, `patch`, `minor`, or `major`. The worker needs `OPENAI_API_KEY`,
`BOT_APP_ID` and `BOT_PRIVATE_KEY`. Auto-merge must be allowed on the repository
(`gh api -X PATCH repos/<owner>/<repo> -F allow_auto_merge=true`); without it the pull request is
left open with a warning on the run, and merging it by hand (squash) still tags the release.

## Publishing to npm

Publishing `@plainconceptsplatform/workflows` is triggered by a GitHub Release: a stable
release `v<version>` on `main` publishes with the `latest` dist-tag, and a prerelease
`v<version>-alpha.<n>` from the `alpha` branch publishes with the `alpha` dist-tag. An
alpha can also be published from any branch on demand: **Actions → Npm Publish → Run
workflow** picks the next unused alpha number itself. The
[`npm-publish.yml`](.github/workflows/npm-publish.yml) workflow runs the same gates as CI
before publishing. Setup, runbooks, and verification commands live in
[docs/release.md](docs/release.md).

## Scheduling across repositories

Two workers run on a timer. `audit` is the long one, about 45 minutes, and `docs-audit`, if a
repository installs it, is the same shape with less to read. Every repository
installs the same router from this package, so unless the schedule is changed at install time,
**every consumer fires it at the same minute**. The agent fleet is shared by every consumer and
deliberately small, so two repositories auditing together already consume all of it while CI and
merge gates queue behind them.

Give each repository its own slot. The scheme below puts one audit on each day of the week:

| Slot | Repository | Audit |
|---|---|---|
| 0 | first consumer | `17 1 * * 1` Mon |
| 1 | second consumer | `17 1 * * 2` Tue |
| 2 | *free* | `17 1 * * 3` Wed |
| 3 | *free* | `17 1 * * 4` Thu |
| 4 | *free* | `17 1 * * 5` Fri |
| 5 | *free* | `17 1 * * 6` Sat |
| 6 | *free* | `17 1 * * 7` Sun |

Seven slots is the ceiling for this shape. Beyond that, either widen the fleet (`MAX_VMS` in
`runners/scaler-app`) or accept that the eighth repository shares a day with the first.

A slot is one value: `AUDIT_CRON` in the `env:` block at the top of
`.github/workflows/work-router.yml`. The classifier reads it from there, and `workflows update`
copies it into the `schedule:` line below, which has to be a literal because GitHub evaluates no
expression in a `cron:`. Change it in `env:` and run `workflows update`, or edit both together;
`verify-route-matrix.sh` asserts the two agree and that the cron reaches its route, because a
cron in one place and not the other fails in the direction that hurts, with the run firing and
then classifying to no route at all.

`docs-audit` works the same way through `DOCS_AUDIT_CRON`. It runs twice a month, so a slot is a
pair of days, and the default `47 2 1,15 * *` starts after a slot-0 audit has finished:

| Slot | Repository | Docs audit |
|---|---|---|
| 0 | first consumer | `47 2 1,15 * *` |
| 1 | second consumer | `47 2 2,16 * *` |
| 2 | *free* | `47 2 3,17 * *` |
| 3 | *free* | `47 2 4,18 * *` |

A scheduled run stops before the model starts when the default branch has no commits in the last
`DOCS_AUDIT_QUIET_DAYS` days (17, the longest gap between runs), because nothing can have drifted.
A dispatched run always goes ahead. `docs-audit` reports count against their own backpressure, one
at a time, and `audit-close` closes and marks them stale exactly as it does audit reports.

The other value in that block is `CI_WORKFLOW_NAME`, the name of the CI workflow the merge belt
reads its verdict from. It works the same way, mirrored into the `workflow_run` trigger, and
getting it wrong is equally quiet: the belt logs no completed CI run and the pull request waits.

The daily and hourly crons (`audit-close`, `cleanup-artifacts`, `reconcile-bot-pr-runs`,
`housekeeping`, and the optional error report) do not need staggering: they run on
GitHub-hosted runners and never touch the fleet. The reconcile cron runs hourly at minute 17 and
ticks the merge train.

The rest of that `env:` block belongs to the janitor and the audit chain, and each value is a
repository's to change:

| Value | Default | Means |
|---|---|---|
| `HOUSEKEEPING_RETRY_AFTER_HOURS` | `6` | how long a `stalled` issue waits before a retry |
| `HOUSEKEEPING_MAX_RETRIES` | `3` | retries before the issue is left to a person |
| `HOUSEKEEPING_STALE_PR_DAYS` | `3` | a bot pull request older than this with no gate verdict is reported, never closed |
| `HOUSEKEEPING_DIGEST_TITLE` | `Needs a human` | the one issue listing what needs a person; empty turns the digest off |
| `AUDIT_STALE_AFTER_DAYS` | `14` | when an unactioned audit report stops blocking the next audit |
| `MAX_GATE_ATTEMPTS` | `6` | failed merge-gate attempts one pull request head may consume before the train passes it by |
| `MERGE_TRAIN_HOLD_LABEL` | `hold` | a pull request with this label stays off the merge train |
| `MERGE_TRAIN_MAX_RETRIES` | `3` | how often a `blocked` verdict is retried after the base branch moves |
| `MERGE_TRAIN_DRY_RUN` | `false` | `true` logs the move the train would make and makes none |
| `MERGE_TRAIN_REPAIRS` | `1` | how many pull requests may be in repair at once; a repair never merges so repairs do not race, while merges stay one at a time, oldest first |
| `IMPLEMENT_PARALLELISM` | `1` | how many implement runs work at once; the children of one refine always share a queue and run one after another |

## Consumer prerequisite

Before installing or compiling these workflows, consumer repositories should install and configure [`PlainConceptsPlatform/agent-harness`](https://github.com/PlainConceptsPlatform/agent-harness). Loop workers invoke the skills and commands it provides. Verify the required skills and commands are available in the consumer repository before compiling.

## Quick start

The primary entrypoint is the interactive TUI. Run it with no arguments:

```bash
npx @plainconceptsplatform/workflows
```

The TUI lists all routes and templates with install status. Use arrow keys to navigate, space to toggle, and Enter to install selected items. Selecting any route installs the full managed catalog (actions, workflows, router, compile script) plus the mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. Selecting only templates still installs those two mandatory files.

## Advanced (non-interactive) commands

For automation or scripting, non-interactive commands are available:

```bash
npx @plainconceptsplatform/workflows@latest init
npx @plainconceptsplatform/workflows@latest add
npx @plainconceptsplatform/workflows@latest add refine implement
npx @plainconceptsplatform/workflows@latest add triage
npx @plainconceptsplatform/workflows@latest add audit
npx @plainconceptsplatform/workflows@latest add release
npx @plainconceptsplatform/workflows@latest add --template agentics-checks
npx @plainconceptsplatform/workflows@latest add --template agentics-maintenance
npx @plainconceptsplatform/workflows@latest add --template app-ci-dotnet-next
npx @plainconceptsplatform/workflows@latest add --template app-ci-node-monorepo
npx @plainconceptsplatform/workflows@latest add --template bug-report
npx @plainconceptsplatform/workflows@latest add --template feature-request
npx @plainconceptsplatform/workflows@latest remove triage
npx @plainconceptsplatform/workflows@latest update --dry-run
npx @plainconceptsplatform/workflows@latest update
npx @plainconceptsplatform/workflows@latest --version
```

`add` (catalog install) always installs `opencode.ci.json` and `scripts/compile-agent-workflows.mjs` alongside managed loop files. They are mandatory.

## Changing the installed route set

The router (`work-router.yml`) is a derived file: its content is a function of which routes are installed. The CLI owns that assembly so the router always references exactly the workers on disk, never more. The classifier is the complete route table everywhere (a route with no job is a no-op run), and the route matrix reads the installed worker files, so neither is rewritten.

- `add <routes>` unions the requested routes with the routes already installed, then regenerates the router from the union. Adding a route later keeps the ones already there instead of dropping them.
- `update` (and `add` with no routes) refreshes exactly the installed set. It never adds or removes a route.
- `remove <routes>` drops the requested routes from that set, regenerates the router, and deletes each removed worker's `agent-<route>.md` and generated `agent-<route>.lock.yml`.
- The interactive TUI is desired-state: the checked routes are the target set. Checking a new route adds it; unchecking an installed route removes it. Enter on an unchanged selection is an update.

`release` is a route like the other six. A repository that never installed it does not receive it on update.

For a project-local development dependency, install `@plainconceptsplatform/workflows` and run `pnpm exec workflows` with no arguments to launch the TUI, or `pnpm exec workflows <init|add|update>` for non-interactive use.

## Turning the automation off

A repository variable `AGENTIC_WORKFLOWS_DISABLED`, with any value, turns every installed workflow
off without uninstalling anything: the router's first two jobs skip, so no route runs, and
`authorize-bot-work`, `release-tag` and the error-report templates skip too. Use it for a
repository that has the workflows but is not ready for them, or to pause one. Labels and comments
still land on issues; nothing acts on them until the variable is deleted.

```bash
gh variable set AGENTIC_WORKFLOWS_DISABLED --body true
```

```bash
gh variable delete AGENTIC_WORKFLOWS_DISABLED
```

`agentics-checks` (workflow and lockfile linting on pull requests) keeps running: it checks files
and acts on nothing.

## Updating a consumer

Every installed file carries the package version in its ownership header, stamped at install
time:

```
# Managed by @plainconceptsplatform/workflows@0.7.0. Source: loops/workflows/agent-refine.md. Update with `workflows update --force`; consumer edits may be overwritten.
```

`workflows update` replaces every package-managed file with this version's and re-stamps it.
The `env:` block at the top of a worker is the one part of it that belongs to the repository,
so the merge keeps it:

- Your values stay. A key the package added arrives with its default. A key only you defined
  stays at the end of the block.
- When the header records the version you installed from, that release is fetched from npm
  (`npm pack`) and used as the merge baseline: a value you never changed follows the package
  when its default changes, and a key the package removed disappears if you never changed it.
  Offline, every one of your values is kept and the result says the baseline was unavailable.
- The agent runner pool (`runs-on`) and the engine gateway URL are kept too, because GitHub
  gives them no home in `env:`.

Everything else in a package-managed file is the package's, byte for byte: the prompt body, the
jobs, the composite actions, the shared imports, the compile script. If a change is worth
making, make it in `loops/` and let every repository get it; if it must differ per repository,
it has to be an env variable. A file whose ownership header was removed is yours and is left
alone unless `--force` is passed. Templates are yours from installation and are replaced only
with `--force`.

`update --dry-run` prints the plan as JSON without writing: per file `added`, `updated` (with
the env keys kept and the defaults applied), `unchanged` or `skipped`, plus the installed and
package versions.

## Triage route for outside collaborators

The `triage` route gates issues opened by people with read-only access. **The gate is permission
level, not organisation membership.** The `authorize` job marks an actor an outside collaborator only
when they have Read permission. Anybody with Write or better skips triage, org member or not: an
outside collaborator who was given write is somebody the team chose to work with.

When such an issue is opened, the triage agent runs 10 checks (template completeness, security risk, change
size, danger level, duplicate detection, clarity, reproducibility, acceptance criteria quality,
cross-cutting impact, product-owner eligibility) and loops up to 3 rounds. The author or any write+ user can
comment to re-trigger triage after a `needs-info` verdict.

- **pass**: all checks pass → bot adds `refine` label → enters the normal pipeline (refine → implement) with no human in the loop.
- **needs-info**: needs clarification → bot posts questions, adds `review` label, keeps `triage` → author or write+ user replies → re-triage.
- **needs-maintainer**: legitimate work, wrong door. Outside product-owner scope, so it needs a maintainer-owned technical proposal → the issue **stays open**, gets `review`, and loses `triage` so later comments do not re-trigger triage. A maintainer takes it on by adding `refine`.
- **block**: cannot be done, security risk, too dangerous to automate, or still ambiguous after 3 rounds → bot closes the issue with an explanation.

Only `block` closes. Out-of-scope work used to close too, which lost it: a reproducible authorization
defect that passed nine of the ten checks was closed as `not_planned` with every label stripped, and
nothing distinguished it from junk somebody rejected. That is what `needs-maintainer` exists for.

At round 3, `needs-info` is no longer valid the agent must `pass`, `needs-maintainer` or `block`.

Install the triage route alongside other routes:

```bash
npx @plainconceptsplatform/workflows@latest add triage
npx @plainconceptsplatform/workflows@latest add audit
```

## Optional agentic maintenance templates

`add` and `update` install only package-owned loops. They do not install maintenance templates. Install a template explicitly with `add --template <name>`; use `--force` only to replace a changed copy.

- `agentics-checks` verifies generated lockfiles and lints agentic workflow source on pull requests.
- `agentics-error-report` looks at how *this package's* workflows behaved here in the last day and files what broke upstream, so the package gets fixed instead of every repository working around the same bug. Worth installing everywhere; see the privacy contract below.
- `github-release` publishes a GitHub Release with generated notes when a `v*` tag is pushed.
- `agentics-maintenance` is the `gh aw` generated maintenance workflow. It is supplied for repositories that want to commit the generated workflow before their first compilation.
- `bug-report` installs a bug report issue template to `.github/ISSUE_TEMPLATE/bug_report.yml`. Bugs can be any size.
- `feature-request` installs a feature request issue template to `.github/ISSUE_TEMPLATE/feature_request.yml`. Scoped to small, well-scoped improvements a Small/Medium dropdown gate steers large work to a planning issue.

Templates are standalone copies placed in `.github/workflows/`. `app-ci-dotnet-next` provides .NET, SQL Server integration testing, Next.js, and security checks. `app-ci-node-monorepo` provides Node monorepo, web, Electron, Capacitor, E2E, and security checks. `github-release` publishes generated GitHub release notes when a `v*` tag is pushed. `bug-report` and `feature-request` install to `.github/ISSUE_TEMPLATE/` instead of `.github/workflows/`. `opencode.ci.json` is always installed as a mandatory file during catalog install; the `--template opencode.ci.json` command is an advanced option for installing it in isolation. Edit their top-level `env:` defaults or JSON properties after copying.

### What the error report files, and what it only counts

The report used to open one issue for every failure it saw. Over a month that was 320 issues:
59% were cancelled jobs, 80% carried no diagnosis, 14% were a runner shut down under a job, 47%
re-filed a signature seen before, and every one was closed as not planned with no comment. It now
files a defect and counts the rest.

- **Counted in the job summary, never filed:** a cancelled job that never reached a failing step, a
  job whose log could not be read, and the fleet's own transient causes (a runner lost mid-job,
  never assigned, a rate limit, the model gateway unreachable, out of disk or memory). Nobody can
  fix those by editing a workflow, and a trend is visible in a number.
- **Classified with the job's annotations too.** GitHub writes why a runner went away into the
  annotations, not the log, so both are matched against the catalogue. The template grants
  `checks: read` for that.
- **One cause is one issue.** The job and step are not part of the identity of a specific cause,
  so a 403 that fails three jobs of the router is one finding. A cause nobody could name is told
  apart by its step. Each finding carries a severity: `infra`, `package-bug` or `unknown`.
- **Not before it repeats, and not too many.** A new issue needs `min-occurrences` (default 2) in
  the window and a run opens at most `max-findings` (default 5), the most frequent first. An issue
  that is already open is always appended to.
- **A closed issue stays closed.** A signature closed within `quiet-days` (default 30) opens
  nothing, whatever the reason it was closed. The search used to look at open issues only.

The decisions live in `loops/actions/report-workflow-errors/report-policy.cjs`, apart from what
the action reads and writes, and `verify-route-matrix.sh` runs them. Replayed over the 320 issues,
they would have filed 14.

### The error report's privacy contract

Every consumer of this package is a private repository, and `agentics-error-report` is the only
job in the fleet that sends anything out of one. That is its whole design constraint, so it is
worth stating what does and does not cross the boundary.

**What is sent.** A fixed, enumerable set of facts about workflows this package itself ships:
the workflow's file name, the job and step names, a conclusion, a runner label, an occurrence
count, and the id of a matched entry from a catalogue of sixteen known failure shapes
(`jq-error`, `runner-never-assigned`, `gh-api-403`, `model-quota`, and so on).

**What is never sent.** Free text of any kind. No log line, no branch name, no issue or pull
request title, no file path, no commit, no URL, no issue number. A consumer's own workflows are
counted and never inspected at all, because a workflow name can describe a product, a customer
or an environment. And no model runs: a model asked to summarise a failure paraphrases whatever
the log happened to contain, which is exactly the thing that must not leave.

**How that is enforced**, rather than intended:

- Only the finding object is rendered into a report, and its ten fields are declared in one
  list. `verify-route-matrix.sh` compares that list against the fields the code actually sets,
  and the job re-checks the shape at run time, so an eleventh field fails the build and, failing
  that, stops the run.
- A leak scanner reads the finished text and looks for this repository's name, its owner, a
  `github.com` URL, an email address, an absolute path, a token-shaped or commit-shaped blob, an
  issue reference and a branch ref. It fails closed: a report it flags is **not filed**, and the
  run goes red so the field that carried private text gets fixed rather than leaking again the
  next morning.
- The job holds `contents: read` and `actions: read` here and nothing else, and its upstream
  token is minted for the upstream repository alone.

Every one of those guards is mutation-tested: each was deliberately broken and the matrix
confirmed red. Four early versions of the assertions passed against a broken guard -- they
grepped for a symbol name that survived at its other use sites -- and were rewritten to compare
sets and count call sites instead.

To turn the report off in one repository, delete the workflow or clear `UPSTREAM_NAME` in its
`env:` block, which computes the report into the job summary and files nothing.
