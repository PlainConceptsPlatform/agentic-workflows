# Changelog

Releases of `@plainconceptsplatform/workflows`. Earlier versions are described in their GitHub Releases and commit messages.

## 1.11.0

### Added

- `quality-gates` template, opt-in with `workflows add --template quality-gates`: Kitchen-Sink's coverage, complexity, duplication and mutation gates, the Engineering Excellence facets and their schema, `scripts/lib/*` with its tests, `dast-wait-stable.sh`, the Semgrep hygiene rules as `.semgrep/platform-hygiene.yml`, `.jscpd.json` and `.zap/rules.tsv`. The floors moved out of code into the app's `quality.config.json`; baselines stay app files and are never installed.
- `platform-template` template, opt-in with `workflows add --template platform-template`: `.github/workflows/platform-template-sync.yml`, a weekly `copier update` against the Kitchen-Sink template that opens one pull request per new tag, and `scripts/check-platform-conformance.mjs`, which fails a pull request that changes `.platform/manifest` paths outside a sync or an unexpired exception, conflict markers, and expired exceptions. Both do nothing without `.copier-answers.yml`.
- Bundle templates: several package-managed files that keep the ownership header, are stamped like the catalog, and are refreshed by `update` only where one of their files carries the header. A repository with its own headerless copies of the same paths, such as Atlas or Pliny-Bot, gets nothing from `update`, with or without `--force`.
- `docs/family-templates.md`: the templates, the `quality.config.json` schema, the gates CI settings and the Dependabot settings family apps need.

### Changed

- `app-ci-dotnet-next` is now the platform family's gates CI, reconciled from the Kitchen-Sink, Numa, Odyssey and Hermes `app-ci.yml` with Kitchen-Sink's as the base: CI depth, change scope, the engineering gates and facets, optional E2E, the `Platform conformance` job and the `dispatch-merge-gate` handoff to the merge train. Everything that differed between the apps is a top-level `env:` value or a floor in `quality.config.json`. It stays an opt-in, single-file template.
- The CLI's vitest run is scoped to `cli/src`, so the `node:test` suites the templates ship are not collected from the generated payload.
