# Install and update

Prerequisite: the consumer repository installs and configures
`PlainConceptsPlatform/agent-harness`, then verifies worker-required skills and commands before
compilation.

## CLI commands

The primary entrypoint is the interactive TUI. Run it with no arguments:

```sh
npx @plainconceptsplatform/workflows
```

The TUI lists routes and templates with install status, allows fuzzy filtering, and installs
selected items on Enter. Selecting any route installs the full managed catalog plus mandatory
`opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. Selecting only templates still
installs those mandatory files.

Non-interactive use (advanced, for automation):

```sh
npx @plainconceptsplatform/workflows@latest init
npx @plainconceptsplatform/workflows@latest add
npx @plainconceptsplatform/workflows@latest update
```

Project-local dependency use:

```sh
pnpm add -D @plainconceptsplatform/workflows
pnpm exec workflows              # launch interactive TUI
pnpm exec workflows init
pnpm exec workflows add
pnpm exec workflows update
```

| Command | What it does |
|---|---|
| (default) | Launches the interactive TUI for selecting and installing routes and templates |
| `init` | Inspects the repository and its visibility. Writes no workflow files. Prints JSON to stdout |
| `add [routes]` | Installs the named workers on top of the installed ones, plus the mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`, and refreshes every package-managed file |
| `update` | `add` with no routes: refreshes exactly the installed set to the package version |
| `update --dry-run` | Prints the plan as JSON (per file: added, updated, unchanged, skipped) and writes nothing |
| `remove <routes>` | Drops the routes from the installed set, regenerates the router, deletes the workers and their locks |
| `status` | Inspects the repository and prints JSON. No writes |
| `list` | Lists all workflows and templates with install status |
| `search <query>` | Filters workflows and templates by name or description |
| `add --template <name>` | Copies one optional template. See `references/templates.md` |
| `--force` | Also overwrites files whose ownership header was removed, and changed templates |
| `--version` | Prints the package version |

The bin name is `workflows`. It is defined in `cli/package.json` under `"bin"`. The installed binary
is `./dist/index.js`.

## Managed file layout

The package copies files from `loops/` into the consumer repository:

| Source | Destination | Managed? |
|---|---|---|
| `loops/actions/` | `.github/actions/` | Yes |
| `loops/workflows/` | `.github/workflows/` | Yes |
| `loops/workflows/shared/` | `.github/workflows/shared/` | Yes |
| `loops/scripts/compile-agent-workflows.mjs` | `scripts/compile-agent-workflows.mjs` | Yes (mandatory) |
| `loops/scripts/` | `scripts/` | Yes |
| `loops/templates/opencode/opencode.ci.json` | `opencode.ci.json` | Yes (mandatory) |
| `loops/templates/` | `.github/workflows/` | No (opt-in only) |

`opencode.ci.json` and `scripts/compile-agent-workflows.mjs` are always installed by `add` and by the
TUI when any item is selected. They cannot be skipped during catalog install.

Generated files that the package never copies (the consumer compiles them):

| File | Why |
|---|---|
| `*.lock.yml` | Generated at compile time from the `.md` source |
| `.github/aw/actions-lock.json` | Generated at compile time |

## Ownership headers

Every package-managed source file includes an ownership header on its first line (YAML) or second
line (Markdown inside `---`) or after any shebang (shell). The header identifies:

1. The package: `@plainconceptsplatform/workflows`
2. The source path: `loops/<path>`
3. The update behavior: `workflows update --force` may overwrite consumer edits

Example (Markdown worker):

```
---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-refine.md. Update with `workflows update --force`; consumer edits may be overwritten.
```

Example (YAML router):

```
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/work-router.yml. Update with `workflows update --force`; consumer edits may be overwritten.
```

Example (shell script):

```
#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/classify-route/classify-route.sh. Update with `workflows update --force`; consumer edits may be overwritten.
```

Once installed, the header also records the package version the file came from:

```
# Managed by @plainconceptsplatform/workflows@0.7.0. Source: loops/workflows/agent-refine.md. ...
```

Read the header before editing any managed file. If the header is present, the file is managed and
the next `update` replaces it.

## What an update does

`update` replaces every package-managed file with the package's version and re-stamps the header.
It reports each file as `added`, `updated`, `unchanged` or `skipped`, and exits 0.

- A worker's `env:` block is yours and is merged back: your values are kept, keys the package added
  arrive with their defaults, keys only you defined stay. When the header records the version you
  installed from, the CLI fetches that release from npm as the merge baseline, so a value you never
  changed follows the package when its default changes. Offline, every value of yours is kept and the
  result reports the baseline as `unavailable`.
- The runner pool (`runs-on`) and the engine gateway URL of a worker are kept as well.
- Everything else in a managed file is replaced. A change you made to a prompt body, a job or a
  composite action is gone after the update; if it was worth making, make it in the package.
- A file whose ownership header was removed is consumer-owned and is `skipped` unless `--force` is
  passed. That is the one way to keep a local fork of a package file.
- Templates are consumer-owned from installation and are replaced only with `--force`.

Run `update --dry-run` first when the plan matters: it prints the same result without writing.

## What `init` reports

`init` inspects the repository and prints JSON with:

- Whether the repository is a git repo
- Whether it has a remote and its visibility (public or private)
- Whether `.github/workflows/` already exists
- Whether managed files are already present

Use `init` before `add` to preview what will happen. Pass `--visibility public` or
`--visibility private` to override the detected visibility.
