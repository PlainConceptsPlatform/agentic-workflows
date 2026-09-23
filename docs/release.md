# Releasing to npm

`@plainconceptsplatform/workflows` (the `cli/` workspace) is the only package this repository
publishes. Publishing is triggered by a GitHub Release: the
[`npm-publish.yml`](../.github/workflows/npm-publish.yml) workflow runs on every
`release: published` event, replays the same gates CI runs (typecheck, build, test, pack), and
then publishes to npm.

- **Stable release** — a release tagged `v<version>` targeting `main` publishes with the
  `latest` dist-tag.
- **Alpha release** — a prerelease tagged `v<version>-alpha.<n>` targeting the `alpha` branch
  publishes with the `alpha` dist-tag.

Pull requests can never publish: only a published GitHub Release starts the workflow, and the
workflow itself never creates tags or releases.

## One-time setup (maintainer)

The workflow authenticates with an npm access token stored as a GitHub environment secret.

1. Create the token on npmjs.com: avatar → **Access Tokens** → **Generate New Token**. Either a
   granular token with read-and-write rights to `@plainconceptsplatform/workflows`, or a classic
   **Automation** token.
2. In this repository: **Settings → Environments → New environment**, named `npm-publish`.
3. In the `npm-publish` environment: **Add environment secret**, named `NPM_TOKEN`, with the
   token from step 1 as its value.

The workflow filename (`.github/workflows/npm-publish.yml`), the environment name
(`npm-publish`), and the secret name (`NPM_TOKEN`) are fixed by the workflow. This repository
authenticates with a token rather than npm Trusted Publishing (OIDC), by maintainer decision —
if you ever switch, remember a Trusted Publisher connection cannot be edited after creation;
it must be deleted and recreated.

## Starting a stable release

Preferred — the release loop does the bumping, tagging, and release creation:

```bash
gh workflow run work-router.yml --repo PlainConceptsPlatform/agentic-workflows -f operation=release -f version-bump=auto
```

It bumps `package.json` and `cli/package.json` to the new version, commits, tags `v<version>`,
and creates the GitHub Release; publishing that release triggers `npm-publish.yml`.

By hand:

1. Bump `version` in both `package.json` and `cli/package.json` (they must agree).
2. Merge to `main`.
3. Create a release tagged `v<version>` targeting `main` — draft then publish, or
   `gh release create "v<version>" --target main --title "v<version>" --notes "..."`.

The workflow checks out the tag, fails if the tag and `cli/package.json` disagree, runs the
pack gate, and publishes with `--tag latest`. If the version is already on npm (a rerun of a
published release), it skips publishing and succeeds.

## Starting an alpha release

Alpha releases come from the `alpha` branch. Create it once and keep it current with `main`:

```bash
git branch alpha main
git push origin alpha
```

Then publish an on-demand prerelease:

```bash
gh release create "v<base>-alpha.<n>" --target alpha --prerelease \
  --title "v<base>-alpha.<n>" --notes "What is being previewed."
```

- `<base>` is the version currently in `cli/package.json` (for example `0.28.11`).
- `<n>` is the next unused alpha number — the prerelease version is derived from the tag, and
  the workflow refuses to publish a prerelease version that already exists on npm.

The workflow checks that the release targets `alpha` (any other branch fails), rewrites the CLI
manifest version to the tag's `v<base>-alpha.<n>` for that run only (nothing is committed),
runs the pack gate, publishes with `--tag alpha`, and then verifies the dist-tag. Alpha
prereleases are never published to `latest`.

## Verifying a release

```bash
npm view @plainconceptsplatform/workflows dist-tags          # latest / alpha pointers
npm view @plainconceptsplatform/workflows@<version> version  # a specific version exists
```

The alpha publish step performs the same dist-tag check in CI and fails the run if
`dist-tags.alpha` does not point at the version it just published.
