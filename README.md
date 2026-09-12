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
| `merge-gate` | `agent-merge-gate.md` | CI reports on a bot pull request | one of `auto-merge`, `human-review`, `owner-review` or `blocked`, or a fix pushed to the same branch |
| `apply-review` | `agent-apply-review.md` | someone reviews or comments on a bot pull request | the requested changes pushed to that pull request |
| `audit` | `agent-audit.md` | Mondays, or on demand | one issue of findings, labelled `refine` so it gets sized and split |
| `release` | `agent-release.md` | on demand (`operation=release`) | a tagged GitHub Release with AI-generated release notes |

Plus the plumbing, which has no agent in it: `work-router.yml` (the router itself),
`authorize-bot-work.yml` (a human's label is checked, then the bot re-labels so the workers see
a trusted actor), and the `classify-route` / `verify-route-matrix` composite actions.

### Keeping itself running

Two deterministic jobs exist because the measured problem was never bad decisions, it was
silence. Across four consumers, 58 of the 237 issues closed since 1 August were closed by the
bot: autonomy between 6% and 50%. The rest stopped somewhere and told nobody.

| Job | Runs | Does |
|---|---|---|
| `housekeeping` | `23 */6 * * *` | retries work that **stalled** (a crash, a timeout, an empty output) after 6h, up to 3 times; drops `pr-pending` from issues no open pull request closes; closes a split parent once every child is closed; deletes branches whose pull requests are all finished and bot-authored; rewrites one issue, **Needs a human**, listing what genuinely needs a person |
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
more is split into children of 5 or less, and each child walks the same path on its own. Audit
creates work rather than consuming it, and files into `refine` rather than straight to
`implement`, so a report of several unrelated findings becomes one properly sized issue per
finding instead of one pull request that has to fix them all.

A merge-gate verdict parks the **code** it was given on, not the CI run that prompted it. Both
paths that dispatch the gate compare the standing verdict against the newest commit on the
branch: re-run CI as often as you like and the park holds, but push a commit -- which is what
apply-review and a `remediated` verdict both do -- and the gate decides again, because that is
new code nobody has ruled on. They used to compare against the CI *finish time*, which made the
park worthless: any later run on the same commits was newer than the verdict, so the belt
re-dispatched a pull request a human already owned and handed it a fresh budget of six ~120-minute
gate runs at the same time. One pull request sat parked for six days while that happened.

Two labels are the controls a person has: `review` parks anything for a human, and `future`
holds a refined issue back from implementation until it is removed. A third label, `pr-pending`,
marks issues whose bot PR is open and awaiting merge-gate — it is informational only and does
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

Not like a timeout. The issue gets the worker's ordinary incomplete comment — *"ended
without an outcome"*, with the label left in place for a retry — which reads as though the
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
minute each, with turn 32 producing 6,479 tokens — the finished story — and the clock running
out in the few short turns that would have submitted it. Forty minutes bought about
thirty-six turns whatever it was asked to refine.

The token table at the end of every agent job log is where to look: turn count, output tokens
and duration per turn. An agent that is looping shows many turns with small outputs and no
large one; an agent that ran out of clock shows the large one near the end.

#### A run keeps the timeout it was dispatched with

A workflow run reads its lock when it starts. Raising a timeout and pushing does nothing for
runs already in flight — they finish, or die, on the old number. Re-trigger after the push if
you want the new one.

## Releasing

`agent-release.md` generates a tagged GitHub Release with AI-written release notes. Trigger it
manually via `workflow_dispatch` with `operation=release`. The agent reads the commit log since
the last tag, categorizes commits by conventional-commit prefix, and writes release notes to
`/tmp/gh-aw/agent/release-notes.md`. A deterministic `conclude` job then bumps the version
(`auto` detects `BREAKING CHANGE` → major, `feat:` → minor, else → patch), commits, tags, pushes,
and creates the GitHub Release.

```bash
gh workflow run work-router.yml --repo PlainConceptsPlatform/<repo> -f operation=release -f version-bump=auto
```

`version-bump` accepts `auto`, `patch`, `minor`, or `major`. The worker only needs
`OPENAI_API_KEY` — it uses `github.token` for git operations and `gh release create`.

## Scheduling across repositories

One worker runs on a timer and it is long: `audit` takes about 45 minutes. Every repository
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

The other value in that block is `CI_WORKFLOW_NAME`, the name of the CI workflow the merge belt
reads its verdict from. It works the same way, mirrored into the `workflow_run` trigger, and
getting it wrong is equally quiet: the belt logs no completed CI run and the pull request waits.

The daily and hourly crons (`audit-close`, `cleanup-artifacts`, `reconcile-bot-pr-runs`,
`housekeeping`, and the optional error report) do not need staggering: they run on
GitHub-hosted runners and never touch the fleet. The reconcile cron runs hourly at minute 17.

The rest of that `env:` block belongs to the janitor and the audit chain, and each value is a
repository's to change:

| Value | Default | Means |
|---|---|---|
| `HOUSEKEEPING_RETRY_AFTER_HOURS` | `6` | how long a `stalled` issue waits before a retry |
| `HOUSEKEEPING_MAX_RETRIES` | `3` | retries before the issue is left to a person |
| `HOUSEKEEPING_STALE_PR_DAYS` | `3` | a bot pull request older than this with no gate verdict is reported, never closed |
| `HOUSEKEEPING_DIGEST_TITLE` | `Needs a human` | the one issue listing what needs a person; empty turns the digest off |
| `AUDIT_STALE_AFTER_DAYS` | `14` | when an unactioned audit report stops blocking the next audit |
| `MAX_GATE_ATTEMPTS` | `6` | failed merge-gate attempts one pull request head may consume before the belt parks it |

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

The `triage` route gates issues opened from outside the organisation. **The gate is organisation
membership, not permission level.** The `authorize` job marks an actor an outside collaborator when they
have Read permission, and also when they have Write or better but their author association is
`COLLABORATOR` — repository access without being one of the organisation's own. So an org member with
write skips triage; an outside collaborator with write does not.

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

At round 3, `needs-info` is no longer valid — the agent must `pass`, `needs-maintainer` or `block`.

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
- `feature-request` installs a feature request issue template to `.github/ISSUE_TEMPLATE/feature_request.yml`. Scoped to small, well-scoped improvements — a Small/Medium dropdown gate steers large work to a planning issue.

Templates are standalone copies placed in `.github/workflows/`. `app-ci-dotnet-next` provides .NET, SQL Server integration testing, Next.js, and security checks. `app-ci-node-monorepo` provides Node monorepo, web, Electron, Capacitor, E2E, and security checks. `github-release` publishes generated GitHub release notes when a `v*` tag is pushed. `bug-report` and `feature-request` install to `.github/ISSUE_TEMPLATE/` instead of `.github/workflows/`. `opencode.ci.json` is always installed as a mandatory file during catalog install; the `--template opencode.ci.json` command is an advanced option for installing it in isolation. Edit their top-level `env:` defaults or JSON properties after copying.

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

- Only the finding object is rendered into a report, and its eight fields are declared in one
  list. `verify-route-matrix.sh` compares that list against the fields the code actually sets,
  and the job re-checks the shape at run time, so a ninth field fails the build and, failing
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
