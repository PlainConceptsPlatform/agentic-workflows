# Workflows CLI

Install and update shared GitHub Agentic Workflows for Plain Concepts Platform repositories.

## Quick start

The primary entrypoint is the interactive TUI. Run it with no arguments:

```bash
npx @plainconceptsplatform/workflows
```

The TUI lists all routes and templates with install status. Arrow keys navigate, space toggles, Enter installs. The checked routes are the target set: checking adds a worker, unchecking removes it, and Enter on an unchanged selection refreshes every installed package file to this version. Selecting only templates installs just those templates.

## Install

Before installing workflows, install and configure [`PlainConceptsPlatform/agent-harness`](https://github.com/PlainConceptsPlatform/agent-harness) in the consumer repository. Loop workers invoke the skills and commands it provides. Verify the required skills and commands are available before compiling workflows.

For non-interactive use (advanced):

```bash
npx @plainconceptsplatform/workflows@latest init
npx @plainconceptsplatform/workflows@latest add refine implement
npx @plainconceptsplatform/workflows@latest update --dry-run
npx @plainconceptsplatform/workflows@latest update
```

For a project-local development dependency:

```bash
pnpm add -D @plainconceptsplatform/workflows
pnpm exec workflows              # launch interactive TUI
pnpm exec workflows init
pnpm exec workflows add
```

`init` inspects the repository and reports its stack and visibility. It does not create or manage repository configuration or a manifest.

`add` installs the mandatory files (opencode.ci.json, compile script, shared imports, actions, router, classifier, route matrix) and the workers named as positional arguments, on top of the workers already installed. With no routes it refreshes what is there:

```bash
workflows add                              # refresh everything installed; in an empty repository, no workers
workflows add implement refine             # those workers on top of the installed ones
workflows add --template agentics-checks   # named template only (no mandatory files)
workflows add refine --template agentics-checks --force  # routes + template + mandatory; --force also replaces a changed template
workflows remove audit                     # uninstall the audit worker and drop it from the router
```

Route names: refine, implement, triage, apply-review, merge-gate, audit, release. Unknown arguments produce an error.

## Update

`update` is `add` with no routes: it refreshes exactly the installed set to this package version. Every package-managed file is replaced and its ownership header records the version it came from:

```
# Managed by @plainconceptsplatform/workflows@0.7.0. Source: loops/workflows/work-router.yml. ...
```

The `env:` block at the top of a worker is the repository's and survives: your values are kept, keys the package added arrive with their defaults, keys only you defined stay. When the header records the version you installed from, that release is fetched from npm and used as the merge baseline, so a value you never changed follows the package when its default changes. The agent runner pool and the engine gateway URL are kept as well. Everything else in the file is the package's.

- `update --dry-run` prints the plan as JSON and writes nothing.
- A file whose ownership header was removed is consumer-owned and is skipped unless `--force` is passed.
- Templates are consumer-owned after installation and are replaced only with `--force`.
- `--version` prints the package version.

## List and search

List all available workflows, routes, and templates with install status:

```bash
npx --yes --package @plainconceptsplatform/workflows@latest workflows list
```

Each entry is marked `[x]` when the corresponding `.github/workflows/agent-*.md` file already exists in the current directory, or `[ ]` when it is not yet installed.

Search by name or description:

```bash
npx --yes --package @plainconceptsplatform/workflows@latest workflows search "ci"
```

## Templates

Install optional standalone templates with `add --template`. Available templates are `agentics-checks`, `agentics-maintenance`, `app-ci-dotnet-next`, `app-ci-node-monorepo`, `bug-report`, `feature-request`, `github-release`, and `opencode.ci.json`. CI templates are stack-specific copies, not a combined template. `github-release` publishes generated release notes when a `v*` tag is pushed. Edit their top-level `env:` values for repository paths, package names, and commands.

## Manual installation

The package includes `loops/`, a copyable equivalent of `.github/`:

- `loops/actions/` maps to `.github/actions/`
- `loops/workflows/` maps to `.github/workflows/`
- `loops/scripts/` maps to `scripts/`

Copy these files manually if you do not use the CLI. Each worker is self-contained. Edit its
top-level `env:` defaults directly for consumer-specific endpoint, model, labels, paths, and checks.

## Compile

Consumer repositories generate and commit `*.lock.yml` files:

```bash
node scripts/compile-agent-workflows.mjs --force
```

Do not commit generated locks to this package source repository.
