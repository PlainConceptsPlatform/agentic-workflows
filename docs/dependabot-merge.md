# Dependabot auto-merge

Dependabot opens the pull requests and CI judges them. Nobody should have to press the merge button in between. `merge-dependabot` does it: a deterministic step, with no model and no checkout of the pull request, that squash-merges the open Dependabot pull requests whose checks are all green.

## Where it runs

| Repository | How | Token |
|---|---|---|
| Runs the work router | A step of the router's `housekeeping` job, the `Agentics: Maintenance - 6h` run (`23 */6 * * *`). No cron or route of its own. It runs after the sweep, even when the sweep failed. | The Platform App token |
| No router (the pillar repositories) | The `dependabot-merge` bundle template: `.github/workflows/dependabot-merge.yml`, every six hours at minute 41 and on `workflow_dispatch`, calling the same action, which the template installs as `.github/actions/merge-dependabot/`. | The App token when `BOT_APP_ID` and `BOT_PRIVATE_KEY` exist, `GITHUB_TOKEN` otherwise |

Install the template with:

```bash
npx @plainconceptsplatform/workflows@latest add --template dependabot-merge
```

`workflows update` refreshes it where it is installed. In a repository that holds only bundle templates, `update` refreshes those and installs no router. In a repository that runs the router, the template is not needed and `add` warns that it would do the same work twice.

## What it merges

Open Dependabot pull requests are taken oldest first, at most 30 examined and 5 merged per run. Each one passes all of these or is left alone:

1. Dependabot opened it: the author is `dependabot[bot]` (`app/dependabot` on some endpoints).
2. Its branch is a `dependabot/` branch in this repository, not a fork.
3. Every commit on it is Dependabot's: authored by `dependabot[bot]`, committed by GitHub (`web-flow`) or Dependabot, and signature-verified. A commit pushed by anyone else, a forged author email included, keeps the pull request out. So do more than 250 commits, which the API cannot list.
4. It targets the default branch, is not a draft, and carries none of `do-not-merge`, `blocked`, `human-review` or the merge train's hold label (`hold`).
5. Its update is inside the scope (`DEPENDABOT_MERGE`, below). The bump is read from the title, the `Bumps`, `Updates` and `Updated` lines, and a grouped update's `Package | From | To` table; release notes inside `<details>` are ignored. A grouped update counts as its highest bump, and a version that cannot be read (a commit SHA, a requirement range) counts as above major.

Then, by the pull request's state:

| State | What happens |
|---|---|
| Behind its base or conflicting | One `@dependabot rebase` comment. The comment is its own marker: while one is newer than the head commit, it is not repeated. A rebase moves the head, so the next stale state asks again. |
| Mergeability not computed yet | Skipped until the next run. |
| A check failing, cancelled or timed out (the latest run of each name counts) | Left open, and listed in the job summary with the failing checks. |
| A check pending, or a required check that never reported | Skipped until the next run. |
| No checks at all | Merged when `DEPENDABOT_MERGE_WITHOUT_CHECKS` is `true` and the head commit is at least an hour old, so CI that has not registered yet is not mistaken for no CI. |
| Every check green | Squash-merged at the head commit it judged, and its branch deleted. Where a ruleset asks for an approval, the token approves first. Where the base branch has a merge queue, it is enqueued. |

A merge GitHub refuses (a missing approval, a workflow file `GITHUB_TOKEN` may not change) is reported in the summary and the run stays green; only an unexpected API failure turns it red. Every run writes a table of what it merged, skipped and why to the job summary.

## Configuration

| Value | Default | Means |
|---|---|---|
| `DEPENDABOT_MERGE` | `all` | `all`, `minor` (minor and patch), `patch`, or `off`. CI is the gate, so the default merges everything that passes it. |
| `DEPENDABOT_MERGE_WITHOUT_CHECKS` | `true` | `true` merges in a repository with no checks at all; `false` leaves those for a person. |

Both sit in the `env:` block of the router (kept by `workflows update`) or of `dependabot-merge.yml`. A repository variable `DEPENDABOT_MERGE` overrides the file without a commit.

## Turning it off

Any one of these:

```bash
gh variable set DEPENDABOT_MERGE --body off
```

- set `DEPENDABOT_MERGE: "off"` in the router's or the template's `env:` block;
- set the repository variable `AGENTIC_WORKFLOWS_DISABLED`, which stops every installed workflow;
- delete `.github/workflows/dependabot-merge.yml` (template only);
- label a single pull request `do-not-merge`.

## Security

- It never checks out, builds or runs the pull request's code. The template's checkout is the default branch, sparse, for the action alone. Everything else is REST and GraphQL calls.
- It merges only what Dependabot alone wrote, by the three checks above, and only on green checks.
- `verify-route-matrix.sh` asserts the router step uses the App token and reads both values from the `env:` block, that the action has no checkout and starts no process, that every commit must be verified, and that it squash-merges the head it judged.

## GITHUB_TOKEN

Without the App secrets the template runs on `GITHUB_TOKEN`, with `contents`, `pull-requests` and `issues` write. Three limits come with it:

- GitHub starts no workflow from a merge made with `GITHUB_TOKEN`: the default branch's push workflows (a deploy, a release) do not run for that merge, only for the next commit that is not one.
- It cannot merge a pull request that changes `.github/workflows/`, so Dependabot's GitHub Actions updates are reported as refused.
- Approving needs the repository setting that lets GitHub Actions approve pull requests. Without it, a ruleset that requires an approval holds the pull request, and the summary says so.

Dependabot may also ignore a `@dependabot rebase` comment from a bot. It still rebases a conflicting pull request on its own; a person can comment the same command.

## The CI templates

Dependabot's runs get a read-only token, so the `app-ci-*` templates' merge-train dispatch failed on every Dependabot pull request and held it red. The dispatch job now skips Dependabot's pull requests; a repository with an older copy of the template needs `workflows add --template <its CI template> --force`, or the same condition by hand.
