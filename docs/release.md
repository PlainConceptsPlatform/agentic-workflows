# Releasing `@plainconceptsplatform/workflows` to npm

This repository publishes one public package: `@plainconceptsplatform/workflows` (the `cli/`
workspace). Releases run from the `release.yml` workflow (`.github/workflows/release.yml`),
dispatched manually. The branch you dispatch from selects the track:

| Dispatch from | Track | Version | npm dist-tag |
|---|---|---|---|
| `main` | stable | `cli/package.json` version | `latest` |
| `alpha` | prerelease | `<version>-alpha.<n>` | `alpha` |

## One-time setup: npm token

The workflow publishes with an npm access token (not OIDC). A team member with publish rights
to the `@plainconceptsplatform` scope performs this once:

1. Create a token on npmjs.com. Either:
   - a classic **Automation** token (`Access Tokens` → `Generate New Token` → `Classic Token`
     → `Automation`), or
   - a granular token with `Read and write` permission to packages in the
     `@plainconceptsplatform` scope.
2. Add it as a GitHub Actions secret named exactly `NPM_TOKEN`. Either:
   - repository `Settings` → `Secrets and variables` → `Actions` → `New repository secret`, or
   - environment secret: `Settings` → `Environments` → `npm-publish` → `Add secret`.
3. Create the `npm-publish` GitHub environment
   (`Settings` → `Environments` → `New environment`), if it does not already exist. Adding
   required reviewers there makes every publish a reviewed action.

The workflow reads the secret as `NODE_AUTH_TOKEN` in the publish steps. If `NPM_TOKEN` is
missing, the run fails before installing or publishing anything.

Never commit the token or print its value.

## Stable release

1. Bump `version` in **both** `package.json` and `cli/package.json` (they must match — CI
   enforces this) and merge to `main`.
2. Dispatch the workflow from `main`:
   ```bash
   gh workflow run release.yml --repo PlainConceptsPlatform/agentic-workflows --ref main
   ```
3. The run installs dependencies, runs the repository's pack gate (`pnpm run pack`: typecheck,
   build, tests, then packs the package), publishes to npm with the `latest` dist-tag, and
   verifies npm reports the new version as `latest`. It then tags `v<version>` and creates
   the GitHub Release with generated notes.

Reruns are safe: if the version is already on npm, the publish step skips and the run
succeeds; the tag and release steps likewise skip if they already exist (the workflow checks
the `v<version>` against the remote and GitHub before acting).

## Alpha release

Alpha versions are ephemeral prereleases of the current `cli/package.json` version; nothing is
committed to the repository.

1. Create or refresh the `alpha` branch from `main`:
   ```bash
   git checkout main && git pull
   git branch --force alpha main && git push --force-with-lease origin alpha
   ```
2. Dispatch the workflow from `alpha`:
   ```bash
   gh workflow run release.yml --repo PlainConceptsPlatform/agentic-workflows --ref alpha
   ```
3. The workflow derives the next free `<version>-alpha.<n>` by querying npm for already
   published alpha versions, rewrites `cli/package.json` **on the runner only**, runs the same
   verify/pack gates, publishes with the `alpha` dist-tag, and verifies npm reports the
   version under `alpha` (and that `latest` is untouched).

Only the `alpha` branch may publish alpha versions — the release branch guard rejects dispatch
from any other ref, and the alpha publish step never runs from `main`. The candidate number is
always one past the highest already-published alpha for that base version, so a published
version is never reused or overwritten; the workflow re-checks the candidate against npm
immediately before publishing and fails the run if it somehow already exists.

## Verifying a release

```bash
npm view @plainconceptsplatform/workflows dist-tags
npm view @plainconceptsplatform/workflows@<version>
```

After a stable release, `latest` points at the new version. After an alpha release, `alpha`
points at the new prerelease and `latest` is unchanged.
