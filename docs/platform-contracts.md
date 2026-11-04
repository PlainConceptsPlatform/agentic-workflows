# Platform contracts

A repository that receives shared code from an upstream template (an app template, a starter, a platform layer) can say so in one file at its root, `.platform/contract.yml`. The file names the template, the paths the template owns, and how the repository pulls the template's next version. It is an open format: this package reads it, other tools may read the same file, and none of them is required to use it. Each tool has its own small reader and none depends on another.

This package uses the contract in the opt-in `platform-template` template:

```bash
npx @plainconceptsplatform/workflows add --template platform-template
```

It installs two files, both package-managed and refreshed by `workflows update` where installed:

| File | What it does |
|---|---|
| `.github/workflows/platform-template-sync.yml` | Weekly and on demand, runs the contract's update command and opens or updates one pull request with the result |
| `scripts/check-platform-conformance.mjs` | The CI guard: owned paths change only in a template sync or under an unexpired exception, and match the template at the recorded version |

The `app-ci-dotnet-next` CI template runs the guard in its `Platform conformance` job. Any other CI can run it the same way. A repository without a contract gets nothing from either file: the workflow ends, and the guard exits 0 without a word.

## The file

Example for a repository generated from Acme's app template with Copier:

```yaml
version: 1                        # required; a major this guard does not know is refused
source:                           # required
  name: Acme app template         # display name used in messages
  url: https://github.com/acme/app-template   # where the shared code lives
  changes: https://github.com/acme/app-template/issues/new   # optional; where to ask for a change (default: url)
owned:                            # required; gitwildmatch globs, repository-relative; a leading "/" anchors to the root
  - .platform/contract.yml
  - src/platform/**
reuse:                            # optional
  docs: [docs/platform/]          # paths an agent reads before building something new
  packages: ["@acme/ui"]          # packages whose exports must be reused instead of re-implemented
  names: [DataTable]              # optional extra names to treat as reusable
exceptions: .platform/exceptions.yml   # optional; default shown
sync:                             # optional
  marker: .copier-answers.yml     # a diff that changes this file is a template sync and may rewrite owned paths
  version:                        # where the template version applied to this repository is recorded
    file: .copier-answers.yml
    key: _commit                  # top-level YAML key; value is a tag or commit of source.url
  update: copier update --trust --defaults --conflict inline   # command that pulls the next template version
```

The template delivers the file, so the template owns it and lists it under `owned`. Copier is only the example: a repository kept with cookiecutter and cruft, a git subtree or a script records its own marker, version file and update command.

The reader takes the YAML a contract needs: nested mappings, block and flow lists of plain or quoted scalars, and comments. Anchors, multi-line strings and tabs are refused.

## What workflows does with each field

| Field | Used by | How |
|---|---|---|
| `version` | both | Must be `1`. Any other value fails with the file and the field in the error |
| `source.name` | both | Names the template in messages and in the sync pull request title. Defaults to the last segment of `source.url` |
| `source.url` | both | The guard fetches it with git for `--compare`. The workflow links a GitHub release of the new version from the pull request. A repository whose `origin` is `source.url` is the template itself: the guard passes it and the workflow does nothing |
| `source.changes` | guard | Where a failure tells the author to ask for the change. Defaults to `source.url` |
| `owned` | guard | The paths it protects. As in `.gitignore`, a pattern without an inner slash matches at any depth, `**` crosses directories, `!` negates, and the last matching pattern decides |
| `reuse` | none | Read by other tools, such as an agent harness that asks for reuse before new code. Workflows ignores it |
| `exceptions` | guard | The exceptions file, below |
| `sync.marker` | guard | A pull request that changes this file is a template sync, and may change owned paths |
| `sync.version` | both | The value under `key` in `file`. A pull request that moves it is a template sync too. The guard compares with `source.url` at this version, and the workflow titles its pull request with the new one |
| `sync.update` | workflow | The command the workflow runs, with `bash`, at the repository root |

An invalid contract (a missing or wrong field, an unsupported line) fails the guard and the workflow with one error naming the file and the field. It never passes silently.

### Without a contract

Before the contract existed, the guard and the workflow keyed on `.copier-answers.yml` and `.platform/manifest`. A repository that has both and no `contract.yml` is still read, as the contract:

```yaml
version: 1
source: { name: <last segment of _src_path>, url: <_src_path> }
owned: <the lines of .platform/manifest>
sync:
  marker: .copier-answers.yml
  version: { file: .copier-answers.yml, key: _commit }
  update: copier update --trust --defaults --conflict inline
```

When both exist, `contract.yml` wins. `.copier-answers.yml` alone, as any Copier template leaves behind, is not a contract.

## The template sync

`.github/workflows/platform-template-sync.yml` runs every Monday and on demand. It is plain YAML, no model:

1. `node scripts/check-platform-conformance.mjs --contract` reads the contract. It stops without one, in the template repository itself, or when the contract has no `sync.update`.
2. It mints the Platform App token from `BOT_APP_ID` / `BOT_PRIVATE_KEY`, which reads a private template and makes the push start CI. A push made with `GITHUB_TOKEN` starts no workflow.
3. When `sync.update` starts with `copier`, it installs copier 9.19.1 through `uvx`, `pipx` or a virtual environment from the runner's Python (3.10 or newer). Any other command is the repository's to provide on the runner, as a committed script or a tool the runner image carries.
4. It runs `sync.update`. No change means the repository is on the newest version, and the run ends.
5. Otherwise it commits to `platform/template-sync` and opens a pull request titled with the version `sync.version` now records, listing the changed files and the files with conflict markers. If a pull request from that branch is already open for the same version it is left alone, so resolutions pushed to it survive. A newer version replaces the branch and the pull request's title and text.

The pull request is a bot's, so `app-ci-dotnet-next` hands its verdict to the merge train like any other bot pull request, and a red one goes to the merge gate's repair.

## The conformance guard

```bash
node scripts/check-platform-conformance.mjs [--base <git ref>] [--compare]
node scripts/check-platform-conformance.mjs --contract
```

- Without a contract it exits 0 without a word.
- An owned file holding conflict markers fails.
- An expired exception fails, whether or not anything uses it.
- `--base`: an owned path changed since the merge base fails, unless the change is a template sync (it changes `sync.marker` or moves `sync.version`) or an unexpired exception covers the path.
- `--compare`: fetches `source.url` at the recorded version with git and compares, blob by blob, every file the template has under an owned path. A file that differs or is missing fails unless an unexpired exception covers it. Owned files the template does not have under the same path (a rendered template file, say) are counted, not compared. If git cannot read the template, the guard says so and runs the rest. To compare a private template in CI, give git read access to it in that job.
- `--contract`: prints the resolved contract as `key=value` lines for `$GITHUB_OUTPUT` (`contract`, `self`, `source_name`, `source_url`, `source_web`, `version`, `update`), or `contract=absent`.

The `Platform conformance` job runs it with `--compare`, and with `--base` on pull requests.

### Exceptions

The exceptions file belongs to the repository:

```yaml
exceptions:
  - path: "src/platform/theme.ts"
    reason: Our brand needs its own theme until the template takes a theme setting
    issue: https://github.com/acme/app-template/issues/42
    expires: 2026-12-31
```

Every entry needs all four keys. `path` is a glob over owned paths, and `expires` is a `YYYY-MM-DD` date that stays valid through that day.
