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

`update` does not refresh these templates. To take a new template version, run `add --template <name>
--force`, then put back what the repository changed: `--force` keeps nothing, so copy the old file's
`env:` values and any step the repository fixed locally into the new one before committing (a dropped
E2E fix turned a consumer's E2E job red). When the package's gh-aw version changes, set
`GH_AW_VERSION` in `agentics-checks.yml` to the version in the generated locks' `compiler_version`, or
its lockfile check fails.

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

Release to production: the `release` route installs `release-to-production.yml`, a one-click
release that also deploys. Its `bump` input defaults to `minor`. `release-tag.yml` starts
`DEPLOY_WORKFLOW` (default `app-deploy.yml`) on the new tag only for a release the button started;
set it to the repository's own deploy workflow if it is named differently. The platform template's
deploy does not run the CI again on the tag: it waits for the tagged commit's run on main, and when
that run passed the full CI and deployed to PRE it promotes PRE's image by digest. Add the button to the
README with
`[![Release to production](https://github.com/OWNER/REPO/actions/workflows/release-to-production.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/release-to-production.yml)`.

UX mockups: `agent-refine.md`'s `MOCKUP_PATHS` names the frontend, as space-separated globs
(default `apps/web/**`). A standard-path story whose work changes a matching file gets a UX mockup
from the harness skill `pc-plan-mockup` (agent-harness 3.11.0 or later; without it refine carries
on with no mockup), published on the `mockups` branch at `issue-<number>/` and linked from the issue.
Set it to the web app's folder when it lives elsewhere, or empty to turn mockups off. Implement
reads the mockup as intent, and the quality-gates Semgrep rule `platform-mockup-markup-in-code`
fails a pull request that copies its markup.

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
2. Every heavy job (build and tests, coverage, end-to-end) needs `depth` and adds
   `needs.depth.outputs.full == 'true'` to its `if:`. The run stays a `pull_request` run, so scope
   and coverage jobs keep their pull request context. Mutation testing is not a pull request job:
   it runs weekly from the `quality-mutation` template.
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
- A stacked pull request enters the queue only through `PUT /pulls/{n}/merge-async`, which refuses a
  GitHub App today ("Enqueuer is not authorized to merge"). The App lands a stack directly instead
  (`merge_action=direct_merge`, `bypass_rules=true`), so it must be on the ruleset's bypass list.

To turn it on in a repository:

1. The CI workflow runs on `merge_group` as well as `pull_request`, and its heavy jobs add
   `(github.event_name != 'pull_request' || vars.MERGE_QUEUE != 'true')` to their `if:`, so a pull
   request runs the light checks and the merge group runs everything. A job named `Full CI` needs the
   heavy jobs and fails when any failed; the queue requires it. The CI templates carry all of this.
2. A ruleset on the default branch with `merge_queue` (squash, build concurrency 1 to 2 to keep CI
   low), `required_status_checks` with `Full CI`, and `pull_request` with one required approval.
3. The bot's GitHub App has the repository permission `Merge queues: write` and is on the ruleset's
   bypass list (for stacks).
4. The repository variable `MERGE_QUEUE=true`: the router passes it to the train, and gates run one
   per pull request instead of on the single merge belt.

## Required checks

Apply `loops/templates/rulesets/main-required-checks.json` once per repository (`gh api -X POST
repos/OWNER/REPO/rulesets --input ...`): `Full CI` required on the default branch, admins may
bypass. `Full CI` needs every blocking job. Workflows that run only on their paths (`Agentics
checks`) cannot be required; the merge points check them through `SIDE_CHECK_WORKFLOWS` instead
(`land-pull-request/side-checks.sh`). See `docs/family-templates.md`.

## Quality gates

The `quality-gates` template (`add --template quality-gates`) carries the gate scripts; the app CI
template (`app-ci-dotnet-next`, and the web job of `app-ci-node-monorepo`) runs them. The numbers
are the app's, in `quality.config.json` at the repository root; the full key reference is in
`docs/family-templates.md`.

| Gate | Script | Fails CI when | `quality.config.json` |
|---|---|---|---|
| Coverage floors | `check-coverage.mjs` | a gated assembly or the web suite is under its floor | `coverage.api`, `coverage.web`, `coverage.reportOnly` |
| Complexity | `check-complexity.mjs` | a method over CC 15 or CRAP 30 is new or worse than `scripts/complexity-baseline.json` | none |
| Duplication | `check-duplication.mjs` | a file holds more cloned lines than `scripts/duplication-baseline.json` | none |
| Mutation (weekly) | `check-mutation.mjs` | a scope's covered-code score is under its floor | `mutation` |
| Dead code, web (Knip) | `check-dead-code.mjs` | ratchet mode only: a Knip issue type over its baseline, or any unused or unlisted dependency | `deadCode.mode`, `deadCode.since`, `deadCode.baseline` |
| Bundle size, web (size-limit) | `check-bundle-size.mjs` | ratchet mode only: the static export's JavaScript over the budget (baseline + 10%) | `bundle.mode`, `bundle.since`, `bundle.baselineBytes`, `bundle.limitBytes` |
| FSD boundaries, web (Steiger) | the app's `lint:fsd` | any Steiger error, in every mode | none |
| Architecture warnings, web (Steiger) | `check-architecture.mjs` | ratchet mode only: a Steiger rule with more warnings than its baseline | `architecture.mode`, `architecture.since`, `architecture.baseline` |
| Architecture tests, .NET | `ARCHITECTURE_TEST_PROJECT` | any failing rule (NetArchTest, ArchUnitNET or plain tests) | none |
| Code patterns, .NET (analyzers) | `check-patterns.mjs` | ratchet mode only: an analyzer rule with more errors plus warnings than its baseline | `patterns.mode`, `patterns.since`, `patterns.baseline` |
| Semgrep, the repository's own rules | the blocking SAST scan (`--config .semgrep/`) | any finding, in every mode | none |

**Report first, then ratchet.** A new check starts in `mode: "report"`: it measures, writes the
step summary and the facet, and never fails CI. After two weeks the app switches it to
`mode: "ratchet"` in a reviewed pull request; nothing flips it automatically. `since` records the day
the check was introduced, and the Project-Health card shows "report-only since" that date. A ratchet
needs its baseline first; `quality.config.json` with `ratchet` and no baseline fails every gate.

Turning on the two web checks:

1. `workflows update` (or `add --template quality-gates`) installs `knip.json`, `.size-limit.json`
   and the scripts. Add the tools as root devDependencies, pinned:
   `pnpm add -Dw knip@6.44.2 size-limit@14.3.0 @size-limit/file@14.3.0`. Until they are installed
   the CI steps skip with a notice.
2. Run the checks once and record the baselines in a pull request:
   `node scripts/check-dead-code.mjs --report apps/web/knip-report.json --write-baseline` (after
   `pnpm exec knip --workspace <web package> --reporter json > apps/web/knip-report.json`) and
   `node scripts/check-bundle-size.mjs --size-limit apps/web/size-limit.json --chunks apps/web/out/_next/static/chunks --write-baseline`
   (after the web build and `pnpm exec size-limit --json > apps/web/size-limit.json`). Each writes
   its section with `mode: "report"` and today's `since`.
3. Two weeks later, set `deadCode.mode` and `bundle.mode` to `"ratchet"` in a reviewed pull request.

Turning on the architecture check (1.28.0): nothing to install, since every family app already runs
Steiger 0.10+ (`lint:fsd`). After `workflows update`, the boundary step also writes
`apps/web/steiger-report.json` and the architecture tests write `TestResults/architecture.trx`; the
engineering-excellence job publishes `engineering-excellence-architecture` from main. Record the
warning baseline from a CI run's `web-quality` artifact (or a local
`cd apps/web && pnpm exec steiger ./src --reporter json > steiger-report.json`) with
`node scripts/check-architecture.mjs --report apps/web/steiger-report.json --write-baseline` in a
pull request, and switch `architecture.mode` to `"ratchet"` two weeks later.

Turning on the code-patterns check (1.29.0): the template only collects. The api job's build
writes each project's diagnostics to `dotnet-analyzers.sarif` (`-p:ErrorLog`) and uploads them as
the `dotnet-analyzers` artifact; the engineering-excellence job runs `Code patterns (.NET analyzers)`
and publishes `engineering-excellence-patterns` from main, with the findings of the `.semgrep/` rules
beside them. The analyzers are the app's: reference `Meziantou.Analyzer` and `Roslynator.Analyzers`
(`PrivateAssets="all"`, in `Directory.Build.props` or `Directory.Packages.props`) and set a curated
subset of their rules to `warning` in `.editorconfig`. Never `error`, and keep them out of
`TreatWarningsAsErrors` (`WarningsNotAsErrors`): the check never fails a build. Record the baseline
from that pull request's CI run (download `dotnet-analyzers`, then
`node scripts/check-patterns.mjs --sarif <dir> --write-baseline`) and switch `patterns.mode` to
`"ratchet"` two weeks later.

The audit worklist (1.30.0): after the facets, the engineering-excellence job runs
`node scripts/engineering-excellence.mjs worklist` and publishes `ee/worklist.json` from main as
`engineering-excellence-worklist` (90 days). Per check (complexity, coverage, mutation, security,
semgrep, deadCode, duplication, architecture, patterns, bundle) it lists the worst items with their
path, line, measured value, threshold or baseline and mode, each with an id that survives line
shifts, capped at 20 per check with the total beside them. It is what the weekly audit will start
from (agentic-workflows#582); nothing reads it yet, it is not a facet, and Project-Health ignores it.
There is nothing to configure: a check whose report is missing is `null`, the step never fails the
job, and it is skipped until the repository has the 1.30.0 `quality-gates` scripts
(`workflows update`). It holds no source code and no secrets, so do not add any by hand. To see
where a number on the Engineering tab comes from, download the artifact from the latest main run
(`gh run download <run-id> -n engineering-excellence-worklist`). The item shape is in
`scripts/engineering-excellence-worklist.schema.json` and `docs/family-templates.md`, "The audit
worklist".

**Reading a failure.** Every gate prints what failed into the job's step summary: the method, file or
Knip issue type, its current value and what the baseline allows. Fix the code: simplify or test the
method, remove the clone, delete the unused file or export, remove or declare the dependency, shrink
the bundle, fix the import or the slice's public API. A dead-code failure lists up to ten findings per
type; a bundle failure names the total, the budget and the largest chunk; an architecture failure
lists up to ten Steiger warnings per rule over its baseline, and a failing architecture test names
the rule in the test output (the facet lists the failing rules too); a patterns failure lists up to
ten analyzer findings (`file:line: message`) per rule over its baseline.

**Updating a baseline.** A baseline records debt that already exists; it is never the way to make a
red gate green.

- After an improvement, ratchet it down: `check-complexity.mjs --prune`, `check-duplication.mjs
  --prune`, `check-dead-code.mjs --update-baseline`, `check-bundle-size.mjs --update-baseline`,
  `check-architecture.mjs --update-baseline`, `check-patterns.mjs --update-baseline`.
  These only ever lower a value.
- `--write-baseline` re-records the current state. Use it for a first baseline or a deliberate
  reset, in its own pull request whose body says why; never in the pull request whose gate failed.
  Once a check is a ratchet, the dead-code, bundle, architecture and patterns scripts refuse to raise
  any value with it.
- Unused and unlisted dependencies are never baselined: once dead code is a ratchet, remove or
  declare them. Steiger errors and failing architecture tests are never baselined either.
- Raising the bundle budget is an edit of `bundle.limitBytes` by a person, with the reason in the
  pull request. An agent that hits a gate fixes the code or stops and reports; it does not raise a
  baseline, add a Knip `ignore`, turn a Steiger rule off or down to `warn`, skip an architecture test,
  lower an analyzer rule's severity or suppress it to pass the patterns check, or switch a mode back
  to `report`.

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
