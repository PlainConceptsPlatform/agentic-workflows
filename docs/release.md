# Releasing to npm

`@plainconceptsplatform/workflows` (the `cli/` workspace) is the only package this repository
publishes. Publishing is triggered by a GitHub Release: the
[`npm-publish.yml`](../.github/workflows/npm-publish.yml) workflow runs on every
`release: published` event, replays the same gates CI runs (typecheck, build, test, pack), and
then publishes to npm.

- **Stable release** a release tagged `v<version>` targeting `main` publishes with the
  `latest` dist-tag.
- **Alpha release** a prerelease tagged `v<version>-alpha.<n>` targeting the `alpha` branch
  publishes with the `alpha` dist-tag.

Pull requests can never publish: only a published GitHub Release starts the workflow, and the
workflow itself never creates tags or releases.

## One-time setup (maintainer)

The workflow authenticates with **npm Trusted Publishing** (GitHub OIDC): GitHub mints a
short-lived OIDC token, the npm CLI exchanges it for registry credentials, and no npm token
is stored anywhere. GitHub must therefore be registered as a Trusted Publisher on each package.

For `@plainconceptsplatform/workflows` the only package this repository publishes:

1. On npmjs.com, select the package **@plainconceptsplatform/workflows**.
2. Open **Settings**.
3. Select **Trusted Publisher**.
4. Choose **GitHub Actions**.
5. Set the organization to `PlainConceptsPlatform`.
6. Set the repository to `agentic-workflows`.
7. Set the workflow filename to `npm-publish.yml` exactly, including case.
8. Set the GitHub environment to `npm-publish`.
9. Enable **Allow npm publish**.

Repeat for every public package you intend to publish (this repository has just the one).
A Trusted Publisher connection **cannot be edited after creation** if any value is wrong,
delete the connection and recreate it with the correct values.

The workflow filename (`.github/workflows/npm-publish.yml`) and the environment name
(`npm-publish`) are fixed by the workflow, so they must match the Trusted Publisher exactly.
Because authentication is OIDC-based, the `npm-publish` environment holds no secrets. Optional
hardening on npmjs.com: package **Settings → Publishing access → "Require two-factor
authentication and disallow tokens"**.

## Starting a stable release

Preferred the release loop does the bumping, tagging, and release creation:

```bash
gh workflow run work-router.yml --repo PlainConceptsPlatform/agentic-workflows -f operation=release -f version-bump=auto
```

It opens a `chore(release): v<version>` pull request bumping `package.json` and
`cli/package.json`, with auto-merge. Once it merges, `release-tag.yml` tags `v<version>` and creates
the GitHub Release. Both are created with `GITHUB_TOKEN`, which starts no workflows, so that
release does not trigger `npm-publish.yml`: publish it by hand (below), or re-publish the release
from a maintainer account.

By hand:

1. Bump `version` in both `package.json` and `cli/package.json` (they must agree).
2. Merge to `main`.
3. Create a release tagged `v<version>` targeting `main` draft then publish, or
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
- `<n>` is the next unused alpha number the prerelease version is derived from the tag, and
  the workflow refuses to publish a prerelease version that already exists on npm.

The workflow checks that the release targets `alpha` (any other branch fails), rewrites the CLI
manifest version to the tag's `v<base>-alpha.<n>` for that run only (nothing is committed),
runs the pack gate, publishes with `--tag alpha`, and then verifies the dist-tag. Alpha
prereleases are never published to `latest`.

### Publishing an alpha from the Actions tab

For a manual alpha from any branch no release, no tag, no changeset bookkeeping:

1. Open **Actions → Npm Publish → Run workflow**.
2. Pick the branch to publish (defaults to `alpha`). The workflow checks out that branch's code.
3. Click **Run workflow**.

The workflow reads the branch's own `cli/package.json` version as the base, picks the next
unused `<n>` for that base from npm, stamps `<base>-alpha.<n>` into the manifest for the run
(nothing is committed, no tag or GitHub Release is created), runs the same pack gate, and
publishes with the `alpha` dist-tag. There is no changeset or version-bump requirement to
satisfy the number is chosen for you and never collides with an already-published version.

Two caveats:

- The **Run workflow** button only appears for workflows on the default branch, so this path
  is usable once this change is on `main`.
- The selected branch must contain the `npm-publish.yml` file itself (the workflow runs from
  the code on the selected branch), so rebase or merge `main` into feature branches before
  dispatching from them.

Running the workflow manually requires write access to the repository; pull requests still
cannot publish anything.

## Verifying a release

```bash
npm view @plainconceptsplatform/workflows dist-tags          # latest / alpha pointers
npm view @plainconceptsplatform/workflows@<version> version  # a specific version exists
```

The alpha publish step performs the same dist-tag check in CI and fails the run if
`dist-tags.alpha` does not point at the version it just published.

If the publish step fails with an authentication error `ENEEDAUTH`, `401`, or `404 Not
Found` on `PUT https://registry.npmjs.org/...` the OIDC exchange did not succeed. npm
hides scopes from unauthenticated clients, so an E404 on publish is usually a masked auth
failure. Check, in order:

1. The Trusted Publisher on npmjs.com matches this repository exactly: organization
   `PlainConceptsPlatform`, repository `agentic-workflows`, workflow filename `npm-publish.yml`
   (case-sensitive), environment `npm-publish`.
2. The workflow still has `id-token: write` in its `permissions` block.
3. The run is a normal stable, prerelease, or manual run of this workflow (pull requests can
   never authenticate).

If the Trusted Publisher itself is misconfigured, remember it cannot be edited delete and
recreate it with the values in the one-time setup above, then re-run the workflow.
