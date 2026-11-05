# Changelog

Releases of `@plainconceptsplatform/workflows`. Earlier versions are described in their GitHub Releases and commit messages.

## 1.14.0

### Changed

- The implement worker lets `harness.json` drive the tiers (`plan=glm-5-3`, `build/fast=glm-5-2`) instead of pinning every tier to one model. It spawns `planner-sub` for propose and archive, and the pre-agent setup runs `sync-agents` and `harness-doctor` so the task enum includes the generated agents. `verify-route-matrix.sh` asserts `subagent_type: planner-sub`.

## 1.13.1

### Fixed

- `merge-dependabot` reads with the workflow token and writes with the App token. 1.13.0 did everything with the App token, and where the App installation holds no Checks permission (Project-Health-Platform) every run failed on the first check-runs read with `403 Resource not accessible by integration`. The action takes a new `read-token` input, default `GITHUB_TOKEN`, for the pull requests, commits, comments, check runs and commit statuses; approve, merge, the rebase comment, the branch delete and the post-merge dispatch stay on `token`, so a merge still starts the push workflows. The `dependabot-merge` template passes `read-token: ${{ github.token }}` with `checks: read` and `statuses: read`, and the router's `housekeeping` job now grants `checks: read` and `statuses: read` and passes the same.
- A read that is still refused no longer fails the run. That pull request is skipped with a `::warning::` naming the missing permission, for example `cannot read checks: grant Checks: read to the App or the workflow token`, the same line heads the job summary, and the next pull request is judged. Any other API failure still turns the run red.
- `verify-route-matrix.sh` asserts the router's Dependabot merge reads with `GITHUB_TOKEN` and that the `housekeeping` job grants `checks: read`.

Existing installs keep reading with the App token until `workflows update` refreshes them.

## 1.13.0

Includes 1.12.1 (the audit's report and stories under refine's size gate), so publishing 1.13.0 ships both.

### Added

- Dependabot auto-merge. The new `merge-dependabot` action squash-merges the open Dependabot pull requests whose checks are all green, at the head commit it judged, and deletes their branches. Only a pull request Dependabot opened, on a `dependabot/` branch of this repository, targeting the default branch, not a draft, without `do-not-merge`, `blocked`, `human-review` or the hold label, and with every commit authored by Dependabot, committed by GitHub and signature-verified, is touched. A failing check leaves it open and listed in the job summary; a pending one waits for the next run; one behind or conflicting gets a single `@dependabot rebase` per head commit; one with no checks at all is merged once its head is an hour old. API calls only: nothing of the pull request is checked out or run, and no model decides. At most 5 merges a run; every run writes a table of what it merged, skipped and why.
- The router's six-hourly maintenance run (`housekeeping`, `23 */6 * * *`) runs it as its last step with the App token, so a merge starts the default branch's push workflows. No new cron or route. `DEPENDABOT_MERGE` (`all`, `minor`, `patch` or `off`, default `all`: CI is the gate) and `DEPENDABOT_MERGE_WITHOUT_CHECKS` (default `true`) are new values in the router's `env:` block; a repository variable `DEPENDABOT_MERGE` overrides the file. A grouped update counts as its highest bump.
- `dependabot-merge` template, opt-in with `workflows add --template dependabot-merge`, for a repository without the router: `.github/workflows/dependabot-merge.yml`, every six hours and on dispatch, plus the action it calls. It uses the Platform App token when `BOT_APP_ID` and `BOT_PRIVATE_KEY` exist and `GITHUB_TOKEN` otherwise; a `GITHUB_TOKEN` merge starts no other workflow and cannot merge a change to `.github/workflows/`. A bundle can now carry actions from the catalog, which do not count towards whether the bundle is installed.
- `docs/dependabot-merge.md`: where it runs, what it merges, the configuration, the security model and how to turn it off.

### Fixed

- The docs audit's issues reach refine. It filed one report of every finding labelled `refine`, the shape the audit dropped in 1.12.1, and refine refused it once it grew past the size gate. It now files like the audit, through the same `file-audit-issues` step: a compact tracking report labelled `docs-audit` and never `refine`, and one story per top-3 finding labelled `documentation` + `refine`, linked under the report. Every body is measured with `issue-size.cjs` against `DOCS_AUDIT_MAX_BODY_CHARS` (6000) and `DOCS_AUDIT_MAX_WORK_UNITS` (18) and trimmed to fit before anything is filed. `file-audit-issues` takes a `report-title` pattern for this.
- The `app-ci-dotnet-next` and `app-ci-node-monorepo` merge-train dispatch skips Dependabot's pull requests. Dependabot's runs get a read-only token, so the dispatch failed and held every Dependabot pull request red. Existing copies of those templates keep the old condition until they are reinstalled.

### Changed

- `workflows update` in a repository that holds only bundle templates, with no router and no worker, refreshes those bundles and installs nothing else. It used to install the whole catalog, router included.

## 1.12.1

### Fixed

- The audit's issues reach refine again. Since refine's size gate arrived (0.28.0), every audit filed one issue holding every finding and three stories with Gherkin, labelled `refine`, and every one was over the gate: refine refused all of them from 2026-09-21 on (Lyceum #36 the first, Numa #826 at 22,034 chars and 35 work units the latest), so no audit was refined or implemented in any repository. The audit now files a compact tracking report, labelled `audit` + `bug` and never `refine`, with one entry per finding (`file:line`, problem, fix), and one issue per top-3 story, labelled `bug` + `refine`, linked under the report as a sub-issue, listed in it as a task, and pointing back to it. A story already tracked by an open issue with the same title is listed against that issue instead of filed again, and running the step again reuses what it filed without restarting refine.
- Every audit issue is measured before it is filed, with the rule refine's guard applies, and has to fit `AUDIT_MAX_BODY_CHARS` (6000) and `AUDIT_MAX_WORK_UNITS` (18), three quarters of refine's limits. A body over them is trimmed: a story from the end with its open code fence closed, the report by cutting every finding to a share of the budget so all of them stay listed. A report written the old way is split, its "To implement" section becoming the stories. The audit is staged (`create-issue: max: 4`) and the new `file-audit-issues` action does the filing.

### Changed

- Refine's size guard measures with the new `measure-issue-size` action, which reads `issue-size.cjs`, the rule the audit also uses, instead of its own shell. The counts are the same: UTF-8 bytes of the title, a blank line and the body, and one work unit per `-` or `*` bullet line.

## 1.12.0

### Added

- The platform contract, `.platform/contract.yml`: an open file in which a repository names the template it receives shared code from (`source`), the paths that template owns (`owned`), its exceptions file and how it syncs (`sync.marker`, `sync.version`, `sync.update`). `docs/platform-contracts.md` documents the format with a neutral example, what this package does with each field, and that other tools may read the same file while none is required.
- `check-platform-conformance.mjs --compare`: fetches `source.url` at the version `sync.version` records and fails an owned file that differs or is missing, unless an unexpired exception covers it. When git cannot read the template, it says so and runs the other checks. `--contract` prints the resolved contract for a workflow.

### Changed

- `platform-template` is template-agnostic. The conformance script reads the contract with its own small parser, and an invalid one fails with one error naming the file and the field. A template sync is a pull request that changes `sync.marker` or moves `sync.version`, and messages name `source.name` and `source.changes` instead of Kitchen-Sink. The repository whose `origin` is `source.url` is the template itself and passes.
- `platform-template-sync.yml` runs `sync.update` and opens or updates one pull request from `platform/template-sync`, titled with the new version. It installs copier only when the command starts with `copier`; any other command is the repository's to provide. Without a contract, in the template itself or without `sync.update` it does nothing.
- `app-ci-dotnet-next`'s `Platform conformance` job runs where a contract exists, or the legacy `.copier-answers.yml` with `.platform/manifest`, and compares the owned files with the template.
- `.copier-answers.yml` with `.platform/manifest` and no `contract.yml` is read as the contract it implies, so 1.11.0 installs keep working. `.copier-answers.yml` alone is no longer a contract: the guard passes such a repository instead of failing it for a missing manifest.
- `docs/family-templates.md` keeps the quality gates, the gates CI and the Dependabot settings, and points at `docs/platform-contracts.md` for the template sync and the guard.

## 1.11.0

### Added

- `quality-gates` template, opt-in with `workflows add --template quality-gates`: Kitchen-Sink's coverage, complexity, duplication and mutation gates, the Engineering Excellence facets and their schema, `scripts/lib/*` with its tests, `dast-wait-stable.sh`, the Semgrep hygiene rules as `.semgrep/platform-hygiene.yml`, `.jscpd.json` and `.zap/rules.tsv`. The floors moved out of code into the app's `quality.config.json`; baselines stay app files and are never installed.
- `platform-template` template, opt-in with `workflows add --template platform-template`: `.github/workflows/platform-template-sync.yml`, a weekly `copier update` against the Kitchen-Sink template that opens one pull request per new tag, and `scripts/check-platform-conformance.mjs`, which fails a pull request that changes `.platform/manifest` paths outside a sync or an unexpired exception, conflict markers, and expired exceptions. Both do nothing without `.copier-answers.yml`.
- Bundle templates: several package-managed files that keep the ownership header, are stamped like the catalog, and are refreshed by `update` only where one of their files carries the header. A repository with its own headerless copies of the same paths, such as Atlas or Pliny-Bot, gets nothing from `update`, with or without `--force`.
- `docs/family-templates.md`: the templates, the `quality.config.json` schema, the gates CI settings and the Dependabot settings family apps need.

### Changed

- `app-ci-dotnet-next` is now the platform family's gates CI, reconciled from the Kitchen-Sink, Numa, Odyssey and Hermes `app-ci.yml` with Kitchen-Sink's as the base: CI depth, change scope, the engineering gates and facets, optional E2E, the `Platform conformance` job and the `dispatch-merge-gate` handoff to the merge train. Everything that differed between the apps is a top-level `env:` value or a floor in `quality.config.json`. It stays an opt-in, single-file template.
- The CLI's vitest run is scoped to `cli/src`, so the `node:test` suites the templates ship are not collected from the generated payload.
