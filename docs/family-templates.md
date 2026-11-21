# Platform family templates

Numa, Odyssey, Hermes and Kitchen-Sink are one family: they share their platform code and their quality bar, and Kitchen-Sink is the reference app and the Copier template. This package carries the parts that are not app code, as three opt-in templates:

| Template | Installs | Kept current by |
|---|---|---|
| `quality-gates` | The gate scripts, the Engineering Excellence facets and the gate rules (Semgrep, jscpd, ZAP) | `workflows update`, where installed |
| `app-ci-dotnet-next` | The gates CI, `.github/workflows/app-ci.yml` | The app; replaced only with `--force` |
| `platform-template` | The weekly template sync and the conformance guard, driven by the [platform contract](platform-contracts.md) | `workflows update`, where installed |

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
| `scripts/check-dead-code.mjs` | The web dead-code check: Knip's JSON per issue type against `deadCode` in `quality.config.json` |
| `scripts/check-bundle-size.mjs` | The web bundle-size check: size-limit's JSON for the static export's chunks against the `bundle` budget |
| `scripts/check-architecture.mjs` | The web architecture check: Steiger's JSON warnings per rule against `architecture` in `quality.config.json` |
| `scripts/check-patterns.mjs` | The .NET code-patterns check: the build's SARIF errors and warnings per analyzer rule against `patterns` in `quality.config.json` |
| `scripts/engineering-excellence.mjs` | Builds the coverage, complexity, mutation, security, SBOM, hygiene, bundle, architecture and patterns facets Project-Health collects, and the audit worklist (`worklist`) |
| `scripts/engineering-excellence.schema.json` | The facet contract, vendored verbatim; `.md` beside it carries the header |
| `scripts/engineering-excellence-worklist.schema.json` | The contract of the audit worklist (`engineering-excellence.mjs worklist`); `.md` beside it carries the header |
| `scripts/lib/*.mjs` | Parsers, gate rules, the quality config loader and `gate-cli.mjs` (what the report-then-ratchet scripts share: arguments, the mode line, baseline writes), with their `node:test` suites |
| `scripts/dast-wait-stable.sh` | Waits until a deployed build is serving and stable before a ZAP scan |
| `.semgrep/platform-hygiene.yml` | The empty-catch rules, `platform-hygiene-csharp-empty-catch` and `platform-hygiene-ts-empty-catch`, scoped to `apps/` |
| `.jscpd.json` | The duplication scope; `.jscpd.json.md` beside it carries the header |
| `knip.json` | Knip's scope, the `apps/web` workspace with the Next.js, Vitest, Playwright and Biome plugins; `knip.json.md` carries the header |
| `.size-limit.json` | What size-limit measures, `apps/web/out/_next/static/chunks/**/*.js`; `.size-limit.json.md` carries the header |
| `.zap/rules.tsv` | The ZAP baseline triage the family shares |

JSON cannot carry a comment, so a JSON file's header lives in a companion `<file>.md`, as with `opencode.ci.json`. The JSON is the package's while that note is there with its header. To take `.jscpd.json` over, remove the header paragraph from `.jscpd.json.md` (or delete the note); the same goes for `knip.json`, which most apps take over as soon as they need their own entries. A JSON file the app already had with no note beside it is the app's, and installing the template leaves it and its note out unless `--force` is passed.

The baselines (`scripts/complexity-baseline.json`, `scripts/duplication-baseline.json`) and `quality.config.json` are app files. The template never installs or touches them; the gate scripts write a baseline only when asked to (`--write-baseline`, `--prune`, `--update-baseline`).

The gate scripts find the api and web projects through the workflow `env:`, the same `API_WORKING_DIRECTORY` and `WEB_DIRECTORY` the CI templates declare (defaults `apps/api` and `apps/web`). A repository with another layout sets those two values; `update` keeps them. `.jscpd.json`, `knip.json`, `.size-limit.json` and the Semgrep rules are static files that name `apps/...` themselves: such a repository takes them over (see each `.md` header).

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
  "mutation": { "domain": 0.82, "web": 0.79 },
  "deadCode": { "mode": "report", "since": "2026-11-16", "baseline": { "exports": 120, "files": 3, "types": 45 } },
  "bundle": { "mode": "report", "since": "2026-11-16", "baselineBytes": 412000, "limitBytes": 453200 },
  "architecture": { "mode": "report", "since": "2026-11-17", "baseline": { "fsd/public-api": 2 } },
  "patterns": { "mode": "report", "since": "2026-11-18", "baseline": { "MA0004": 14, "RCS1036": 3, "CA1822": 6 } },
  "audit": { "checks": { "duplication": false }, "ignore": { "rules": ["MA0004"], "paths": ["apps/web/src/generated/**"] }, "limit": 20 }
}
```

| Key | Type | Meaning |
|---|---|---|
| `coverage.api` | object, assembly name → rate | Line-coverage floor per .NET assembly on the merged unit, acceptance and integration report. An assembly with a floor and no data fails. At least one is required. |
| `coverage.reportOnly` | array of assembly names | Assemblies printed with their rate but not gated yet. Optional. |
| `coverage.web` | rate | Floor for the root line-rate of the vitest v8 Cobertura report. Required for `check-coverage.mjs --web`. |
| `mutation` | object, scope → rate | Covered-code mutation score floor per Stryker scope (`domain`, `web`, …). `check-mutation.mjs <scope>` fails for a scope with no floor. |
| `deadCode.mode` | `"report"` or `"ratchet"` | The web dead-code check (Knip). `report`, the default when the section is absent, never fails CI. `ratchet` fails a Knip issue type over its baseline and any unused or unlisted dependency. |
| `deadCode.since` | date, `YYYY-MM-DD` | The day the check was introduced. Written by the first `--write-baseline`; shown on the Project-Health card as "report-only since". |
| `deadCode.baseline` | object, Knip issue type → count | Findings allowed per type (`files`, `exports`, `types`, …). Required for `ratchet`. Dependency types are never baselined. |
| `bundle.mode` | `"report"` or `"ratchet"` | The web bundle-size check (size-limit). `report`, the default, never fails CI; `ratchet` fails a total over `limitBytes`. |
| `bundle.since` | date, `YYYY-MM-DD` | The day the check was introduced. |
| `bundle.baselineBytes` | whole number | The static export's JavaScript when the baseline was written, compressed as `.size-limit.json` says (brotli by default). |
| `bundle.limitBytes` | whole number | The budget: the baseline plus 10%, written with it. Required for `ratchet`. Only a person raises it. |
| `architecture.mode` | `"report"` or `"ratchet"` | The web architecture check (Steiger warnings). `report`, the default, never fails CI; `ratchet` fails a Steiger rule with more warnings than its baseline. Steiger errors are not this setting's: the boundary step fails on any, in either mode. |
| `architecture.since` | date, `YYYY-MM-DD` | The day the check was introduced. |
| `architecture.baseline` | object, Steiger rule → count | Warnings allowed per rule (`fsd/public-api`, `fsd/insignificant-slice`, …). Required for `ratchet`. Errors are never baselined. |
| `patterns.mode` | `"report"` or `"ratchet"` | The .NET code-patterns check (analyzer diagnostics from the build's SARIF). `report`, the default, never fails CI; `ratchet` fails a rule with more errors plus warnings than its baseline. |
| `patterns.since` | date, `YYYY-MM-DD` | The day the check was introduced. |
| `patterns.baseline` | object, rule id → count | Errors plus warnings allowed per rule (`MA0004`, `RCS1036`, `CA1822`, `CS8618`, …). Required for `ratchet`. Notes and findings suppressed in source are never counted. |
| `audit.checks` | object, check → `true` or `false` | Which worklist checks the weekly audit files stories for (`complexity`, `coverage`, `mutation`, `security`, `semgrep`, `deadCode`, `duplication`, `architecture`, `patterns`, `bundle`). All on by default; `false` switches one off. It changes nothing in CI. |
| `audit.ignore.rules` | array of strings | Rule ids the audit never files: an analyzer or Semgrep rule, a Knip issue type, a Steiger rule, an advisory id. For a known false positive, with the reason in the pull request. |
| `audit.ignore.paths` | array of globs | Repository-relative paths the audit never files or reads for its judgement pass (`*` within a folder, `**` across folders). |
| `audit.limit` | whole number, 1 to 200 | Items the worklist keeps per check (`engineering-excellence.mjs worklist --limit`). Default 20. |
| `audit.riskFiles` | whole number, 0 to 20 | Files in the judgement pass's risk map. Default 5; 0 switches the judgement pass off. |
| `audit.riskDays` | whole number, 1 to 365 | How recently a file must have changed to be in the risk map. Default 30. |
| `audit.graduateAfterDays` | whole number, 0 to 365 | How long a check stays in `report` mode before the audit opens the pull request that makes it a `ratchet` (see "Graduation" below). Default 14; 0 switches graduation off. |
| `audit.junk` | object, check → array of rule ids | What a graduating check's baseline must not freeze: the audit files one clean-up story for it first. Per check (`deadCode`, `architecture`, `patterns`, `bundle`), replacing that check's default; `[]` clears it. Default: `deadCode` the unused and unlisted dependency types (`dependencies`, `devDependencies`, `optionalPeerDependencies`, `unlisted`, `binaries`), which a ratchet holds at zero anyway; `patterns` `AD0001`, an analyzer that crashed. |
| `$schema` | string | Optional, ignored. |

A rate is a number from 0 to 1. Any other key, a percentage written as 94, or a string fails every gate with the list of problems, so a typo can never silently gate nothing. A `ratchet` without its baseline fails the same way.

### Report first, then ratchet

Every check added from 1.27.0 on starts report-only: it measures, prints the step summary and publishes its facet, and never fails CI. After two weeks the app moves it to `ratchet` in a reviewed change to `quality.config.json`; from 1.32.0 the weekly audit opens that pull request itself (see "Graduation" below), and a person still merges it: nothing flips a mode automatically. From then on existing debt (the baseline) never blocks a pull request, and only getting worse does.

| Check | Tool | CI step | Facet |
|---|---|---|---|
| Web dead code | [Knip](https://github.com/webpro-nl/knip) 6, `knip --workspace <web package> --reporter json` | `Dead code (Knip)` in the web job, after the build | `hygiene.deadCode.web` |
| Web bundle size | [size-limit](https://github.com/ai/size-limit) with `@size-limit/file`, `size-limit --json` | `Bundle size (size-limit)` in the web job, after the build | `bundle` (`engineering-excellence-bundle`) |
| Web architecture warnings | [Steiger](https://github.com/feature-sliced/steiger) 0.10+, `steiger ./src --reporter json` in `apps/web` | `Architecture warnings (Steiger)` in the web job, after the boundary check | `architecture.web` (`engineering-excellence-architecture`) |
| .NET code patterns | The compiler's SARIF error log (`-p:ErrorLog`), with the analyzers the app references ([Meziantou.Analyzer](https://github.com/meziantou/Meziantou.Analyzer), [Roslynator](https://github.com/dotnet/roslynator)) | `Code patterns (.NET analyzers)` in the engineering-excellence job | `patterns.dotnet` (`engineering-excellence-patterns`) |

Both tools are root devDependencies of the app, so they run from its lockfile with no extra token or service: `pnpm add -Dw knip@6.44.2 size-limit@14.3.0 @size-limit/file@14.3.0`. Knip 6.44.2 is the newest 6.x older than the family's seven-day `minimumReleaseAge`. Until they are installed, both steps skip with a notice. Record the first baselines with `--write-baseline` (see each script's header) in a pull request, and the `since` date with them. `--update-baseline` lowers a baseline after an improvement and never raises it; once a check is a ratchet, `--write-baseline` refuses to raise it too, so a higher baseline is always a person's edit with its reason in the pull request.

A Knip run that cannot load a config (exit code 2) and a size-limit path that matches nothing leave no report: report mode notes it, ratchet mode fails, because a gate that could not measure must not read as green.

### Architecture

The architecture facet (`engineering-excellence-architecture`, from 1.28.0) has two parts, each from a tool the app already runs:

- **Web, Steiger.** The `FSD boundary check (Steiger)` step still runs the app's `lint:fsd` and fails on any Steiger error, as before. A second pass writes `apps/web/steiger-report.json` (`--reporter json`, Steiger 0.10 or later) and the version; an older Steiger leaves no report and a notice. `check-architecture.mjs` holds the *warnings* per rule to `architecture.baseline`, report first, then ratchet, like the other checks. The facet's `web` block has `tool`, `version`, `errors`, `warnings`, `byRule` (errors and warnings per rule), `baseline` and `gate`.
- **.NET, architecture tests.** `ARCHITECTURE_TEST_PROJECT` now writes `TestResults/architecture.trx`, uploaded as `architecture-tests` pass or fail. A failing rule fails the api job, as before. The facet's `dotnet` block reads the TRX, not the library, so NetArchTest, ArchUnitNET and plain reflection tests read the same: `rules`, `passed`, `failed`, `skipped`, the `failing` rule names (`Class.Method`, at most 50), the test `project`, and `tool` (`netarchtest` or `archunitnet`, from the test project's `PackageReference`, null otherwise).

Either part may be null; with neither, the facet is not built. Steiger is already a devDependency of the web app, so there is nothing to install: update to 1.28.0, record the warning baseline from a CI run (download `web-quality`, then `node scripts/check-architecture.mjs --report steiger-report.json --write-baseline`) in a pull request, and switch `architecture.mode` to `ratchet` two weeks later.

### Code patterns

The patterns facet (`engineering-excellence-patterns`, from 1.29.0) has two parts:

- **.NET, analyzers.** The api job's build passes `"-p:ErrorLog=dotnet-analyzers.sarif%2Cversion%3D2.1"`, so every project writes its compiler diagnostics as SARIF 2.1 to `dotnet-analyzers.sarif` beside its `.csproj` (the `%2C` and `%3D` escapes keep MSBuild from reading the comma as a second property). The api job uploads them all, pass or fail, as the `dotnet-analyzers` artifact (`<API_WORKING_DIRECTORY>/**/dotnet-analyzers.sarif`). The analyzers are the app's own: package references to `Meziantou.Analyzer` and `Roslynator.Analyzers` (a `Directory.Build.props` or `Directory.Packages.props` entry with `PrivateAssets="all"`), with a curated subset of their rules at `warning` in `.editorconfig` and the rest left at their defaults or `none`. The template never sets a severity and never turns a warning into an error; an app that builds with `TreatWarningsAsErrors` keeps that choice, and its analyzer warnings would then fail its build, so keep the analyzers out of it (`WarningsNotAsErrors`) while they are report-only. `check-patterns.mjs --sarif ee/dotnet-analyzers` counts errors plus warnings per rule against `patterns.baseline`; notes and findings suppressed in source (`#pragma warning disable`, `[SuppressMessage]`) are listed, never gated. A project that targets several frameworks reports a finding once. The facet's `dotnet` block has `tool` (`roslyn`), `compiler`, `logs` (projects read), `errors`, `warnings`, `notes`, `suppressed`, `byAnalyzer` (from the rule prefix: `meziantou`, `roslynator`, `netanalyzers`, `codestyle`, `compiler`, `xunit`, `other`), `byRule`, `baseline` and `gate`. Test projects are part of the build, so their diagnostics count too.
- **Semgrep, the repository's own rules.** The blocking SAST scan already runs `--config .semgrep/` and fails on any finding. The facet's `semgrep` block records those rules' findings per rule from the scan's `semgrep.json` (the platform hygiene and mockup rules and any rule the app adds to `.semgrep/`): `version`, `rules` (how many `.semgrep/*.yml` defines), `errors`, `warnings`, `notes` and `byRule`, every rule listed, at zero too. It is never baselined, since the scan holds it at zero.

Either part may be null; with neither, the facet is not built. To adopt it: add the two analyzer packages and the `.editorconfig` severities in a pull request, update to 1.29.0, record the baseline from that pull request's CI run (download `dotnet-analyzers`, then `node scripts/check-patterns.mjs --sarif <dir> --write-baseline`), and switch `patterns.mode` to `ratchet` two weeks later.

### The audit worklist

The facets say how much is wrong; several hold counts only (dead code, patterns, architecture, Semgrep), and the files and lines sit in raw tool reports that are kept one to seven days. From 1.30.0 the engineering-excellence job also runs `engineering-excellence.mjs worklist` after the facets and uploads `ee/worklist.json` from main as `engineering-excellence-worklist`, for 90 days like the facets. It is what the weekly audit starts from instead of exploring the repository ([#582](https://github.com/PlainConceptsPlatform/agentic-workflows/issues/582)), from 1.31.0: see "The data-led audit" below. It is not a facet: Project-Health reads facets by name and never this artifact, and its contract is a file of its own, `scripts/engineering-excellence-worklist.schema.json`, with the facets' envelope and `facet: "worklist"`.

`data.checks` has every check, each `null` when it was not measured in that run:

| Check | Items | Read from |
|---|---|---|
| `complexity` | methods over the CRAP threshold | the complexity facet's `hotspots` (`ee/complexity.json`) |
| `coverage` | scopes and modules under their floor, the least covered files | the coverage facet, and the merged Cobertura (`api-coverage-merged`) and the web Cobertura (`web-coverage`); `--lcov` for a repository whose CI writes lcov |
| `mutation` | scopes and modules under their floor, the files with most surviving mutants | Stryker's reports (`--mutation-reports`), else the mutation facet; neither is in this job, so the check is null here |
| `security` | critical and high vulnerabilities with the fixed version, failed critical and high misconfigurations | `trivy.json` (`trivy-json`) |
| `semgrep` | findings per rule and file | `semgrep.json` (`semgrep-json`) |
| `deadCode` | unused files, exports and dependencies, unlisted dependencies | Knip's report (`web-quality`) |
| `duplication` | the largest clone pairs | this job's jscpd report |
| `architecture` | failing architecture tests, Steiger errors and warnings | the TRX (`architecture-tests`), Steiger's JSON (`web-quality`) |
| `patterns` | analyzer errors and warnings per rule and file | the SARIF logs (`dotnet-analyzers`) |
| `bundle` | the total over its budget, entries over a limit of their own | the bundle measurement and `size-limit.json` (`web-quality`) |

A check is `{ mode, total, truncated, sources, items }`, with `summary` (headline numbers) or `rules` where it has them. `items` holds at most `data.limit` (20; `audit.limit` in `quality.config.json` or `--limit` changes it, up to 200), worst first, each kind of item taking its turn; `total` is the count before the cap, so `truncated` shows what was cut. `rules` (dead code, architecture, patterns) is not capped: per Knip issue type, Steiger rule or analyzer rule, `{ count, baseline, over }`.

An item is `{ id, check, kind, rule, path, line, symbol, value, threshold, baseline, mode, message, detail? }`:

- `id` is the first 16 hex characters of the SHA-256 of check, rule, path and symbol. Line numbers and values are not in it, so a finding keeps its id while the code above it moves; several findings of one rule in one file are one item, with the lines in `detail.lines`.
- `path` is repository-relative with forward slashes; `line` is the first line, when the report gives one.
- `value` is the item's own measure (a CRAP score, a rate from 0 to 1, surviving mutants, a severity, findings of the rule at that path, duplicated lines, bytes); `threshold` is the fixed bar it is judged against (the CRAP maximum, the scope's floor, 0 where none is tolerated, the byte budget); `baseline` is the count the item's rule may have under its ratchet, to compare with `detail.ruleCount` (`detail.overBaseline` says whether the rule is over).
- `mode` is `ratchet` when CI enforces the item today and `report` when it only measures it: the `quality.config.json` section's mode for dead code, bundle, Steiger warnings and patterns; `ratchet` for complexity, duplication, Semgrep, Steiger errors, failing architecture tests, a floor that exists and a vulnerability with a fix; `report` for a file in a scope with no floor and a vulnerability with no fix, which the blocking scan ignores.

It never holds source code or secrets: Semgrep's matched lines, jscpd's clone text and Stryker's replacements are dropped, a message is the tool's own, on one line and at most 200 characters, and Trivy's secret findings are counted (`security.summary.secrets`) and never listed.

Every input is optional. A report that is not there leaves its check `null`; one that is there and cannot be parsed does too and is named in `data.unreadable` (`config` there means `quality.config.json` is not valid and the default modes were used). The step never fails the job: a worklist that cannot be built is a warning, and a repository that has not updated the `quality-gates` template skips it. A repository with its own CI runs the same command with whatever it has, for example `node scripts/engineering-excellence.mjs worklist --out ee/worklist.json --facets ee --lcov coverage/lcov.info --semgrep semgrep.json`, and uploads `ee/worklist.json` from main under the same artifact name.

### The data-led audit

From 1.31.0 the weekly audit (`agent-audit`) starts from this data instead of exploring the repository. Its `select` job runs `node scripts/audit-select.mjs` before the agent, with no model, and writes `audit-selection.json`: what this week's audit works on. The agent reads only the files the selection names. The rules are in `scripts/lib/audit-select.mjs`, with its `node:test` suite.

**Where the data comes from** (`source` in the selection):

| `source` | When | What the audit does |
|---|---|---|
| `worklist` | the default branch has an unexpired `engineering-excellence-worklist` artifact | the full selection, with files and lines |
| `facets` | no worklist, and at least one of the `engineering-excellence-` `complexity`, `coverage`, `mutation`, `security`, `hygiene`, `architecture` or `bundle` facets (a repository whose own CI has not adopted the worklist step) | a reduced selection: complexity hotspots, coverage and mutation scopes and modules under their floor, failing architecture tests and the bundle over its budget as the worklist would list them; vulnerabilities, Semgrep findings and dead code as counts with no file; the files with most duplicated lines when the duplication gate reports violations. The patterns facet is not read |
| `none` | neither, or the repository has no `scripts/audit-select.mjs` | today's exploratory audit, unchanged |

A repository that publishes some facets is audited on those. Mutation is read from the `engineering-excellence-mutation` facet in every case, because the worklist is built in a job that has no Stryker report: the audit sees mutation scopes and modules under their floor, never the files or the surviving mutants, until the mutation run publishes a worklist of its own.

**From items to units.** A story is about one problem, and several worklist items are often one: a unit is a file with its methods over the CRAP threshold, a coverage or mutation module with its files (a scope with modules under the floor is told through them), a package with its advisories, a Semgrep, Knip, analyzer or Steiger rule with the places it fires. A unit has a stable id (the same hash as an item's, over the unit's check, rule, path and symbol). For a rule held by a count baseline, the unit's value is the rule's count (`rules[rule].count`) and its target the baseline.

**Eligible** is a unit whose items are enforced today (item `mode` `ratchet`, whatever the check's own mode) and that is at least one of:

| Reason | Meaning |
|---|---|
| `vulnerability` | a critical or high vulnerability with a fixed version; always eligible |
| `failed-gate` | something where nothing is tolerated: a Semgrep finding, a Steiger error, a failing architecture test, an unused or unlisted dependency, a failed misconfiguration |
| `over-threshold` | past a fixed bar: CRAP over the maximum, a rate under its floor, the bundle over its budget, a clone over the minimum size |
| `over-baseline` | a rule with more findings than its ratchet's baseline |
| `regressed` | worse than in the last audit's selection (kept as the `audit-selection` artifact), or new when that audit saw the whole check. This is what makes a rule within its baseline eligible when its count grew |

**Not eligible**, and counted in `excluded`: items in `report` mode (`notEnforced`, per check, with the count and the change since the last audit); checks switched off in `audit.checks` (`disabled`); items on `audit.ignore` (`ignored`); units an open issue already tracks (`tracked`) or one closed as not planned in the last 180 days (`declined`), both matched by the hidden marker in the story's body and never by title; units within their bar that did not get worse (`withinBar`); and what ranked below the cap (`overCap`).

**Ranked** by a fixed score, highest first, ties by the check's order in the worklist and then the id:

```
score = 10 x severity + 10 x distance + 5 if regressed
```

`severity` is the check's weight: a critical vulnerability 10, a high one 9; a misconfiguration 9 or 8; a failing architecture test, a Steiger error or a Semgrep `ERROR` 8; complexity, coverage and a Semgrep `WARNING` 6; mutation, the bundle, a dependency Knip tolerates none of, and an analyzer error 5; a Steiger warning, an analyzer warning and a Semgrep `INFO` 4; other dead code 3; duplication 2. `distance` runs from 0 to 1: five times a threshold, ten findings where none is allowed, double a baseline, a hundred lines short of a coverage floor or twenty surviving mutants all count as 1. The first `AUDIT_MAX_STORIES` (the worker's `env`, 3) are `selected`.

**The marker.** Each selected unit carries `marker`, `<!-- audit-item: <id> value=<measured> target=<bar> check=<check> -->` (`check=` from 1.32.0), which the agent copies to the end of the story. The filing step lifts it out before it measures and trims the body and puts it back after, so a trimmed story keeps it; it also refuses to file a second story for an id an open issue already carries. Do not edit it: the next audit finds the story by the id, and the value is what was measured when it was filed.

**The judgement pass** is for what no tool measures (an N+1 query, a missing authorization check, a test that asserts nothing, a comment that contradicts the code). It runs every week on the `riskMap`: up to `audit.riskFiles` files that hold a method over the CRAP threshold, are not fully covered, and changed in the last `audit.riskDays` days (when the checkout has no history, the last condition is dropped). `risk = 100 x (0.4 x complexity + 0.4 x uncovered + 0.2 x churn)`. It may file as many stories as the selection left free (`judgement.slots`); with none free there is no risk map. The worker's `AUDIT_FOCUS` still says what to look for, within what a tool does not already count.

**The clean exit.** When `source` is not `none`, nothing is selected and the risk map is empty, `runAgent` is false: the agent job does not start, nothing is filed, and the run summary says the repository is clean. If `quality.config.json` is not valid (`trustworthy: false`: the worklist names `config` in `data.unreadable`, or the checkout's file does not parse), modes, floors and baselines were unknown: what is enforced regardless is still selected and the report says so, and an empty selection is reported as untrustworthy, not as clean.

The selection, shortened:

```json
{
  "schemaVersion": 1, "kind": "audit-selection", "source": "worklist", "trustworthy": true, "problems": [],
  "maxStories": 3, "clean": false, "runAgent": true,
  "selected": [
    { "id": "5f0c9a1b2c3d4e5f", "check": "complexity", "kind": "file", "rule": "crap", "path": "apps/api/Orders/Pricing.cs",
      "value": 186, "target": 30, "metric": "crap", "reasons": ["over-threshold"], "score": 70,
      "files": [{ "path": "apps/api/Orders/Pricing.cs", "line": 10, "symbol": "Pricing.Quote", "value": 186 }],
      "marker": "<!-- audit-item: 5f0c9a1b2c3d4e5f value=186 target=30 check=complexity -->" }
  ],
  "judgement": { "slots": 2, "days": 30, "history": true },
  "riskMap": [{ "path": "apps/api/Billing/Invoice.cs", "crap": 62, "coverage": 0.2, "commits": 3, "score": 61, "methods": [{ "symbol": "Invoice.Total", "line": 10, "crap": 62, "cc": 18 }] }],
  "excluded": {
    "notEnforced": { "deadCode": { "mode": "report", "count": 12, "previous": 10, "change": 2, "rules": { "exports": 9 } } },
    "disabled": [], "ignored": { "count": 0, "items": [] }, "tracked": [{ "id": "…", "check": "security", "issue": 31 }],
    "declined": [], "withinBar": 4, "folded": 2, "overCap": { "count": 1, "items": [{ "id": "…", "check": "patterns", "score": 50 }] }
  },
  "notMeasured": ["bundle"],
  "checks": { "complexity": { "truncated": false, "units": { "5f0c9a1b2c3d4e5f": 186 } } }
}
```

`checks` is the snapshot the next audit compares against. A tool's message never enters the selection: Semgrep's and an analyzer's can echo the code they matched, and a story is public text, so a unit carries the rule, the path and the line (a vulnerability keeps its advisory id and versions).

The job needs `actions: read`, `issues: read` and `pull-requests: read` on the run's own token and nothing else; it writes nothing to GitHub. Any read that fails is listed in `problems` and the selection is built from the rest; a script that is missing or crashes gives `source: none`, so a selection that cannot be computed is never a reason to skip the audit. To see what a run would select, without the network: `node scripts/audit-select.mjs --offline --out selection.json --worklist ee/worklist.json`.

### Closing the loop

From 1.32.0 every data-led run also checks the stories earlier audits filed against what CI measures now, and carries the verdict out with no model. `select` decides; the audit's `follow_up` job (the `audit-follow-up` action, with the App token) acts. It runs after the agent, whether the agent ran, was skipped by the clean exit, or failed, and only when there is something to do.

A story is matched to its unit by the id in its marker: the selection re-derives every unit from the newest worklist (the same grouping as above, plus a rule-level unit from `rules` where the worklist listed no item for a rule), never from a raw item id. A unit is **within its bar** when it is measured and not over its threshold or baseline, and **gone** when its check (from the marker's `check=`, or the last selection's snapshot) is measured, enforced and not truncated, and the unit is not in it. A truncated check cannot say a unit is gone.

| The story | CI now | What happens |
|---|---|---|
| open, a pull request that closes it merged before the measured commit | within its bar or gone | closed as completed, with a comment giving the number when filed, the number now and the target |
| open | anything else | left open, and it **keeps its story slot**: `storySlots = AUDIT_MAX_STORIES - open audit stories`, so the audit files fewer new stories while old ones are unfinished. With every slot held nothing is selected and the agent does not start; the summary says so, and this is not reported as clean |
| closed as completed in the last 30 days, before the measured commit | within its bar or gone | confirmed once with the same numbers |
| closed as completed in the last 30 days, before the measured commit | still over its bar | **reopened** with the numbers (unless another open story already tracks the unit), and the unit is not filed again as a new story. A story is reopened once: closed again, it is the team's answer, and the unit is treated like one closed as not planned while it is in reach |
| closed after the measured commit | | waits for the next worklist; the unit is not filed again meanwhile |
| closed as not planned | | the team's answer, as before |

"The measured commit" is the worklist's `commitSha`, dated from the checkout's history (the worklist's own time when the history does not have it): a change merged after that commit is not in the numbers, however late the run finished. A coverage or mutation scope or file folded into a module is still measured on its own number. A story closed as a duplicate is not followed. Nothing is decided when the selection is read from the facets or when `quality.config.json` is not valid: stories are only tracked, and still hold their slots. The pull requests are read with GraphQL (`closedByPullRequestsReferences`), which is why `select` needs `pull-requests: read`. Each follow-up comment ends with `<!-- audit-follow-up: <close|verify|reopen> id=<id> check=<check> before=<b> after=<a|gone> target=<t> metric=<m> -->`: a re-run posts nothing twice, and a story already reopened once is left closed even if the last selection is lost.

**In the report.** `file-audit-issues` appends a "Since last audit" section from the selection (`sinceLastAudit.markdown`), not from the model: fixed, still open and regressed counts, then one line per story with its check, unit, title and the numbers. It carries no issue number, because `audit-close` reads every `#N` in a report as work the report waits on. **`audit-close`**, when it closes a report whose stories are all closed, lists each measured story's number when filed and the number after (from the follow-up comment), or says it has not been measured since.

In the selection: `storySlots`, `storiesHeld` (the open stories), `followUp` (`enabled`, `measuredAt`, `counts`, `rows`, `actions`, and `settled` and `reopened`, carried from run to run), `sinceLastAudit` and `graduation`.

### Graduation of report-only checks

A check in `report` mode (`deadCode`, `architecture`, `patterns`, `bundle`) for `audit.graduateAfterDays` days (14) gets **one pull request** from the audit that writes its baseline and switches it to `ratchet`. The age counts from the section's `since`; without one, from the day the audit first saw the check in report mode, which the selection records in `graduation.firstSeen` and carries forward (the pull request writes that date as `since`). Only a worklist selection with a valid `quality.config.json` graduates anything.

- **The baseline is CI's**, from the worklist of the default branch, never a local run: `rules` counts for dead code (dependency types left out, as `--write-baseline` does), Steiger warnings and analyzer rules; `summary.totalJsBytes` for the bundle, with `limitBytes` the baseline plus 10%. A check with nothing to baseline (architecture measured from .NET tests only) is `no-data`.
- **The pull request**: branch `audit/graduate-<check>`, one commit to `quality.config.json` that changes only that section (`mode`, the baseline, `since`), title `Quality gates: enforce <check> as a ratchet`, and a body with the age, the baseline table, the worklist's date, commit and run, and the marker `<!-- audit-graduation: <check> -->`. It is opened with the App token, so CI runs on it.
- **Never merged automatically.** A ratchet can block merges, so a person decides. The pull request is opened as a **draft** and carries the merge train's hold label (`MERGE_TRAIN_HOLD_LABEL` as the repository's router names it, `hold` by default) and `quality-graduation`; the train takes neither a draft nor a held pull request, and nothing in the audit merges one. A person marks it ready, approves and merges it, or closes it. An open graduation pull request that lost its hold label gets it back on the next run.
- **A closed pull request is respected.** While one is open, or one from the branch was closed or merged in the last 90 days, no other is opened.
- **Junk first.** When the baseline would freeze something on `audit.junk` (by default unused or unlisted dependencies, and `AD0001`), the audit files one clean-up story (`bug`, `refine`, marker `<!-- audit-graduation: <check> cleanup -->`) with the counts and the places the worklist names, and holds the pull request. Once the worklist counts none of them, the story is closed if still open and the pull request opens. Closed as done with the junk still there, the story is reopened once; closed as not planned (remembered in `graduation.declined`), or closed again after that reopen, the baseline is written as CI measures it, except for unused or unlisted dependencies: a dead-code ratchet fails on any, so that check stays `blocked` until they are gone.

`graduation.checks.<check>.state` says where each stands: `waiting` (with `readyOn`), `blocked`, `cleanup-filed`, `cleanup-open`, `cleanup-pending`, `cleanup-reopened`, `ready`, `no-data`, `off` or `enforced`.

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

The web job runs `Dead code (Knip)` and `Bundle size (size-limit)` after the build, and `Architecture warnings (Steiger)` after the boundary check, and uploads the reports as `web-quality`; the api job uploads the architecture tests' TRX as `architecture-tests` and the build's SARIF error logs as `dotnet-analyzers`. The engineering-excellence job folds Knip into the hygiene facet, builds the bundle, architecture and patterns facets from them, and runs `Code patterns (.NET analyzers)`. It then builds the audit worklist (`Build audit worklist`) from the facets and those reports plus Trivy's JSON (`trivy-json`, for which the job now also waits for `deps-and-iac-report`), and uploads it from main as `engineering-excellence-worklist`. Neither step needs an `env:` value: they read `WEB_PACKAGE`, the root `knip.json` and `.size-limit.json`, and `quality.config.json`.

The job names are the ones the apps' required checks and the merge train read (`Full CI`), and the last job, `dispatch-merge-gate`, hands a bot pull request's verdict to the router's merge train exactly as the apps' CI does. A deploy pipeline that calls the workflow with `uses:` must grant `actions: write`. The `Platform conformance` job runs the guard from [platform-contracts.md](platform-contracts.md) where the app declares a platform contract and passes everywhere else.

It stays a single-file template: once installed it is the app's, and `--force` replaces it with the package's, `env:` included.

### Required checks on the default branch

Without a required check, nothing stops a merge while a job is red: the merge train lands a pull request on the CI workflow's verdict, and a person can merge from the pull request page. `Full CI` needs every blocking job, the scans and the platform conformance check as well as the heavy jobs, so it is the one check to require. `loops/templates/rulesets/main-required-checks.json` is that ruleset: `Full CI` required on the default branch, repository admins able to bypass it, and nothing else (no merge queue, no required approval). Apply it once per repository:

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input node_modules/@plainconceptsplatform/workflows/loops/templates/rulesets/main-required-checks.json
```

`Full CI` is skipped on a tiered light run, and a skipped check counts as passed; the merge train still asks for the full run before it lands a pull request. `gh pr merge --auto` (the release pull request) now waits for `Full CI` instead of merging at once.

`Agentics checks` runs only when workflow files change, so no ruleset can require it: a required check that never reports blocks the pull request for good. Both merge points check it instead (`land-pull-request/side-checks.sh`, the workflows listed in `SIDE_CHECK_WORKFLOWS`, default `Agentics checks`): a pull request whose side workflow failed or is still running on its head is not landed, and the merge train holds it rather than dispatching a gate.

### Test timings

Every test step writes a `.trx` report, and the `Test timings` step adds where the time went to the job summary: per test project the wall time, the summed test time and how many tests ran at once on average, then the slowest classes with the time of their first test (a class fixture's setup is paid there) and the slowest tests. It never fails the job.

It runs no mutation testing. A pull request's per-change gate is the coverage floor; mutation testing is out of band, below.

## The weekly mutation run: quality-mutation

`.github/workflows/quality-mutation.yml`, the shape Atlas runs: a Saturday cron plus `workflow_dispatch` with a `scope` input, never `pull_request`. Stryker over a single changed React page took 15 minutes on a pull request (the dry run alone reruns the whole vitest suite) and then failed the run on Stryker's own `break` threshold, which is why `app-ci-dotnet-next` and `app-ci-node-monorepo` no longer carry `Mutation (.NET, diff)` or `Mutation (web, diff)`.

| Job | Does |
|---|---|
| `Plan scopes` | Resolves the dispatch `scope` (`all`, `web`, or one .NET scope) into the matrix |
| `Mutants (<scope>)` | One Stryker.NET job per `DOTNET_SCOPES` entry, run from the project's own directory with `stryker/<scope>.json`; warns when coverage analysis is no longer `perTest`; uploads the report and gates it with `check-mutation.mjs <scope>` |
| `Mutants (web)` | StrykerJS with `WEB_STRYKER_CONFIG`, gated with `check-mutation.mjs web` |
| `Engineering Excellence (mutation)` | Folds every report into the `engineering-excellence-mutation` facet, uploaded for a full run on main |

| `env:` | Use |
|---|---|
| `API_WORKING_DIRECTORY`, `DOTNET_SOLUTION` | Where the .NET solution lives and its name |
| `DOTNET_SCOPES` | Space-separated `scope=project-directory` pairs (`domain=src/Odyssey.Domain`); each needs `stryker/<scope>.json` under `API_WORKING_DIRECTORY` and a `mutation.<scope>` floor. Empty runs no .NET scope |
| `WEB_DIRECTORY`, `WEB_STRYKER_CONFIG` | The web workspace and its StrykerJS config, whose `jsonReporter.fileName` must be `reports/mutation/mutation-report.json`. Empty `WEB_DIRECTORY` runs no web scope |

Keep the Stryker configs the way Atlas does: `coverageAnalysis`/`coverage-analysis` set to `perTest`, `thresholds.break` null (StrykerJS) or 0 (Stryker.NET) so the covered-code floor in `quality.config.json` is the only gate, and the web `mutate` list limited to logic modules with a colocated test, with `ignoreStatic: true`. Install it with `workflows add --template quality-mutation`; it needs the `quality-gates` scripts. Like the CI template, it is the app's once installed.

## platform-template

The family's apps carry a [platform contract](platform-contracts.md) that Kitchen-Sink delivers: `source.url` is Kitchen-Sink, `owned` its platform paths, and `sync` the Copier answers file and `copier update`. Apps adopted before the contract existed have `.copier-answers.yml` and `.platform/manifest`, which are read as the same contract. The template sync, the conformance guard and the exceptions file are described in [platform-contracts.md](platform-contracts.md).

## Dependabot

The template bumps what it owns: the pnpm `platform` catalog in `pnpm-workspace.yaml` and the packages in `apps/api/Directory.Packages.Platform.props`. A Dependabot pull request for one of them edits an owned path outside a sync, so the conformance guard fails it, and the next sync would overwrite it anyway. Family apps ignore them, one entry per package in the catalog and the props file:

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
