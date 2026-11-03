# Platform family templates

Numa, Odyssey, Hermes and Kitchen-Sink are one family: they share their platform code and their quality bar, and Kitchen-Sink is the reference app and the Copier template. This package carries the parts that are not app code, as three opt-in templates:

| Template | Installs | Kept current by |
|---|---|---|
| `quality-gates` | The gate scripts, the Engineering Excellence facets and the gate rules (Semgrep, jscpd, ZAP) | `workflows update`, where installed |
| `app-ci-dotnet-next` | The gates CI, `.github/workflows/app-ci.yml` | The app; replaced only with `--force` |
| `platform-template` | The weekly template sync and the platform conformance guard | `workflows update`, where installed |

None of them is part of the default catalog. A repository gets one only by asking for it:

```bash
npx @plainconceptsplatform/workflows add --template quality-gates
npx @plainconceptsplatform/workflows add --template app-ci-dotnet-next
npx @plainconceptsplatform/workflows add --template platform-template
```

`quality-gates` and `platform-template` are bundle templates. Unlike the single-file templates they stay package-managed after installation, under the rules in [ownership.md](ownership.md): every file carries the ownership header, `update` replaces it and stamps the version, and a file whose header was removed is the app's and is skipped unless `--force` is passed. `update` refreshes a bundle only where at least one of its files carries the header, so a repository that keeps its own headerless `scripts/check-*.mjs` (Atlas, Pliny-Bot) never gets anything from it, with or without `--force`.

## quality-gates

The Kitchen-Sink gates, made app-neutral:

| File | What it is |
|---|---|
| `scripts/check-coverage.mjs` | Per-assembly line-coverage floors on the merged Cobertura report, and the web floor on the vitest report |
| `scripts/check-complexity.mjs` | The blocking complexity gate (CC ≤ 15, CRAP ≤ 30) against the app's `scripts/complexity-baseline.json` |
| `scripts/check-duplication.mjs` | The blocking duplication gate against the app's `scripts/duplication-baseline.json` |
| `scripts/check-mutation.mjs` | The covered-code mutation floor per scope, for the weekly Stryker run |
| `scripts/engineering-excellence.mjs` | Builds the coverage, complexity, mutation, security, SBOM and hygiene facets Project-Health collects |
| `scripts/engineering-excellence.schema.json` | The facet contract, vendored verbatim; `.md` beside it carries the header |
| `scripts/lib/*.mjs` | Parsers, gate rules and the quality config loader, with their `node:test` suites |
| `scripts/dast-wait-stable.sh` | Waits until a deployed build is serving and stable before a ZAP scan |
| `.semgrep/platform-hygiene.yml` | The empty-catch rules, `platform-hygiene-csharp-empty-catch` and `platform-hygiene-ts-empty-catch`, scoped to `apps/` |
| `.jscpd.json` | The duplication scope; `.jscpd.json.md` beside it carries the header |
| `.zap/rules.tsv` | The ZAP baseline triage the family shares |

JSON cannot carry a comment, so a JSON file's header lives in a companion `<file>.md`, as with `opencode.ci.json`. The JSON is the package's while that note is there with its header. To take `.jscpd.json` over, remove the header paragraph from `.jscpd.json.md` (or delete the note). A JSON file the app already had with no note beside it is the app's, and installing the template leaves it and its note out unless `--force` is passed.

The baselines (`scripts/complexity-baseline.json`, `scripts/duplication-baseline.json`) and `quality.config.json` are app files. The template never installs or touches them.

Adopting the template in an app that has its own copies:

1. Install with `--force` so the package's copies replace the app's.
2. Write `quality.config.json` from the app's current `FLOORS`, `WEB_FLOOR` and mutation `FLOORS`.
3. Delete the old `.semgrep/<app>-hygiene.yml` and rename every `// nosemgrep: <app>-hygiene-…` justification to the `platform-hygiene-…` rule id, or Semgrep stops honouring it.
4. Run `node --test scripts/lib/*.test.mjs` and the gates locally.

## quality.config.json

The numbers the gates enforce, at the repository root. Floors sit just under the measured baseline and only ever ratchet up: never lower one to go green.

```json
{
  "coverage": {
    "api": { "KitchenSink.Domain": 0.94, "KitchenSink.Application": 0.89 },
    "reportOnly": [],
    "web": 0.64
  },
  "mutation": { "domain": 0.82, "web": 0.79 }
}
```

| Key | Type | Meaning |
|---|---|---|
| `coverage.api` | object, assembly name → rate | Line-coverage floor per .NET assembly on the merged unit, acceptance and integration report. An assembly with a floor and no data fails. At least one is required. |
| `coverage.reportOnly` | array of assembly names | Assemblies printed with their rate but not gated yet. Optional. |
| `coverage.web` | rate | Floor for the root line-rate of the vitest v8 Cobertura report. Required for `check-coverage.mjs --web`. |
| `mutation` | object, scope → rate | Covered-code mutation score floor per Stryker scope (`domain`, `web`, …). `check-mutation.mjs <scope>` fails for a scope with no floor. |
| `$schema` | string | Optional, ignored. |

A rate is a number from 0 to 1. Any other key, a percentage written as 94, or a string fails every gate with the list of problems, so a typo can never silently gate nothing.

## The gates CI: app-ci-dotnet-next

`.github/workflows/app-ci.yml` for a family app, reconciled from the four apps' own CI with Kitchen-Sink's as the base. Everything that differed between them is a top-level `env:` value or a floor in `quality.config.json`:

| `env:` | Use |
|---|---|
| `DOTNET_SOLUTION`, `MIGRATION_*`, `SEED_PROJECT`, `API_PROJECT` | The app's .NET names |
| `UNIT_TEST_PROJECT`, `PARITY_TEST_PROJECT`, `ARCHITECTURE_TEST_PROJECT`, `ACCEPTANCE_TEST_PROJECT`, `INTEGRATION_TEST_PROJECT` | Test suites; an empty value skips that suite |
| `PRIMARY_DATABASE`, `DATABASE_CONNECTION_ENV` | The test database and the variable migrations, the seed and the E2E API read it from (`ConnectionStrings__<App>`) |
| `INTEGRATION_CONNECTION_ENV` | The variable the integration suite reads it from, which may be a test-only name (Kitchen-Sink's `KS_TEST_CONNECTION`, Hermes' `HERMES_TEST_SQL`) |
| `EXTRA_DATABASES` | `NAME=database` pairs for more databases the integration suite needs (Numa: `DataLayer__ConnectionString=numa_dl`) |
| `SEED_EXTRA_ENV` | `NAME=value` pairs the seed needs (Hermes: `ConnectionStrings__blobs=UseDevelopmentStorage=true`) |
| `WEB_PACKAGE`, `ROOT_PACKAGE` | The web workspace and the root package names |
| `WEB_EXTRA_COMMANDS` | Commands after the web build (Hermes' MCP app and prompt sync) |
| `EXTRA_NODE_TESTS` | More `node --test` files for the engineering-excellence job (Hermes' `scripts/sync-prompt.test.mjs`) |
| `E2E_COMMAND` | Playwright against the SPA served by the API; empty skips the E2E job |
| `MARKDOWN_LINT_COMMAND`, `REPO_CHECK_COMMANDS` | The Markdown job and the app's own checks (Kitchen-Sink's `node scripts/check-demo-manifest.mjs`); empty skips the steps |
| `SBOM_ARTIFACT_NAME`, `SEMGREP_EXCLUDES`, images and versions | Scanner settings |

The job names are the ones the apps' required checks and the merge train read (`Full CI`), and the last job, `dispatch-merge-gate`, hands a bot pull request's verdict to the router's merge train exactly as the apps' CI does. A deploy pipeline that calls the workflow with `uses:` must grant `actions: write`. The `Platform conformance` job runs the guard below where the app has adopted the template and passes everywhere else.

It stays a single-file template: once installed it is the app's, and `--force` replaces it with the package's, `env:` included.

## platform-template

Kitchen-Sink is the Copier template of the family. An app adopts it with `copier copy`, which writes `.copier-answers.yml`; that file is the opt-in marker, and without it both pieces of this template do nothing.

### Template sync

`.github/workflows/platform-template-sync.yml` runs every Monday and on demand. It is plain YAML, no model:

1. It stops unless `.copier-answers.yml` exists.
2. It mints the Platform App token from `BOT_APP_ID` / `BOT_PRIVATE_KEY`, which reads the private Kitchen-Sink repository named in `_src_path`.
3. It runs copier 9.19.1 through `uvx`, `pipx` or a virtual environment from the runner's Python (3.10 or newer), as `copier update --trust --defaults --conflict inline`.
4. No change means the app is on the newest template tag, and the run ends.
5. Otherwise it commits to `platform/sync-<tag>` and opens a pull request titled with the tag, listing the changed files, the files with conflicts, and a link to the Kitchen-Sink release.

A platform file the app had edited comes back with inline `<<<<<<< before updating` markers. The conformance guard fails CI on them, so the merge gate repairs the pull request (`remediated`) like any red one.

The App must be installed on Kitchen-Sink with contents read, and on the app with contents and pull requests write. A push made with `GITHUB_TOKEN` starts no workflow, so the App token pushes the branch.

### Conformance guard

`scripts/check-platform-conformance.mjs` runs offline in the `Platform conformance` job:

- No `.copier-answers.yml`: it exits 0 without a word.
- A pull request that changes a path matching `.platform/manifest` fails, unless it also moves `_commit` in `.copier-answers.yml` (a sync, or the adoption itself) or an unexpired `.platform/exceptions.yml` entry covers the path.
- A manifest file holding conflict markers fails.
- An expired exception fails, whether or not the pull request uses it.

`.platform/manifest` holds one gitwildmatch glob per line, relative to the repository root, with `#` comments and `!` negation; the last matching line decides. `.platform/exceptions.yml` is the app's:

```yaml
exceptions:
  - path: "apps/api/src/Platform/Audit/**"
    reason: Numa keeps its own audit hashing until the chain lands upstream
    issue: https://github.com/PlainConceptsPlatform/Numa/issues/123
    expires: 2026-12-31
```

Every entry needs all four keys, `expires` is a `YYYY-MM-DD` date and stays valid through that day.

## Dependabot

The template bumps what it owns: the pnpm `platform` catalog in `pnpm-workspace.yaml` and the packages in `apps/api/Directory.Packages.Platform.props`. A Dependabot pull request for one of them edits a manifest path outside a sync, so the conformance guard fails it, and the next sync would overwrite it anyway. Family apps ignore them, one entry per package in the catalog and the props file:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      # The `platform` catalog in pnpm-workspace.yaml; the platform template bumps these.
      - dependency-name: "@plainconceptsplatform/*"
      - dependency-name: "next"
      - dependency-name: "react"
      - dependency-name: "react-dom"
  - package-ecosystem: nuget
    directory: /apps/api
    schedule:
      interval: weekly
    ignore:
      # apps/api/Directory.Packages.Platform.props; the platform template bumps these.
      - dependency-name: "ModelContextProtocol.AspNetCore"
      - dependency-name: "Microsoft.Identity.Web*"
```

Copy the names from Kitchen-Sink's catalog and props file at the tag the app is on; the ones above only show the shape. Everything else stays with Dependabot as before.
