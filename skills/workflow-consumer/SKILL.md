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

`add` installs managed loop files and the mandatory `opencode.ci.json` and
`scripts/compile-agent-workflows.mjs`. The TUI also installs these mandatory files when any route or
template is selected. `update` refreshes them.

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

## Customise standalone workers

Managed files include ownership headers and source paths. Read the header before editing. `add` and
`update` stop on changed managed files; inspect the diff first. Use `--force` only when intentionally
replacing a managed file. Back up or move consumer changes before force update.

There is no shared `repo-config` file. Every `agent-*.md` worker is standalone. After installation,
edit that worker's top-level `env:` values directly for labels, paths, prompt rules, endpoint,
model-related settings, and verification commands.

The CLI generates stack-aware defaults for `VERIFY_COMMANDS` and base `REPO_RULES` by detecting the
repository's technology stack at install time. It inspects for `.slnx` ( .NET solutions) and
`pnpm-lock.yaml`, then injects appropriate verify commands and architecture rules into each worker's
`env:` block. `shared/platform-defaults.md` no longer carries `VERIFY_COMMANDS` — that value is now
generated per-worker during installation and can be overridden in each worker. This keeps the shared
file to network allowlists and safe-output defaults only.

Consumers MUST edit each worker's `REPO_RULES` to contain route-specific rules relevant to their
repository. The CLI generates a base from stack detection (e.g., "Follow Clean Architecture layering"
for .NET repos), but route-specific rules require domain knowledge the CLI does not have. See
`references/customize.md` for what each route's `REPO_RULES` should focus on.

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
