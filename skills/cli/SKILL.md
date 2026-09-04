---
name: cli
description: >
  Maintain the package installer, updater, templates, and release behavior. Load when
  changing CLI commands, catalog installation logic, ownership header generation, template
  handling, or the build and release pipeline.
---

# CLI

Use for changes under `cli/`. This skill is self-contained. It does not depend on files outside this
folder.

## Package identity

- Package name: `@plainconceptsplatform/workflows`
- Bin name: `workflows` (defined in `cli/package.json` under `"bin"`)
- Published binary: `./dist/index.js`

## Code targets

| File | Responsibility |
|---|---|
| `cli/src/index.ts` | Parses commands, controls exit codes, prints help |
| `cli/src/catalog-installation.ts` | Copies package-managed files, reports conflicts |
| `cli/src/workflow-catalog.ts` | Route names, template names, package-owned targets |
| `cli/src/repository-inspection.ts` | Inspects git remote, detects visibility |
| `cli/scripts/copy-loops.mjs` | Refreshes package payload before packing |
| `cli/loops/` | Generated payload. Edit `loops/` source instead, then refresh |

Do not modify `loops/`, templates, or generated payload while changing CLI unless the request
explicitly includes those files.

## Commands

Running `workflows` with no arguments launches the interactive TUI, the primary entrypoint. The TUI lists all routes and templates with install status. Arrow keys navigate, space toggles, Enter installs. Selecting any route installs the full managed catalog plus mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. Selecting only templates still installs those mandatory files.

Non-interactive commands for automation:

| Command | Flags | Behavior |
|---|---|---|
| (default) | `--force` | Launches the interactive TUI for selecting and installing items |
| `init` | `--visibility public\|private` | Inspects repository and visibility. Writes no workflow files. Prints JSON |
| `add` | `--template <name>`, `--force` | Installs managed loop files including mandatory `opencode.ci.json` and `scripts/compile-agent-workflows.mjs`. Stops on conflicts unless `--force` |
| `update` | `--template <name>`, `--force` | Same as `add`. Refreshes managed files |
| `status` | none | Inspects repository. Prints JSON |
| `list` | none | Lists all workflows and templates with install status |
| `search` | `<query>` | Filters workflows and templates by name or description |
| `--help` / `-h` | none | Prints usage |

The help string in `cli/src/index.ts` must match the actual bin name `workflows` and list the TUI as default:

```
Usage: workflows <command> [options]

Run with no arguments to launch the interactive TUI.

Commands:
  (default)        Launch the interactive TUI.
  init             Inspect the repository and report its stack and visibility.
  add              Install package-owned workflow files into .github/.
  update           Alias for add. Use --force to overwrite managed files.
  status           Print repository inspection as JSON.
  list             List all available workflows and templates with install status.
  search <query>   Filter workflows and templates by name or description.

Options:
  --visibility public|private              Override repository visibility (init only).
  --template agentics-checks|agentics-maintenance|app-ci-dotnet-next|app-ci-node-monorepo|opencode.ci.json
  --force                                  Overwrite managed files.
  -h, --help                               Show this help text.
```

## Consumer contract

The primary entrypoint is the interactive TUI. Recommend running with no arguments:

```sh
npx @plainconceptsplatform/workflows
```

Non-interactive use (advanced, for automation):

```sh
npx @plainconceptsplatform/workflows@latest <init|add|update>
```

Recommend `pnpm exec workflows` (no arguments) when the consumer installs
`@plainconceptsplatform/workflows` as a project-local development dependency. Use
`pnpm exec workflows <init|add|update>` for non-interactive use.

Consumers install and configure `PlainConceptsPlatform/agent-harness` before compilation, then
verify required worker skills and commands. `init` inspects repository and visibility without writing
files. `add` installs managed loops and mandatory files (`opencode.ci.json`, `scripts/compile-agent-workflows.mjs`).
`update` refreshes them.

Each copied worker is standalone. It owns concrete top-level `env:` defaults, including its Forge
endpoint, labels, paths, prompt policy, and verification settings. No repository configuration file
exists or may be created. Do not make installer behavior depend on one.

## Ownership headers

Add ownership headers to package-managed actions, workflows, scripts, and templates. Headers name:

1. The package: `@plainconceptsplatform/workflows`
2. The source path: `loops/<path>`
3. The update behavior: `workflows update --force`

The format varies by file type:

- **YAML** (`.yml`): first line, starting with `#`
- **Markdown** (`.md`): second line inside `---`, starting with `#`
- **Shell** (`.sh`): after the shebang, starting with `#`
- **JavaScript** (`.cjs`, `.mjs`): first line, starting with `//`

The CLI does not generate headers at install time. Headers are authored in the source files under
`loops/`. The CLI copies them verbatim. JSON files (RFC 8259) cannot contain comments, so
`opencode.ci.json` documents its ownership header in a companion `opencode.ci.json.md` file
instead of inline.

## Managed file detection

The CLI detects a differing managed destination before writes:

1. For each managed file, check if the destination exists.
2. If it exists and its content differs from the source, report a conflict.
3. Make no change unless `--force` is explicit.
4. Exit with code 1 and list all conflicting paths.

Generated files (`*.lock.yml`, `actions-lock.json`) are never copied by the package. The consumer
compiles its own.

## Templates

`add --template <name>` handles optional templates explicitly. Available templates:

- `agentics-checks`
- `agentics-maintenance`
- `app-ci-dotnet-next`
- `app-ci-node-monorepo`
- `opencode.ci.json`

`opencode.ci.json` is always installed as a mandatory file during catalog install (`add` or TUI route
selection). The `--template opencode.ci.json` command is an advanced option for installing it in
isolation without the rest of the catalog.

Template copies are consumer-owned after installation and must not be silently updated as managed
loops. A second `add --template <name>` on an existing template reports a conflict unless `--force`
is passed.

Workflow templates (`.yml`) install to `.github/workflows/<name>.yml`. The `opencode.ci.json`
template installs to the repository root as `opencode.ci.json`, matching the OpenCode CI
convention used by consumer repositories.

Keep available templates and CLI help aligned with the package payload. The template list in
`cli/src/workflow-catalog.ts` (`templateNames`) must match the templates physically present in
`loops/templates/`.

## Catalog source mapping

The catalog installer maps source directories to consumer destinations:

| Source | Destination | Managed? |
|---|---|---|
| `loops/actions/` | `.github/actions/` | Yes |
| `loops/workflows/` | `.github/workflows/` | Yes |
| `loops/scripts/` | `scripts/` | Yes |
| `loops/templates/opencode/opencode.ci.json` | `opencode.ci.json` | Yes (mandatory) |
| `loops/scripts/compile-agent-workflows.mjs` | `scripts/compile-agent-workflows.mjs` | Yes (mandatory) |

`opencode.ci.json` and `scripts/compile-agent-workflows.mjs` are mandatory. `installCatalog()` always
installs them alongside managed loop files. `installMandatoryFiles()` installs them alone. The TUI
calls `installMandatoryFiles()` when no routes are selected, ensuring they are always installed.

Opt-in templates are handled separately: `loops/templates/<category>/<name>` to
`.github/workflows/<name>` for workflow templates (`.yml`).

The source path is resolved relative to the installed package's `loops/` directory. In development,
that is `cli/loops/` (populated by `prepack`). In a published package, it is the `loops/` field in
`files`.

## Build and release

Before packaging or release:

1. Refresh payload: `pnpm prepack` runs `node ./scripts/copy-loops.mjs` which copies `loops/` into
   `cli/loops/`.
2. Build: `pnpm build` runs `tsc --project tsconfig.json`.
3. Typecheck: `pnpm typecheck` runs `tsc --noEmit`.
4. Test: `pnpm test` runs `vitest run`.
5. Release: `pnpm release` runs build, test, then `npm publish --access public`.

The published package includes `dist/` and `loops/` only. The `prepack` script must run before
publishing so `cli/loops/` is fresh.

Do not publish if `cli/loops/` is stale or missing. The `prepack` hook handles this automatically, but
verify after a clean checkout.
