# Workflow ownership

The package owns route definitions, workers, composite actions, router assembly, and workflow compilation support in `loops/`. `loops/actions/` holds composite actions, `loops/workflows/` holds workers, shared imports, and router, and `loops/scripts/` holds compilation support.

Every installed source file starts with an ownership header naming `@plainconceptsplatform/workflows`, its `loops/` source path, and `workflows update --force`. YAML headers are line 1. Worker Markdown keeps `---` on line 1 and puts its header on line 2 inside frontmatter. Shell headers follow a shebang when present. The CLI stamps the package version into the header at install time (`@plainconceptsplatform/workflows@0.7.0`); that version is the baseline the next update merges against. An update replaces every package-managed file; in a worker only the `env:` block, the runner pool and the engine gateway URL survive. A file whose header was removed is consumer-owned and is skipped unless `--force` is passed.

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

The router (`work-router.yml`) is the derived file: its content is assembled from the set of installed routes, not authored per consumer. The CLI owns that assembly so the router references exactly the workers present on disk. A route that is not installed loses its `call-<route>` job, the deterministic jobs that serve only it (`check-implement-pr`, `dispatch-triage`), its cron and its `workflow_dispatch` option. The classifier (`classify-route/classify-route.sh`) is the complete route table in every repository, because a route with no job is a no-op run, and the route matrix (`verify-route-matrix/verify-route-matrix.sh`) reads the installed `agent-*.md` files and asserts that exactly those routes have jobs. Neither is rewritten by the CLI.

`add <routes>` unions the requested routes with the routes already installed; `update` (and `add` with no routes) refreshes exactly the installed set; `remove <routes>` drops the requested routes from that set. All regenerate the router from the resulting set and refresh every other package-managed file. `remove` also deletes each removed route's `agent-<route>.md` and its generated `agent-<route>.lock.yml`. The interactive TUI is desired-state: the checked routes are the target set, so checking adds a route, unchecking removes it, and Enter on an unchanged selection is an update. `release` is a route like the other six and is never installed unrequested.

## What an update keeps

A package-managed file is the package's. `update` replaces it with the current version's and stamps the version into its header. The one customisable surface is the `env:` block at the top of a worker: the consumer's values are kept, keys the package added arrive with their defaults, keys only the consumer defined stay at the end of the block. When the header records the version the consumer installed from, the CLI fetches that release from npm and uses it as the merge baseline, so a value the consumer never changed follows the package when its default changes and a key the package removed disappears when the consumer never changed it. Offline, every consumer value is kept and the result reports the baseline as unavailable. The worker's runner pool (`runs-on`) and its engine gateway URL are kept as well, because GitHub gives neither a home in `env:`. If something else needs to differ per repository, it becomes an env variable in `loops/`; a body or job edit made in a consumer is replaced on the next update.

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
