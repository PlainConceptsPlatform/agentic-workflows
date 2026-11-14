# Changelog

Releases of `@plainconceptsplatform/workflows`. Earlier versions are described in their GitHub Releases and commit messages.

## 1.23.2

### Fixed

- **Apply-review keeps a fix whose comment left out the pull request number.** The worker's comment target is `"*"`, so each `add_comment` names its pull request in `item_number`. An agent that left it out wrote a correct fix and a correct "Review outcome: implemented" comment, and the validator, which only counted comments addressed to the pull request, called the output invalid: the fix was never pushed and the pull request was flagged as stalled (seen on a consumer's stack root, twice, on a transaction fix the reviewer had asked for). A comment with no `item_number` now goes to the worker's pull request, both in the validator and when it is posted (`apply-agent-output` and `apply-agent-comments` take an optional default number).

## 1.23.1

### Fixed

- **The merge train asks apply-review once per change request.** A dispatched apply-review run was titled `dispatch: apply-review`, with no pull request number, so the train (1.22.0) could not see one already queued behind the fleet and would dispatch another on every tick until the first ran. Dispatched apply-review runs are now titled `Agent: Apply Review - PR #N`, and the train skips a pull request that has one waiting or running. Found by replaying the train against a consumer's open pull requests before rolling it out.

## 1.23.0

### Added

- **A human-review verdict can time out, like refine's questions.** New router setting `HUMAN_REVIEW_TIMEOUT_HOURS` (merge-train input `human-review-timeout-hours`), in working hours, Monday to Friday. When a pull request the merge gate handed to a person (`human-review`) gets no review and no comment from anyone in that time, the gate's own review stands: the train lands it if its CI is green and it has no conflict, and labels it `auto-decided` so it is easy to find and revert. Anyone speaking after the verdict stops the clock. `owner-review` (protected paths, owner paths, high blast radius) never times out. The default is `"0"`, which waits for a person as before; a repository that runs unattended sets it (for example `"6"`).

## 1.22.0

Fewer places where the loop waits for a person. Each change below replaces something a supervisor had to do by hand on a consumer during two days of unattended running.

### Fixed

- **A pull request the run could not open is opened anyway.** When the repository does not let GitHub Actions create pull requests, gh-aw pushed the agent's branch, was refused the pull request ("GitHub Actions is not permitted to create or approve pull requests"), and filed the work as a fallback issue. The implement rescue now finds the branch gh-aw pushed, checks its tree is exactly the agent's work, and opens the pull request with the App token, which that setting does not bind; it closes the fallback issue. A base that moved under the run is still rebased first, as before.
- **A run that published its pull request request concludes, even if the agent job failed.** The engine can exit non-zero after the payload is written; safe_outputs still publishes it. `conclude` (where the rescue lives) used to require a green agent job, so `incomplete` took over, called it a failure and retried the whole implementation. One consumer issue was implemented three times this way. `conclude` now runs whenever safe_outputs succeeded and the agent asked for a pull request, and `incomplete` stays out of it.
- **Housekeeping never re-implements work that exists.** A stalled `implement` issue with an open pull request that closes it is moved to `pr-pending` instead of being retried. A stalled issue whose implement run pushed a branch (`…issue-N…`) that never had a pull request gets one, from the newest such branch.
- **The route matrix's stack checks no longer fail at random.** A `printf | grep -q` under `pipefail` failed whenever grep exited before the writer finished; it reads a here-string now.

### Changed

- **A stack root is gated once, when its stack is complete.** The merge train used to dispatch the gate on a root after every child landing, and the gate answered "blocked: the other children are missing" each time. It now skips a root whose child issues are still open (sub-issues first, the `split-parent` marker as fallback; a listing that fails counts nothing, so the root is gated as before).
- **A stack root is kept up to date while its children are open.** When a root is behind its base and has no conflict, the train brings it up to date with GitHub's update-branch, which merges the base in on GitHub's side. The children then merge into a current branch, and nobody has to ask an agent to merge `main`, a push the protected-files rule refuses whenever `main` carries workflow files or lockfiles.
- **The merge train answers reviews whose event never reached the router.** Reviews submitted through the API sometimes start no router run. A pull request whose gate verdict is waiting for a person, approved by a writer on its current head and green, is now landed by the train. A writer's change request newer than the head commit with no apply-review run after it sends the pull request to apply-review.

## 1.21.7

### Fixed

- **Apply-review reads the summary of a review.** "Request changes" from the review box puts its whole numbered list in the review's summary body, with no thread and no inline comment. The worker told the agent the whole conversation was on disk, but its collection step wrote only the threads, the inline comments and the conversation comments, so such a review read as "no feedback": the agent answered "nothing to apply" and pushed nothing, and the pull request stayed blocked on a change request nobody was acting on (seen on three pull requests of one consumer, five runs). The step now also writes `reviews.json` (id, author, state, body, commit) and the prompt names it: a human's `CHANGES_REQUESTED` review with a body that lists requests is actionable unless the same person approved afterwards or a later commit already does it. The route matrix asserts the fetch, the file name and the rule.

## 1.21.6

### Fixed

- **A stack child whose merge gate failed once is retried again.** GitHub links `Closes #N` only on pull requests into the default branch, so a stack child (into `feat/N`) has no linked issue. The merge train looked for the gate's attempt notes only there, missed the one the failed gate left on the issue, and read the run as a gate that did nothing: the child was skipped on every tick ("its gate already ran on this head and left no verdict or attempt") and never merged. The train now reads `Closes #N` from the body, as the gate already does. The route matrix asserts it.

## 1.21.5

### Fixed

- **Platform conformance compares with the template, or says it did not.** The template repository is private, and the conformance job had only `GITHUB_TOKEN`, so every run printed "cannot read … owned files were not compared with the source" and then "✓ owned files match the template". Now:
  - The job mints the bot App token (`BOT_APP_ID`, `BOT_PRIVATE_KEY`, new optional `workflow_call` secrets) and hands it to git through process-scoped config.
  - With that token, `check-platform-conformance.mjs --require-source` makes an unreadable template a failure.
  - Without a token (Dependabot, or a caller that passes no secrets) the job warns that it did not compare, and the script no longer prints "owned files match" when it compared nothing.
  - A deploy pipeline that calls the CI with `uses:` passes the two secrets; the platform template's `app-deploy.yml` does so from its next version.

## 1.21.4

### Fixed

- **Refine's proposed answers are taken again, by thumbs-up or after the timeout.** The router's step looked for the `<!-- agent-refine -->` marker in refine's questions, but gh-aw strips HTML comments from safe-output comments, so it never found any: issues with accepted or timed-out questions stayed parked (seen in Bots, Odyssey and a Labs repository). It now also matches refine's visible `Refinement update` prefix. The route matrix asserts it.

## 1.21.3

### Fixed

- **Implement can spawn `planner-sub` again.** agent-harness before 3.12.1 generates `resource: *` in the planner agents; a bare `*` is a YAML alias, so opencode dropped their `mode` and refused to spawn them ("Agent planner-sub cannot run as a subagent"). 1.20.2 quoted the generated files, but the harness plugin rewrites them when opencode starts, so the fix never reached the agent. The CI setup now quotes the value in the plugin's generator (`pc-subagent-tiers-core.js`) before the sync, and fails the step if it cannot. Verified in a consumer: the same patch took the implement run from the spawn error to a planner-sub and backend-engineer run and an opened pull request. The route matrix asserts it.

## 1.21.2

### Fixed

- **The platform template sync installs copier on the self-hosted runners.** Their Python has no `python3-venv`, so the sync's last fallback, `python3 -m venv`, failed: no app had ever synced a template version through the workflow. Where neither `uvx` nor `pipx` is present and `ensurepip` is missing, `platform-template-sync.yml` now downloads uv `UV_VERSION` (0.13.5), checks it against `UV_SHA256` and runs copier through `uvx`. The route matrix asserts the pin, the check and the guard.

## 1.21.1

### Fixed

- **The test timings parser passes the consumers' SAST.** `scripts/lib/test-timings.mjs` built a `RegExp` from a variable to read a `.trx` attribute, and Semgrep's `detect-non-literal-regexp` (a blocking rule in every consumer's SAST job) failed the first app that installed 1.21.0. It now reads every attribute of a tag with one literal pattern.
- **This repository runs the consumers' SAST on what it ships.** A new CI job scans `loops/actions` and the quality-gates and platform-template scripts with the same blocking rule sets and exclusions the consumers use, so such a finding fails here before it reaches an app.

## 1.21.0

### Added

- **Test timings in the .NET CI.** Every test step of `app-ci-dotnet-next.yml` writes a `.trx` report, and a new `Test timings` step puts where the time went in the job summary: per test project the wall time, the summed test time and the average number of tests running at once, then the slowest classes (with the time of their first test, where a class fixture's setup is paid) and the slowest tests. `scripts/test-timings.mjs` and `scripts/lib/test-timings.mjs` ship with the quality gates, with their `node:test` suite. It never fails the job.
- **A ruleset that requires `Full CI`.** `loops/templates/rulesets/main-required-checks.json` requires `Full CI` on the default branch, with repository admins able to bypass it. Without a required check nothing stopped a merge while a job was red.
- **Side workflows block a landing.** `land-pull-request/side-checks.sh` refuses a head whose `Agentics checks` run (or any workflow in `SIDE_CHECK_WORKFLOWS`) failed or is still running. Both merge points call it (`land-pull-request` and `merge-agent-pr`), and the merge train holds such a pull request instead of dispatching a gate. That workflow runs only when workflow files change, so no ruleset can require it, and the CI verdict the train reads never included it. 1.20.0's release button merged into three apps with its workflow lint red that way.
- **`CI_JOBS_PER_VM`** on the runner scaler: queued CI/Deploy jobs per VM, default 4 (unchanged). Lowering it shortens CI queues at the cost of more VMs. The runners README no longer describes `MAX_VMS` as a compile-time 2.

### Changed

- **`Full CI` needs every blocking job.** In both CI templates it now also needs the scans (TruffleHog, Trivy, Semgrep), and in the .NET template the Markdown, repository and platform conformance checks, so the one required check covers them.

## 1.20.2

### Fixed

- **`planner-sub` can be spawned again.** `agent-harness` before 3.11.3 wrote `resource: *` into the generated `plan.md`, `planner.md` and `planner-sub.md`. A bare `*` is a YAML alias, so the frontmatter did not parse, opencode dropped each agent's `mode`, treated it as primary and refused to spawn it (`Agent planner-sub cannot run as a subagent`). The implement worker mandates `planner-sub` for propose and archive, so a run either recovered by luck or ended with nothing and a stalled issue. The shared CI setup (`opencode-ci.md`) now quotes the value in the generated agent files before opencode reads them, and fails with a clear error if one is still unquoted. It is a no-op once the repository takes the harness fix. Needs no action from consumers beyond `workflows update`.
- **Implement stops at the first spawn error.** Where the prompt said to report when `planner-sub` is not in the task tool's list, it now also covers an error on spawning it, and forbids retrying with `planner` or another agent. A run used to spend seven minutes and ten errors on the fallbacks before giving up.

## 1.20.1

### Fixed

- **The Release to production button passes actionlint.** The release worker's `deploy` input is now a `boolean`, and `release-to-production.yml` passes `deploy: true`. Before, it passed the string `"true"`, which actionlint reads as a bool and refuses for a `string` input, so every consumer's workflow lint failed on the installed button. The route matrix asserts that both sides are boolean, since this repository's own actionlint pass cannot see the consumer's compiled lock.

## 1.20.0

### Added

- **Release to production, one button.** The `release` route now installs `release-to-production.yml`: Actions, Release to production, Run workflow, with a `bump` input that defaults to `minor`. It runs the release worker directly with `deploy=true`, as the router's call-release job does, because the router's `workflow_dispatch` is already at GitHub's ten-input limit; the release worker then writes a `<!-- release-deploy -->` marker and a visible notice into the release pull request, which auto-merges as before. `release-tag.yml` tags it and, finding the marker, starts `DEPLOY_WORKFLOW` (default `app-deploy.yml`) on the new tag with `GITHUB_TOKEN`; a missing deploy workflow is a warning, not a failure. The marker and the notice stay out of the published release notes. A `pro` environment with required reviewers still asks a person before production. A release started from the router alone still tags without deploying.

## 1.19.0

### Added

- **`BOT_LOGIN` repository variable: the workflows trust the repository's own GitHub App.** The bot login was hard-coded as `platform-devbox[bot]` in the router's `TRUSTED_BOTS`, in every worker's `GH_AW_ALLOWED_BOTS` and in `bot-approve`'s `if:`, which is package code a consumer cannot override. A repository whose `BOT_APP_ID` is another App was silently untrusted: after a person added `refine`, the App's `bot-working` label left `authorize.outputs.trusted` false, `call-refine` skipped, and the issue stayed at `refine,bot-working` with no comment and no error (#527). All three now read `vars.BOT_LOGIN || 'platform-devbox[bot]'`; set it with `gh variable set BOT_LOGIN --body '<app-slug>[bot]'`. A repository on the Platform App needs no change. The route matrix runs the router's `authorize` step with the variable set and unset, checks `bot-approve` and every worker resolve it, and fails a second spelling or a bare literal.

### Fixed

- **A failed harness preflight is reported as configuration, not as a provider outage.** When the agent job stopped in `Sync harness agents and print model routing` (`sync-agents.mjs --strict` exits 1 with no specialist `*-engineer.md`) or in the CI provider merge, the run ended in a minute, read as a short run, was commented as "what a provider outage looks like" and retried five times, each failing the same way (#527). `decide-agent-retry` now reads the failed step's name from the jobs API; `classify-failure.sh` names those steps `configuration`, which is never retried, whatever the duration. Refine, implement, triage and apply-review park it with `review` but not `stalled` (the janitor would retry it) and post one comment naming the step and the fix (`/make-engineer` for the missing templates). The action gains `failed-step` and `reason` outputs.

## 1.18.1

### Fixed

- **`capture-mockup.mjs` uses literal regular expressions.** It built one from a variable, which the family's blocking Semgrep scan reports as `detect-non-literal-regexp`, so every consumer that installed 1.18.0 failed SAST on the vendored action.

## 1.18.0

### Added

- **Refine draws a UX mockup for frontend work.** A standard-path story whose work units change files matching the new `MOCKUP_PATHS` (default `apps/web/**`) gets a mockup from the harness skill `pc-plan-mockup` (agent-harness 3.11.0): one self-contained HTML file built from the repository's own `DESIGN.md` tokens, with every region mapped to the real component to build it with. A mockup a person already published with `/plan-mockup` is kept instead. Two new jobs with no model, `mockup_render` and `mockup_publish`, check it against its contract, render it at 1440 and 390 pixels wide in the Playwright image with no network, and push it to the `mockups` branch at `issue-<number>/`. Conclude then stamps a `UX mockup` section on the issue with the picture, the link and the component table, re-stamped on every pass, and on each split child with the sections its `Mockup sections:` line names. Neither job can fail a refinement.
- **Implement reads the mockup as intent.** A `load-mockup` step copies the issue's mockup (a split child's parent's) to `/tmp/gh-aw/agent/mockup/`, and the prompt says to build with the components its table names and never copy its markup. The merge gate never counts a visual difference from the mockup as a finding or an unmet criterion, and does count copied mockup markup.
- **Evidence shows the mockup next to the result.** The evidence comment adds the mockup the closing issue was refined with, so a reviewer judges the experience against the intent.
- **`platform-mockup-markup-in-code` Semgrep rule** in the quality-gates bundle: fails a pull request that carries a mockup's `data-mockup-section` or `data-component` references. `app-ci-node-monorepo` now passes `--config .semgrep/` when the folder exists, so the family rules run there too.
- **`capture-mockup` and `load-mockup` composite actions.**

### Fixed

- **Route matrix.** The check that every CI template hands a pull request's verdict to the merge train skips templates that never run on a pull request; `quality-mutation.yml` made it fail on main since 1.17.0. The implement base-branch check no longer races SIGPIPE under `pipefail`.

## 1.17.1

### Changed

- **Implement keeps the end-to-end tests in step.** The implement worker still does not run end-to-end suites in its sandbox, but a change that moves, renames or removes something a person clicks or reads now updates every end-to-end test that uses it in the same pull request. This matters most where the suite runs only at night: there the pull request stays green and the next morning's run fails with no author attached (Pliny-Bot #1506, ten journeys). The worker also no longer claims that CI runs every suite on the pull request, which is not true in such a repository.

## 1.17.0

### Changed

- **Mutation testing no longer runs on pull requests.** `app-ci-dotnet-next` drops `Mutation (.NET, diff)` and `Mutation (web, diff)`, and `app-ci-node-monorepo` drops `Mutation (web, diff)` and `MUTATION_THRESHOLD`; `Full CI` and `Dispatch merge gate` no longer need them. Stryker over one changed React page took 15 minutes on an Odyssey pull request (the dry run alone reran the 710-test suite) and then failed the run on Stryker's own `break` threshold. The per-change gate is the coverage floor, as in Atlas. A repository that made either job a required status check must drop it from the ruleset.

### Added

- **`quality-mutation` template**: the weekly out-of-band mutation run Atlas uses, as `.github/workflows/quality-mutation.yml`. A Saturday cron plus `workflow_dispatch` with a `scope` input; one Stryker.NET job per `DOTNET_SCOPES` entry (run per project, `perTest` asserted), one StrykerJS web job, each gated by `check-mutation.mjs` on its `quality.config.json` floor, then the `engineering-excellence-mutation` facet for a full run on main. `workflows add --template quality-mutation`; needs `quality-gates`.

## 1.15.0

### Changed

- **Refine no longer refuses large issues.** The `size_guard` job, the `refuse_big_issue` job, the `REFINE_MAX_BODY_CHARS`, `REFINE_MAX_WORK_UNITS`, and `REFUSE_MARKER` env vars, and the `measure-issue-size` step in the refine worker are all removed. Refine now accepts any issue implement accepts — they consume the issue identically (`load-issue-context` → `ISSUE_CONTEXT_PATH` JSON), and there was never a reason to gate one on the input size and not the other. The failure the gate existed for (Pliny-Bot #305: the model writing one giant refined body and dying at the provider's 32K single-response output cap) is bounded on the OUTPUT side by the split mechanism (estimate `>= 8` writes `<= MAX_SPLIT_CHILDREN` small child bodies, one per turn), the prompt's "tighten the body" rule, plus `max-turns` and `max-ai-credits` — none of which depends on the input size. The old `8000`/`24` limit (and a `100000`/`150` step considered on the way) just re-created the asymmetry that mis-routed Bots #1357 (a 23,388-char UX contract) to implement, which read it as nothing-to-do and emitted `noop`. `verify-route-matrix.sh` drops the assertions that required refine to carry a gate; the `measure-issue-size` action stays for the audit workers, whose own `AUDIT_MAX_*` limits are about how they file, not about what refine reads.

### Fixed

- Refine validator: a draft body paired with a 'Refinement complete' comment is `invalid` (a self-contradiction), not `questions`. Regression from the 1.14.1 `has_draft_body` fallback.
- Silenced SC2016 shellcheck false positive on a JSON test fixture carrying literal markdown backticks.
- Removed the stale `agentics-error-report` template entry left by #503 (fleet error reporting removal).

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
