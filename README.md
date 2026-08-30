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

Every worker is a `workflow_call` reusable workflow. Nothing triggers itself: `work-router.yml`
owns all the triggers, classifies the event into exactly one route, and calls one worker. That
is why a worker can be added or removed without touching the others, and why the route matrix
in `verify-route-matrix.sh` is the thing to run after changing any of them.

| Route | Worker | Starts when | Produces |
|---|---|---|---|
| `triage` | `agent-triage.md` | an outside collaborator opens an issue | a comment, and the `refine` label when the issue passes |
| `refine` | `agent-refine.md` | the `refine` label is added | a refined story with a Fibonacci estimate, or questions for the author, or a split into several right-sized issues |
| `implement` | `agent-implement.md` | the `implement` label is added | one branch, one pull request, one issue closed |
| `merge-gate` | `agent-merge-gate.md` | CI reports on a bot pull request | a squash merge, a fix pushed to the same branch, or a hand-off to a human |
| `apply-review` | `agent-apply-review.md` | someone reviews or comments on a bot pull request | the requested changes pushed to that pull request |
| `audit` | `agent-audit.md` | Mondays, or on demand | one issue of findings, labelled `refine` so it gets sized and split |
| `mutation` | `agent-mutation.md` | Tuesdays, or on demand | one issue naming tests that do not actually pin behaviour |

Plus the plumbing, which has no agent in it: `work-router.yml` (the router itself),
`authorize-bot-work.yml` (a human's label is checked, then the bot re-labels so the workers see
a trusted actor), and the `classify-route` / `verify-route-matrix` composite actions.

### How the routes chain

The normal life of a piece of work is `refine` → `implement` → CI → `merge-gate` → merged, with
no human in the loop unless a worker asks for one. Refine decides the size: an estimate of 8 or
more is split into children of 5 or less, and each child walks the same path on its own. Audit
and mutation are the two that create work rather than consume it, and both file into `refine`
rather than straight to `implement`, so a report of several unrelated findings becomes one
properly sized issue per finding instead of one pull request that has to fix them all.

Two labels are the controls a person has: `review` parks anything for a human, and `future`
holds a refined issue back from implementation until it is removed.

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
npx @plainconceptsplatform/workflows@latest add audit mutation
npx @plainconceptsplatform/workflows@latest add --template agentics-checks
npx @plainconceptsplatform/workflows@latest add --template agentics-maintenance
npx @plainconceptsplatform/workflows@latest add --template app-ci-dotnet-next
npx @plainconceptsplatform/workflows@latest add --template app-ci-node-monorepo
npx @plainconceptsplatform/workflows@latest add --template bug-report
npx @plainconceptsplatform/workflows@latest add --template feature-request
npx @plainconceptsplatform/workflows@latest remove triage
npx @plainconceptsplatform/workflows@latest update
```

`add` (catalog install) always installs `opencode.ci.json` and `scripts/compile-agent-workflows.mjs` alongside managed loop files. They are mandatory.

## Changing the installed route set

The router (`work-router.yml`), classifier, and route matrix are derived files: their content is a function of which routes are installed. The CLI owns that assembly so the router always references exactly the workers on disk, never more.

- `add <routes>` unions the requested routes with the routes already installed, then regenerates the router, classifier, and route matrix from the union. Adding a route later keeps the ones already there instead of dropping them.
- `remove <routes>` drops the requested routes from that set, regenerates the same derived files, and deletes each removed worker's `agent-<route>.md` and generated `agent-<route>.lock.yml`.
- The interactive TUI is desired-state: the checked routes are the target set. Checking a new route adds it; unchecking an installed route removes it.

Changing the route set rewrites the package-owned router, so these operations report a conflict on `work-router.yml` unless you pass `--force`. Standalone worker `.md` files keep their own conflict protection and their consumer `env:` edits are preserved across regeneration.

For a project-local development dependency, install `@plainconceptsplatform/workflows` and run `pnpm exec workflows` with no arguments to launch the TUI, or `pnpm exec workflows <init|add|update>` for non-interactive use.

Each worker declares its defaults in top-level `env:` frontmatter. Copy consumers edit those
values directly when their endpoint, model, labels, paths, or baseline verification command differs.
Every package-managed file includes an ownership header with its `loops/` source path. `update --force` can overwrite consumer edits to these files.

## Triage route for outside collaborators

The `triage` route gates issues opened by outside collaborators (GitHub Read permission / Outside Collaborator role). Write+ users skip triage entirely — they can self-label into the pipeline as usual.

When an outside collaborator opens an issue, the triage agent runs 10 checks (template completeness, security risk, change size, danger level, duplicate detection, clarity, reproducibility, acceptance criteria quality, cross-cutting impact, area suggestion) and loops up to 3 rounds. The author or any write+ user can comment to re-trigger triage after a `needs-info` verdict.

- **pass**: all checks pass → bot adds `refine` label → enters the normal pipeline (refine → implement) with no human in the loop.
- **needs-info**: needs clarification → bot posts questions, adds `review` label → author or write+ user replies → re-triage.
- **block**: outside product-owner scope, cannot be done, security risk, or too dangerous → bot closes the issue with an explanation.

At round 3, `needs-info` is no longer valid — the agent must `pass` or `block`.

Install the triage route alongside other routes:

```bash
npx @plainconceptsplatform/workflows@latest add triage
npx @plainconceptsplatform/workflows@latest add audit mutation
```

## Optional agentic maintenance templates

`add` and `update` install only package-owned loops. They do not install maintenance templates. Install a template explicitly with `add --template <name>`; use `--force` only to replace a changed copy.

- `agentics-checks` verifies generated lockfiles and lints agentic workflow source on pull requests.
- `github-release` publishes a GitHub Release with generated notes when a `v*` tag is pushed.
- `agentics-maintenance` is the `gh aw` generated maintenance workflow. It is supplied for repositories that want to commit the generated workflow before their first compilation.
- `bug-report` installs a bug report issue template to `.github/ISSUE_TEMPLATE/bug_report.yml`. Bugs can be any size.
- `feature-request` installs a feature request issue template to `.github/ISSUE_TEMPLATE/feature_request.yml`. Scoped to small, well-scoped improvements — a Small/Medium dropdown gate steers large work to a planning issue.

Templates are standalone copies placed in `.github/workflows/`. `app-ci-dotnet-next` provides .NET, SQL Server integration testing, Next.js, and security checks. `app-ci-node-monorepo` provides Node monorepo, web, Electron, Capacitor, E2E, and security checks. `github-release` publishes generated GitHub release notes when a `v*` tag is pushed. `bug-report` and `feature-request` install to `.github/ISSUE_TEMPLATE/` instead of `.github/workflows/`. `opencode.ci.json` is always installed as a mandatory file during catalog install; the `--template opencode.ci.json` command is an advanced option for installing it in isolation. Edit their top-level `env:` defaults or JSON properties after copying.
