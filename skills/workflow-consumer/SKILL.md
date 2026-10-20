---
name: workflow-consumer
description: >
  Install, configure, compile, and safely update Agentic Workflow loops in a consumer
  repository. Load when setting up the `workflows` CLI, adding managed worker files, selecting
  templates, customising worker environment, compiling lockfiles, or recovering from a package
  update.
---

# Workflow consumer

Use in a repository consuming this package. Do not use it to alter this repository's `loops/`
source. This skill is self-contained. Read reference files in `references/` within this folder only.

## Prerequisites

Install and configure `PlainConceptsPlatform/agent-harness` in the consumer repository first.
Workers invoke skills and commands it provides. Before compilation, verify worker-required skills and
commands exist locally.

## Install and update

The primary entrypoint is the interactive TUI. Run it with no arguments to see all available routes
and templates, select what to install, and get mandatory files automatically:

```sh
npx @plainconceptsplatform/workflows
```

For non-interactive use (advanced):

```sh
npx @plainconceptsplatform/workflows@latest init
npx @plainconceptsplatform/workflows@latest add
npx @plainconceptsplatform/workflows@latest update
```

For a project-local development dependency, install the package first and use:

```sh
pnpm add -D @plainconceptsplatform/workflows
pnpm exec workflows              # launch interactive TUI
pnpm exec workflows init
pnpm exec workflows add
pnpm exec workflows update
```

`add <routes>` installs those workers on top of the ones already installed, together with the
mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. `update` (and `add` with no
routes) refreshes exactly the installed set to the package version: every package-managed file is
replaced and its header records the version, and each worker's `env:` values are kept. Run
`update --dry-run` first to see the plan as JSON without writing.

Full install, layout, ownership header, and update conflict handling are in
`references/install.md`.

## Select templates deliberately

Optional templates are independent of managed loops. Add only the template matching the
repository via the TUI or the advanced `--template` command:

```sh
npx @plainconceptsplatform/workflows@latest add --template agentics-checks
npx @plainconceptsplatform/workflows@latest add --template agentics-maintenance
npx @plainconceptsplatform/workflows@latest add --template app-ci-dotnet-next
npx @plainconceptsplatform/workflows@latest add --template app-ci-node-monorepo
```

`opencode.ci.json` is always installed as a mandatory file during catalog install. The
`--template opencode.ci.json` command is an advanced option for installing it in isolation.

Use `agentics-checks` to validate agentic sources and generated locks in pull requests. Use
`agentics-maintenance` only when the repository wants the pre-generated gh-aw maintenance workflow.
Select one CI template only when its technology and commands suit the repository.

Full template selection guidance is in `references/templates.md`.

## Customise standalone workers

Managed files include ownership headers, source paths and the installed package version. Read the
header before editing. The `env:` block at the top of a worker is the only part of a managed file
that is yours: `update` replaces everything else with the package's and keeps your env values (plus
the runner pool and the gateway URL). If something else must differ per repository, it has to become
an env variable in the package. To take a file over completely, remove its ownership header; the
package then leaves it alone unless `--force` is passed.

There is no shared `repo-config` file. Every `agent-*.md` worker is standalone. After installation,
edit that worker's top-level `env:` values directly for labels, paths, prompt rules, endpoint,
model-related settings, and verification commands.

The CLI generates stack-aware defaults for `VERIFY_COMMANDS` and base `REPO_RULES` by detecting the
repository's technology stack at install time. It inspects for `.slnx` ( .NET solutions) and
`pnpm-lock.yaml`, then injects appropriate verify commands and architecture rules into each worker's
`env:` block. `shared/platform-defaults.md` no longer carries `VERIFY_COMMANDS` that value is now
generated per-worker during installation and can be overridden in each worker. This keeps the shared
file to network allowlists and safe-output defaults only.

Consumers MUST edit each worker's `REPO_RULES` to contain route-specific rules relevant to their
repository. The CLI generates a base from stack detection (e.g., "Follow Clean Architecture layering"
for .NET repos), but route-specific rules require domain knowledge the CLI does not have. See
`references/customize.md` for what each route's `REPO_RULES` should focus on.

Values have concrete defaults, including `OPENAI_BASE_URL: https://forge.plainconcepts.com/v1`. Keep
worker-specific configuration in worker frontmatter; do not create a shared repository configuration
layer.

The CLI also generates stack-aware `opencode-ci.md` and `opencode.ci.json` based on detection. When
a `.slnx` is found, NuGet cache and `dotnet restore` steps are added to the CI setup, and the LSP
section with csharp/fsharp/razor disabled is included. When an `openspec/` directory exists, an
OpenSpec CLI install step is added. The `opencode.ci.json` template's agent prompt receives either
.NET guardrails or Node/React rules depending on the stack.

Shared imports can carry mechanics, but worker frontmatter owns policy: environment defaults,
permissions, engine, model, runners, Safe Outputs, and timeout. Preserve ownership headers unless
deliberately making the file consumer-owned.

Full customization guidance, the migration path from shared configuration, and the values each worker
owns are in `references/customize.md`.

### Visual evidence

When a pull request merges, the router replays its verification plan (`verification-plan.md`,
written by `pc-repo-verify` during implement) against the running app and archives one screenshot
per waypoint beside the plan: the images and a `manifest.json` go to an `evidence/` folder next to
`verification-plan.md` on the default branch, usually under `openspec/changes/archive/`, in one
`[skip ci]` commit, and a single comment on the pull request shows them. The comment also embeds the
manifest for tools such as Project Health. It is a record, not a gate; nothing waits on it.

A pull request that is not merged (`operation=evidence` on an open one) has no plan on the default
branch to keep the screenshots beside: the comment says so and the run's artifact keeps them for 14
days. A default branch that refuses the workflow's push gets the same note instead of a failed run.

It needs no secret and no per-repository setting. The app is started with `pnpm run dev` at the
root (a plan can name another command in its own `start:`), dependencies are installed from the
lockfile, `.env.example` is copied to `.env` when there is no `.env`, and .NET is set up when the
repository has a `global.json` or .NET projects.

| Router env var | Default | Purpose |
|---|---|---|
| `EVIDENCE_ENABLED` | `"true"` | `"false"` stops the merge route for a repository whose app cannot start on a runner |

Run it by hand for any pull request from the router's Run workflow dropdown with operation
`evidence` and the pull request number; that works even when `EVIDENCE_ENABLED` is `"false"`.
A pull request with no plan, or whose plan says `status: not-applicable`, writes nothing.

### Merge gate on all pull requests

The merge gate now runs on all open, non-draft pull requests from this repository,
regardless of whether the author is a bot or a human. The `identify-gate-subject`
action previously rejected human-authored PRs; that check has been removed.

### Tiered CI

A bot pull request is updated against its base every time something ahead of it merges, so its CI
runs again and again before it merges: in Pliny-Bot two thirds of the pull request CI ran on heads
that were replaced. With tiered CI a bot's push runs the light checks only (scanners, SBOM) and the
full CI (build, tests, coverage) runs once, when the merge train finds the pull request next in line
and up to date. The train never gates a light run.

The repository's CI workflow (the one `CI_WORKFLOW_NAME` names) carries it, because the workflow is
the repository's:

1. A `depth` job that outputs `full=true` unless the run is a bot's pull request with
   `vars.CI_DEPTH_TIERED == 'true'` and no `ci-full` label. It reads the labels from the API at run
   time (`gh pr view <n> --json labels`), not from the event payload, because the train asks for the
   full run by adding `ci-full` and re-running the same run, and a re-run keeps the old payload.
   People's pull requests, pushes to the default branch, tags and schedules always run in full.
2. Every heavy job (build and tests, coverage, mutation, end-to-end) needs `depth` and adds
   `needs.depth.outputs.full == 'true'` to its `if:`. The run stays a `pull_request` run, so scope,
   mutation and coverage jobs keep their pull request context.
3. A job named exactly `Full CI` that needs the heavy jobs, runs `if: always()` with that same
   condition, and fails when any of them failed or was cancelled. The train reads it to tell a full
   run from a light one.
4. The job that hands the verdict to the router needs `Full CI` too, so the train can read it. The
   handover already moves the train, which asks for the full run itself.
5. `concurrency` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, keyed on the
   pull request, so a newer push cancels the older run.

The train labels a pull request `ci-full` when it brings it up to date as next in line, so that
update runs in full straight away, and labels and re-runs a light green run that is already up to
date. Turn it on with the repository variable `CI_DEPTH_TIERED=true`; the router passes the same
variable to the train, so one switch covers both sides. Leave it unset and nothing changes.

### Merge queue

With GitHub's merge queue on the default branch, GitHub orders, builds and merges, and the loops stop
doing it by hand. It replaces tiered CI's `ci-full` label and re-run, and the train's updates.

- The merge gate approves the pull request with a review (so a ruleset's required approval is the
  gate's) and enqueues it through GraphQL `enqueuePullRequest` (`land-pull-request`). A person's
  approval of a pull request the gate handed over is enqueued the same way. A base branch without a
  queue is merged directly, as before.
- The train no longer waits for the pull request ahead, updates branches or asks for a deeper CI. It
  skips pull requests in the queue, and treats one the queue ejected after its head was pushed as
  red, handing the gate the failed `merge_group` run to repair from.
- Stacked pull requests enter the queue only through `PUT /pulls/{n}/merge-async`, which refuses a
  GitHub App today ("Enqueuer is not authorized to merge"): a person adds a stack to the queue.

To turn it on in a repository:

1. The CI workflow runs on `merge_group` as well as `pull_request`, and its heavy jobs add
   `(github.event_name != 'pull_request' || vars.MERGE_QUEUE != 'true')` to their `if:`, so a pull
   request runs the light checks and the merge group runs everything. A job named `Full CI` needs the
   heavy jobs and fails when any failed; the queue requires it. The CI templates carry all of this.
2. A ruleset on the default branch with `merge_queue` (squash, build concurrency 1 to 2 to keep CI
   low), `required_status_checks` with `Full CI`, and `pull_request` with one required approval.
3. The bot's GitHub App has the repository permission `Merge queues: write`.
4. The repository variable `MERGE_QUEUE=true`: the router passes it to the train, and gates run one
   per pull request instead of on the single merge belt.

## Compile and verify

Compile in the consumer repository:

```sh
node scripts/compile-agent-workflows.mjs
```

Commit generated `*.lock.yml` and `.github/aw/actions-lock.json` in the consumer repository. They are
generated consumer artifacts, not source package files. Run the repository's agentic workflow checks
and inspect compiler warnings. Confirm worker inputs match router calls, every worker has concrete
top-level environment defaults, and no generated file has been hand-edited.

Full compilation, verification, rollback, and recovery guidance is in `references/compile.md`.

## References

Load these as needed; do not read all of them up front.

| File | Read it when |
|---|---|
| `references/install.md` | CLI commands, managed file layout, ownership headers, update conflicts |
| `references/customize.md` | Worker environment editing, values each worker owns, migration from shared config |
| `references/templates.md` | Optional template choice, what each template does, tailoring guidance |
| `references/compile.md` | Compilation, lockfiles, CI freshness check, rollback after a bad update |

## Test shape

Workers write tests as a trophy, not a pyramid: mostly integration, a unit test only for logic
with real branching, one regression test per bug fix. `check-diff` (from agent-harness) limits how
much test and comment code a change adds, not its shape; the shape comes from the worker prompts
and from Foundations' testing guidance. A repository that wants a different shape says so in its
`AGENTS.md`.
