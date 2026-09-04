# Workflows CLI

Install and update shared GitHub Agentic Workflows for Plain Concepts Platform repositories.

## Quick start

The primary entrypoint is the interactive TUI. Run it with no arguments:

```bash
npx @plainconceptsplatform/workflows
```

The TUI lists all routes and templates with install status. Arrow keys navigate, space toggles, Enter installs. Selecting routes installs only those route workers plus mandatory files (opencode.ci.json, compile script, shared imports, actions, router, classifier, route matrix). Selecting only templates installs just those templates.

## Install

Before installing workflows, install and configure [`PlainConceptsPlatform/agent-harness`](https://github.com/PlainConceptsPlatform/agent-harness) in the consumer repository. Loop workers invoke the skills and commands it provides. Verify the required skills and commands are available before compiling workflows.

For non-interactive use (advanced):

```bash
npx @plainconceptsplatform/workflows@latest init
npx @plainconceptsplatform/workflows@latest add
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

`add` installs mandatory files (opencode.ci.json, compile script, shared imports, actions, router, classifier, route matrix) when called with no route arguments. Pass route names as positional arguments to install specific route workers alongside the mandatory files:

```bash
workflows add                        # mandatory files only, no worker .md files
workflows add implement refine direct  # those route workers plus mandatory files
workflows add --template agentics-checks  # named template only (no mandatory files)
workflows add refine --template agentics-checks --force  # routes + template + mandatory, overwriting conflicts
```

Route names: refine, implement, direct, apply-review, merge-gate, audit, propose. Unknown arguments produce an error.

Use `workflows update --force` to force-overwrite managed files that differ from the package source.

Install optional standalone templates with `add --template`. Available templates are `agentics-checks`, `agentics-maintenance`, `app-ci-dotnet-next`, `app-ci-node-monorepo`, and `github-release`. CI templates are stack-specific copies, not a combined template. `github-release` publishes generated release notes when a `v*` tag is pushed. Edit their top-level `env:` values for repository paths, package names, and commands.

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
