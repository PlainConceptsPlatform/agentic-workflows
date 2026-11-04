# Changelog

Releases of `@plainconceptsplatform/workflows`. Earlier versions are described in their GitHub Releases and commit messages.

## 1.12.0

### Added

- The platform contract, `.platform/contract.yml`: an open file in which a repository names the template it receives shared code from (`source`), the paths that template owns (`owned`), its exceptions file and how it syncs (`sync.marker`, `sync.version`, `sync.update`). `docs/platform-contracts.md` documents the format with a neutral example, what this package does with each field, and that other tools may read the same file while none is required.
- `check-platform-conformance.mjs --compare`: fetches `source.url` at the version `sync.version` records and fails an owned file that differs or is missing, unless an unexpired exception covers it. When git cannot read the template, it says so and runs the other checks. `--contract` prints the resolved contract for a workflow.

### Changed

- `platform-template` is template-agnostic. The conformance script reads the contract with its own small parser, and an invalid one fails with one error naming the file and the field. A template sync is a pull request that changes `sync.marker` or moves `sync.version`, and messages name `source.name` and `source.changes` instead of Kitchen-Sink. The repository whose `origin` is `source.url` is the template itself and passes.
- `platform-template-sync.yml` runs `sync.update` and opens or updates one pull request from `platform/template-sync`, titled with the new version. It installs copier only when the command starts with `copier`; any other command is the repository's to provide. Without a contract, in the template itself or without `sync.update` it does nothing.
- `app-ci-dotnet-next`'s `Platform conformance` job runs where a contract exists, or the legacy `.copier-answers.yml` with `.platform/manifest`, and compares the owned files with the template.
- `.copier-answers.yml` with `.platform/manifest` and no `contract.yml` is read as the contract it implies, so 1.11.0 installs keep working. `.copier-answers.yml` alone is no longer a contract: the guard passes such a repository instead of failing it for a missing manifest.
- `docs/family-templates.md` keeps the quality gates, the gates CI and the Dependabot settings, and points at `docs/platform-contracts.md` for the template sync and the guard.

## 1.11.0

### Added

- `quality-gates` template, opt-in with `workflows add --template quality-gates`: Kitchen-Sink's coverage, complexity, duplication and mutation gates, the Engineering Excellence facets and their schema, `scripts/lib/*` with its tests, `dast-wait-stable.sh`, the Semgrep hygiene rules as `.semgrep/platform-hygiene.yml`, `.jscpd.json` and `.zap/rules.tsv`. The floors moved out of code into the app's `quality.config.json`; baselines stay app files and are never installed.
- `platform-template` template, opt-in with `workflows add --template platform-template`: `.github/workflows/platform-template-sync.yml`, a weekly `copier update` against the Kitchen-Sink template that opens one pull request per new tag, and `scripts/check-platform-conformance.mjs`, which fails a pull request that changes `.platform/manifest` paths outside a sync or an unexpired exception, conflict markers, and expired exceptions. Both do nothing without `.copier-answers.yml`.
- Bundle templates: several package-managed files that keep the ownership header, are stamped like the catalog, and are refreshed by `update` only where one of their files carries the header. A repository with its own headerless copies of the same paths, such as Atlas or Pliny-Bot, gets nothing from `update`, with or without `--force`.
- `docs/family-templates.md`: the templates, the `quality.config.json` schema, the gates CI settings and the Dependabot settings family apps need.

### Changed

- `app-ci-dotnet-next` is now the platform family's gates CI, reconciled from the Kitchen-Sink, Numa, Odyssey and Hermes `app-ci.yml` with Kitchen-Sink's as the base: CI depth, change scope, the engineering gates and facets, optional E2E, the `Platform conformance` job and the `dispatch-merge-gate` handoff to the merge train. Everything that differed between the apps is a top-level `env:` value or a floor in `quality.config.json`. It stays an opt-in, single-file template.
- The CLI's vitest run is scoped to `cli/src`, so the `node:test` suites the templates ship are not collected from the generated payload.
