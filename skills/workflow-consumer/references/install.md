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
| `add` | Installs package-managed loop files including mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. Stops on any changed managed destination |
| `update` | Refreshes managed loop files. Same conflict behavior as `add` |
| `status` | Inspects the repository and prints JSON. No writes |
| `list` | Lists all workflows and templates with install status |
| `search <query>` | Filters workflows and templates by name or description |
| `add --template <name>` | Copies one optional template. See `references/templates.md` |
| `add --force` | Overwrites changed managed files. Back up first |

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

Read the header before editing any managed file. If the header is present, the file is managed and
`update --force` may overwrite local changes.

## Update conflicts

`add` and `update` detect a differing managed destination before writes. When a managed file has been
modified locally, the command:

1. Reports the conflict by path
2. Makes no changes
3. Exits with code 1

To resolve:

- **Keep the local change**: remove the ownership header, making the file consumer-owned. The
  package will never update it again.
- **Transplant the change**: identify whether the local edit belongs in the worker's `env:` block
  (which is worker-owned policy) or in a shared mechanics file. Move policy into the worker frontmatter
  and keep shared mechanics in the import.
- **Discard the local change**: run `workflows update --force` after backing up the existing file.
  Compile immediately after and review the generated locks.

## What `init` reports

`init` inspects the repository and prints JSON with:

- Whether the repository is a git repo
- Whether it has a remote and its visibility (public or private)
- Whether `.github/workflows/` already exists
- Whether managed files are already present

Use `init` before `add` to preview what will happen. Pass `--visibility public` or
`--visibility private` to override the detected visibility.
