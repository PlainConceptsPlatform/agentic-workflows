---
name: cli
description: >
  Maintain the package installer, updater, templates, and release behavior. Load when
  changing CLI commands, catalog installation logic, the update merge, ownership header
  stamping, template handling, or the build and release pipeline.
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
| `cli/src/index.ts` | Parses commands, computes the route set (requested ∪ installed), controls exit codes, prints help and the JSON result |
| `cli/src/catalog-installation.ts` | Copies package-managed files, decides per file whether it is added, updated, unchanged or skipped, stamps versions, stages the compile, applies atomically |
| `cli/src/worker-env.ts` | Parses a worker's `env:` block and merges it two- or three-way; keeps the runner pool and the engine gateway URL |
| `cli/src/package-baseline.ts` | Reads and writes the version in ownership headers; fetches a published release from npm as the merge baseline |
| `cli/src/route-processing.ts` | Regenerates the router for the installed route set |
| `cli/src/stack-defaults.ts` | Stack detection defaults: `VERIFY_COMMANDS` on first install, the shared CI steps and the OpenCode config on every install |
| `cli/src/workflow-catalog.ts` | Route names, worker files, template names, package-owned targets |
| `cli/src/repository-inspection.ts` | Inspects the repository stack and visibility |
| `cli/src/tui.ts` | The interactive selection screen |
| `cli/scripts/copy-loops.mjs` | Refreshes package payload before packing |
| `cli/loops/` | Generated payload. Edit `loops/` source instead, then refresh |

Do not modify `loops/`, templates, or generated payload while changing CLI unless the request
explicitly includes those files.

## Commands

Running `workflows` with no arguments launches the interactive TUI, the primary entrypoint. The TUI lists all routes and templates with install status. Arrow keys navigate, space toggles, Enter installs. The checked routes are the target set; Enter on an unchanged selection is an update.

Non-interactive commands for automation:

| Command | Flags | Behavior |
|---|---|---|
| (default) | `--force` | Launches the interactive TUI |
| `init` | `--visibility public\|private` | Inspects repository and visibility. Writes no workflow files. Prints JSON |
| `add [routes]` | `--template <name>`, `--force`, `--dry-run` | Installs the named workers on top of the installed ones and refreshes every package-managed file. With no routes, refreshes what is installed |
| `update` | same as `add` | Alias for `add` with no routes |
| `remove <routes>` | `--force`, `--dry-run` | Drops the routes from the installed set, regenerates the router, deletes the workers and their locks |
| `status` | none | Inspects repository. Prints JSON |
| `list` | none | Lists all workflows and templates with install status |
| `search` | `<query>` | Filters workflows and templates by name or description |
| `--version` | none | Prints the package version |
| `--help` / `-h` | none | Prints usage |

The help string in `cli/src/index.ts` must match the bin name `workflows`, list the TUI as default,
derive the route and template lists from `workflow-catalog.ts`, and describe the update policy below.

## The update policy

Every package-managed file is the package's. `installCatalog()` computes, for each target in the
installed set, one of four statuses and reports them in `changes`:

| Status | When |
|---|---|
| `added` | The consumer has no copy |
| `updated` | The consumer's copy differs from this version's (after the env merge for a worker) |
| `unchanged` | Byte-equal after normalising line endings; the file is not rewritten |
| `skipped` | The consumer's copy has no ownership header (consumer-owned) and `--force` was not passed |

Only `added` and `updated` files are written. Line endings of an existing file are kept.
`conflicts` is empty for catalog files; only `installTemplate()` reports conflicts, because
templates are consumer-owned from installation and are replaced only with `--force`.

The router (`work-router.yml`) is merged the same way, through `mergeRouter`, because its own
`env:` block carries the two values a repository must set: `CI_WORKFLOW_NAME` and `AUDIT_CRON`.
Both are also needed where GitHub evaluates no expression (a `workflow_run.workflows:` list and a
`cron:`), so `mirrorRouterLiterals` copies them from `env:` into those two literal lines after the
merge. The audit cron line is found by its `# audit slot` marker comment. Everything inside a job
reads the values from `env:`, including `classify-route.sh`, whose `AUDIT_CRON` is
`"${AUDIT_CRON:-<package default>}"`. `verify-route-matrix.sh` asserts the copies still agree and
that no third literal appears.

A worker (`agent-*.md`) is merged by `worker-env.ts`: the package file with the consumer's `env:`
values put back. Package comments in the block are kept; consumer values replace package values;
keys the package added get their defaults; keys only the consumer defines are appended. With a
baseline (the release the consumer installed from) the merge is three-way: a consumer value equal to
the baseline's follows the package (`updatedDefaults`), a consumer value that differs is kept
(`keptEnv`), a key the package removed is dropped if the consumer never changed it (`droppedEnv`) and
kept otherwise (`consumerOnlyEnv`). The runner pool (`runs-on`, when the consumer names exactly one)
and `engine.env.OPENAI_BASE_URL` are kept as well.

Stack defaults apply once to a worker: `VERIFY_COMMANDS` is replaced with the stack default only
when the worker is first installed, and only when the worker declares the key. The shared CI file and
`opencode.ci.json` are derived from the repository, so their transforms run on every install and are
idempotent.

`--dry-run` computes the same result and writes nothing, not even the pre-commit hook, and skips the
staged compile.

## Ownership headers and the version stamp

Headers are authored in the source files under `loops/` without a version:

```
# Managed by @plainconceptsplatform/workflows. Source: loops/<path>. Update with `workflows update --force`; consumer edits may be overwritten.
```

The CLI stamps the package version into the header when it installs or updates a file:

```
# Managed by @plainconceptsplatform/workflows@0.7.0. Source: loops/<path>. ...
```

`package-baseline.ts` owns both directions (`stampVersion`, `installedVersion`). The format varies by
file type: YAML first line starting with `#`; Markdown second line inside `---`; shell after the
shebang; JavaScript first line starting with `//`. JSON cannot carry a comment, so `opencode.ci.json`
has no header and no stamp, and documents its ownership in `opencode.ci.json.md`. Templates keep
their header verbatim; they are not stamped.

`fetchBaseline(version)` runs `npm pack @plainconceptsplatform/workflows@<version>` into a cache under
the OS temp directory and unpacks the tarball in-process (no `tar` binary: the one on PATH may be GNU
tar under MSYS, which reads `C:\...` as a host name); it returns the release's `loops/` directory or
`undefined`, and the installer degrades to a two-way merge and reports the baseline as `unavailable`.
Tests inject `baseline` and `packageVersion` through `CatalogInstallOptions` rather than reaching npm.

## Templates

`add --template <name>` handles optional templates explicitly. Available templates are the entries of
`templateNames` in `cli/src/workflow-catalog.ts`; that list must match the templates physically present
in `loops/templates/`.

`opencode.ci.json` is always installed as a mandatory file during catalog install (`add` or TUI route
selection). The `--template opencode.ci.json` command is an advanced option for installing it in
isolation without the rest of the catalog.

Template copies are consumer-owned after installation and must not be silently updated as managed
loops. A second `add --template <name>` on an existing template reports a conflict unless `--force`
is passed. Workflow templates (`.yml`) install to `.github/workflows/<name>.yml`; the issue templates
install to `.github/ISSUE_TEMPLATE/`; `opencode.ci.json` installs to the repository root.

## Catalog source mapping

| Source | Destination | Managed? |
|---|---|---|
| `loops/actions/` | `.github/actions/` | Yes |
| `loops/workflows/` | `.github/workflows/` | Yes |
| `loops/scripts/` | `scripts/` | Yes |
| `loops/templates/opencode/opencode.ci.json` | `opencode.ci.json` | Yes (mandatory) |
| `loops/scripts/compile-agent-workflows.mjs` | `scripts/compile-agent-workflows.mjs` | Yes (mandatory) |

Workers not in the selected route set are left out of the file set, and the router is regenerated
for that set by `route-processing.ts`: the excluded route's `call-<route>` job, the helper jobs that
serve only it (`check-implement-pr`, `dispatch-triage`), its cron and its dispatch option go. The
classifier and the route matrix are copied as they are; the matrix reads the installed workers.

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

Bump `version` in both `package.json` and `cli/package.json` before publishing: the version is what
consumers' headers record, and a release that reuses a version gives the next update the wrong
baseline. The published package includes `dist/` and `loops/` only. The `prepack` script must run
before publishing so `cli/loops/` is fresh.
