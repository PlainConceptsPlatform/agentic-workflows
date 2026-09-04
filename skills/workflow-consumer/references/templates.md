# Optional templates

Optional templates are consumer-owned copies after installation. `opencode.ci.json` is always
installed as a mandatory file during catalog install; it is not optional.

| Template | Select when |
|---|---|
| `agentics-checks` | Pull requests must compile locks and lint agentic workflow source |
| `agentics-maintenance` | Repository wants gh-aw maintenance workflow before first compilation |
| `app-ci-dotnet-next` | .NET, SQL Server integration testing, and Next.js match repository |
| `app-ci-node-monorepo` | Node monorepo with supported web, desktop, mobile, and E2E layout matches repository |
| `bug-report` | Repository needs a structured bug report issue template |
| `feature-request` | Repository needs a feature request issue template scoped to small improvements |
| `github-release` | Pushing a `v*` tag should publish a GitHub Release with generated notes |
| `opencode.ci.json` | Always installed as mandatory during catalog install. Advanced: use `--template opencode.ci.json` to install in isolation |

## Install one

Install optional templates via the TUI (toggle the template and press Enter) or the advanced `--template` command:

```sh
npx @plainconceptsplatform/workflows@latest add --template agentics-checks
```

Or with a project-local dependency:

```sh
pnpm exec workflows add --template agentics-checks
```

Each optional template copies to `.github/workflows/<template>.yml`. The package does not track or
update templates after installation. They are consumer-owned. `opencode.ci.json` is always installed
to the repository root as a mandatory file during catalog install; it does not appear as an optional
template in the TUI. `bug-report` and `feature-request` are an exception: they copy to
`.github/ISSUE_TEMPLATE/` instead of `.github/workflows/`.

## What each template does

### `agentics-checks`

A pull-request CI workflow that compiles agentic workflow source and validates generated lockfiles.
It runs when `.github/workflows/*.md`, `.github/workflows/shared/*.md`, `.github/workflows/*.yml`,
`.github/aw/*.json`, or `.github/actions/**` change. Use it to enforce that every change to workflow
source ships with a compiled lockfile.

### `agentics-maintenance`

The pre-generated `agentics-maintenance.yml` that `gh aw compile` would produce. Install it only when
the repository does not want to run `gh aw compile` itself but still wants the maintenance operations
(create labels, disable/enable fleet, activity report, forecast, safe_outputs replay).

### `app-ci-dotnet-next`

A full CI pipeline for a .NET + Next.js application. Includes:

- SQL Server service container with Docker
- `dotnet restore`, `dotnet build -c Release`, per-project `dotnet test`
- Coverage gate
- `pnpm install` and `next build` for the frontend
- TruffleHog, Trivy, Semgrep, SBOM security scans

Read the template's `env:` block and job commands before enabling it. Tailor package names, paths,
versions, artifacts, and scanners to the repository.

### `app-ci-node-monorepo`

A full CI pipeline for a Node monorepo with web, desktop, mobile, and E2E testing. Includes:

- `pnpm install --frozen-lockfile`
- Per-package builds
- Vitest, Playwright E2E
- TruffleHog, Trivy, Semgrep, SBOM

Read the template's `env:` block and job commands before enabling it. Tailor workspace paths, package
scripts, and test commands to the repository.

### `github-release`

Publishes a GitHub Release when a tag matching `v*` is pushed. GitHub generates the notes by comparing
the new tag with the preceding release. Re-running the workflow updates the existing release rather
than failing. Change the tag pattern if the repository uses a different version convention.

### `bug-report`

A GitHub issue template for reporting defects. Installs to `.github/ISSUE_TEMPLATE/bug_report.yml`.
Includes structured fields: what happened, steps to reproduce, expected behavior, where it occurs,
acceptance criteria, open questions, environment, and logs. Bugs can be any size — no scope gate.

### `feature-request`

A GitHub issue template for proposing small improvements. Installs to
`.github/ISSUE_TEMPLATE/feature_request.yml`. Scoped to small, well-scoped work: a required
Small/Medium dropdown gate steers large features to a planning issue instead. Includes problem/
motivation, proposed solution, alternatives, acceptance criteria, and open questions.

### `opencode.ci.json`

A standalone OpenCode CI configuration for consumer repositories running agentic workflows in
GitHub Actions. It is always installed to the repository root as `opencode.ci.json` during catalog
install — it is mandatory, not optional. The `--template opencode.ci.json` command is an advanced
option for installing it in isolation. Includes:

- OpenAI-compatible `forge` provider with endpoint and key supplied by runtime environment variables
- `glm-5-2` ("GLM 5.2") and `glm-5-1` ("GLM 5.1") fallback model registrations
- Default model `forge/glm-5-2`
- `ci-workflow-agent` agent in `primary` mode with the output discipline directive
- LSP disabled for `csharp`, `fsharp`, and `razor` (consumers can remove the `lsp` block)
- `read` permission allow and `/tmp/**` external directory access

Read the file before enabling it. Tailor the provider endpoint, model selection, agent prompt,
permissions, and LSP configuration to the repository. JSON (RFC 8259) does not permit comments, so
the ownership header is documented in a companion `opencode.ci.json.md` file rather than inline.

## What not to do

Do not install a CI template as a generic starting point. Read its top-level `env:` and job commands.
Tailor package names, paths, versions, artifacts, and scanners before enabling it. Remove unused jobs
rather than leaving failing assumptions in CI.

Templates do not receive ownership headers because they are consumer-owned from installation. The
package never updates them. If a newer template version exists, re-run `add --template <name> --force`
to overwrite the local copy.
