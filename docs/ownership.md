# Workflow ownership

The package owns route definitions, workers, composite actions, router assembly, and workflow compilation support in `loops/`. `loops/actions/` holds composite actions, `loops/workflows/` holds workers, shared imports, and router, and `loops/scripts/` holds compilation support.

Every installed source file starts with an ownership header naming `@plainconceptsplatform/workflows`, its `loops/` source path, and `workflows update --force`. YAML headers are line 1. Worker Markdown keeps `---` on line 1 and puts its header on line 2 inside frontmatter. Shell headers follow a shebang when present. Consumer edits to package-managed files can be overwritten by `update --force`.

Workers are standalone copyable source files. Each worker owns every workflow-level environment value it needs in top-level `env:` frontmatter. Shared imports may provide shared behavior, but must not hide per-worker configuration.

Consumers manually edit copied worker frontmatter when their repository needs different:

- repository visibility and trusted bot actors;
- CI workflow name and eligible branch patterns;
- enabled routes and their schedules;
- stack setup, required network domains, and OpenCode configuration;
- verification commands, repository rules, and model endpoint defaults shown to agents.

Each worker declares an OpenAI-compatible gateway endpoint in its worker-local `OPENAI_BASE_URL` value. Consumers set that value to their own gateway; OpenCode workers retain their engine endpoint because `gh aw` routes them through its runtime proxy.

Generated `*.lock.yml` files and `.github/aw/actions-lock.json` belong only in consumer repositories. Consumers regenerate them with supplied compile script.

## Route set and the derived router

The router (`work-router.yml`), the classifier (`classify-route/classify-route.sh`), and the route matrix (`verify-route-matrix/verify-route-matrix.sh`) are derived files: their content is assembled from the set of installed routes, not authored per consumer. The CLI owns that assembly so the router references exactly the workers present on disk.

`add <routes>` unions the requested routes with the routes already installed; `remove <routes>` drops the requested routes from that set. Both regenerate the three derived files from the resulting set. `remove` also deletes each removed route's `agent-<route>.md` and its generated `agent-<route>.lock.yml`. The interactive TUI is desired-state: the checked routes are the target set, so checking adds a route and unchecking removes it. Because changing the route set rewrites the package-owned router, these operations require `--force` to overwrite it; standalone worker frontmatter edits are still preserved across regeneration.

## Consumer prerequisite

Before installing or compiling workflows, consumers should install and configure `PlainConceptsPlatform/agent-harness`. Loop workers invoke the skills and commands it provides. Verify the required skills and commands are available in the consumer repository before compiling.

The primary entrypoint is the interactive TUI: `npx @plainconceptsplatform/workflows` (no arguments). Non-interactive commands (`init`, `add`, `update`) are advanced options for automation. Use `pnpm exec workflows` (no arguments) to launch the TUI when the package is a project-local development dependency.

Workers use generic Platform baseline wording and `pnpm verify` by default. Consumers replace these
worker-local values and prompt guidance when their repository needs different checks or rules.

## Optional templates

`loops/templates/agentics/`, `loops/templates/ci/`, and `loops/templates/release/` contain standalone opt-in templates. Catalog installation never copies them implicitly. Consumers select one with `workflows add --template agentics-checks|agentics-maintenance|app-ci-dotnet-next|app-ci-node-monorepo|github-release`, and can replace a changed copy only with `--force`. `github-release` publishes a generated GitHub Release when a `v*` tag is pushed. `loops/templates/opencode/opencode.ci.json` is always installed as a mandatory file during catalog install — it is not optional. The `--template opencode.ci.json` command is an advanced option for installing it in isolation.

`app-ci-dotnet-next` is based on a production .NET + Next.js application CI and retains .NET, SQL Server integration testing, Next.js, TruffleHog, Trivy, Semgrep, and SBOM checks. `app-ci-node-monorepo` is based on a production Node monorepo CI and retains Node monorepo, browser, Electron, Capacitor, TruffleHog, Trivy, Semgrep, and SBOM checks. Both are standalone workflows with top-level `env:` defaults; neither calls reusable repository workflows or reads repository configuration.

`opencode.ci.json` is a standalone OpenCode CI configuration template. It declares an OpenAI-compatible `forge` provider whose endpoint and key come from runtime environment variables, registers fallback model metadata, defaults to `forge/glm-5-3`, and includes the `ci-workflow-agent` agent definition with output discipline directive. Consumers configure `FORGE_API_URL`, `FORGE_API_KEY`, model IDs, and image capabilities for their own gateway. LSP is disabled for csharp, fsharp, and razor; consumers not working with .NET can remove the `lsp` block. JSON (RFC 8259) does not permit comments, so the ownership header is documented in a companion `opencode.ci.json.md` file. Workflow templates install to `.github/workflows/`; `opencode.ci.json` installs to the repository root.

`agentics-maintenance.yml` is derived from the maintenance workflow generated by `gh aw compile` with gh-aw v0.83.4, the version currently standardized across the consumer repositories. Regenerate the consumer copy with that command after updating gh-aw.
