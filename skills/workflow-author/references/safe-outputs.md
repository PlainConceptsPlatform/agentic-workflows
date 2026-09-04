# Safe outputs

Verified against gh-aw v0.83.4.

Safe outputs are rung 6: the normal path for every agent-directed write. The agent runs read-only
and emits structured requests; a separate job validates and applies them.

That separation is not ceremony. It gives an audit trail, bounds the damage when the agent is wrong,
sanitises anything the agent echoes from untrusted input, and means a prompt injection cannot reach
further than the types you declared.

The rule: `permissions: read-all`, and every final agent decision writes through `safe-outputs`.
Granting the agent `issues: write` so it can run `gh issue edit` throws all of that away. A
deterministic custom job may make a minimal idempotent pre-agent lifecycle reservation such as adding
`bot-working`; it must not make judgement-based writes.

---

## Two write paths, and how to choose

The framework can apply the items for you, or it can stage them and let the workflow apply them
itself. The choice is about attribution and signing, not about safety: both paths run after the agent,
in a separate job, against a validated payload.

### Path A: the framework writes

```yaml
safe-outputs:
  create-pull-request:
    draft: false
```

Use this when the framework does something you cannot reproduce. The only real case is
`create-pull-request`: the agent commits to a branch in its workspace, the framework packages those
commits as a git bundle, and a separate job applies and pushes it through GraphQL, so the commits are
signed and satisfy a signed-commit ruleset. Hand-rolling that gets you unsigned commits and a blocked
merge.

Writes on this path are attributed to `github-actions[bot]`.

### Path B: staged, applied by the workflow

```yaml
safe-outputs:
  staged: true
  add-comment:
  add-labels:
  remove-labels:
```

`staged: true` runs everything, validates everything, and writes nothing. The worker's own `conclude`
job then applies the items with a GitHub App installation token, so every comment and label change is
attributed to the Platform App rather than `github-actions[bot]`.

`agent-implement` uses path A, because it opens pull requests. The other workers use path B.

Path B costs you the write path: you own `apply-agent-output` and the actions under it. It buys
attribution, and it buys ordering, because the items are applied in one place in one sequence rather
than by five independent framework jobs.

### One entry point for path B

Do not let each worker assemble its own sequence of apply steps. That is how four workers end up
with four slightly different orderings and four copies of the same `if: item-count != '0'` guard.

```yaml
- name: Apply agent output
  id: agent-output
  uses: ./.github/actions/apply-agent-output
  with:
    token: ${{ steps.app-token.outputs.token }}
    artifact-name: ${{ needs.activation.outputs.artifact_prefix }}agent
    merge-pull-request: 'true'
    push-to-branch: 'true'
    close-issues: 'true'
```

The action downloads the artifact once and applies in a fixed order: merge, push, close, update,
create, then comments and labels. Comments and labels always run, because they no-op when the agent
emitted none. Everything else is opt-in per worker.

### The artifact name is prefixed, and getting it wrong is silent

`artifact-name` is the line to get right. gh-aw names the artifact `<prefix>agent`, where the prefix
comes from `compute_artifact_prefix.sh` reading `toJSON(inputs)`. An event-triggered workflow has no
inputs, so the prefix is empty and the artifact is plainly `agent`. A `workflow_call` worker always
has a non-empty prefix, so the bare name stops resolving the moment a workflow becomes a router
worker.

The conclude job therefore needs `activation` among its `needs`, because that is the job that
exposes `artifact_prefix`:

```yaml
conclude:
  needs: [activation, agent, safe_outputs]
```

The failure has no symptom. The download misses, the item count is zero, every apply step is skipped
by its `!= '0'` guard, and `conclude` goes green having written nothing.

So: do not put `continue-on-error: true` on that download. An artifact that does not contain
`agent_output.json` is an error, because a conclude job that applies nothing must not report success.
The `|| true` habit is what converts a one-line wiring bug into a week of runs that all look fine.

---

## The GitHub App token

When a lifecycle write must be attributed to the Platform App, mint an installation token in the job
and pass it only to the local composite action:

```yaml
- uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
  id: app-token
  with:
    client-id: ${{ secrets.BOT_APP_ID }}
    private-key: ${{ secrets.BOT_PRIVATE_KEY }}
```

Never expose it to the agent job. `BOT_APP_ID` and `BOT_PRIVATE_KEY` are the standard Platform secret
names.

### App-token writes fire workflow events

This is the fact that decides where you use it. `GITHUB_TOKEN` writes do not trigger workflows. App
installation token writes do.

So a `reserve` job that posts "work has started" with an App token creates an `issue_comment`
event, which routes back into the same worker unless the router guards on
`github.event.comment.user.type != 'Bot'`. Without that guard it is an infinite loop, and
`concurrency` does not save you: with `cancel-in-progress: false` the runs queue.

It is also why one human label produces three router runs: the label, the bot's `bot-working` label,
and the bot's start comment. The last two classify to `none` in about ten seconds, but they are
visible.

Split the token by intent:

| Write | Token | Why |
|---|---|---|
| `bot-working`, start and finish comments | `GITHUB_TOKEN` | Bookkeeping. Nothing keys off it, and no event is wanted |
| The label that hands work to the next route | App token | The handoff depends on the event firing |

A blanket switch to `GITHUB_TOKEN` silently breaks the handoff, and that failure looks like
"implement just stopped picking things up".

---

## The conclude/incomplete lifecycle

Every LifecycleOps worker has two terminal jobs:

```yaml
conclude:
  needs: [agent, safe_outputs]
  if: >
    needs.agent.result == 'success' &&
    needs.safe_outputs.result == 'success'
  runs-on: ubuntu-latest
  permissions:
    contents: read
    issues: write
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false
    - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
      id: app-token
      with:
        client-id: ${{ secrets.BOT_APP_ID }}
        private-key: ${{ secrets.BOT_PRIVATE_KEY }}
    - uses: ./.github/actions/apply-agent-output
      with:
        token: ${{ steps.app-token.outputs.token }}
        update-issues: 'true'
        fallback-issue-number: ${{ inputs.issue-number }}
    - uses: ./.github/actions/create-issue-comment
      with:
        token: ${{ steps.app-token.outputs.token }}
        issue-number: ${{ inputs.issue-number }}
        body: |
          ${{ env.MARKER }}
          ${{ env.FINISHED_COMMENT }}
          [View this workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})

incomplete:
  needs: [agent, safe_outputs]
  if: always() && needs.agent.result != 'success'
  runs-on: ubuntu-latest
  permissions:
    contents: read
    issues: write
  steps:
    # checkout, app-token, then: remove bot-working, add review, comment the retry notice
```

`conclude` fires when the agent produced output; `incomplete` releases the issue for retry. The
`always()` on `incomplete` is what makes it run when `agent` failed.

Note the checkout. Both jobs use local composite actions and cannot resolve them without one.

---

## Validate the outcome, then let the workflow own state

A Safe Outputs payload being syntactically valid does not make it a valid business outcome. Validate
the artifact after Safe Outputs and classify it deterministically, for example:

```text
nonblank update_issue body for source issue   -> complete
meaningful add_comment for source issue       -> questions
anything else                                 -> invalid
```

The classifier is a custom job whose output gates `conclude` and `incomplete`. A successful agent run
with an `invalid` outcome must go through incomplete handling, not write a partial result.

Do not require the model to emit label actions as proof of completion. Labels are deterministic state
transitions. Disable agent label Safe Outputs for that worker, apply its body or comment, then let
ordinary workflow steps transition labels from the classifier result:

```text
complete  -> add refined + implement; remove refine + bot-working + review
questions -> add review; remove bot-working
invalid   -> existing incomplete path
```

This keeps the agent responsible for judgement and prose, while the workflow owns state.

When the apply action deliberately supplies a fallback target, outcome validation must mirror that
contract. An `update_issue` item may omit its target only when the caller deterministically maps it to
the source issue. Accept the source target or the documented fallback, but reject an explicit target
for another issue. Do not make a valid agent result fail because the validator implements a narrower
contract than the writer.

---

## The full surface

Default `max` in brackets.

### Issues

| Key | Max | Writes |
|---|---|---|
| `create-issue` | 1 | A new issue |
| `update-issue` | 1 | Title, body or state |
| `close-issue` | 1 | Closes with a reason |
| `link-sub-issue` | 1 | Parent/child relationship (experimental) |
| `set-issue-type` / `set-issue-field` | 5 | Issue type, custom field |
| `assign-milestone` / `assign-to-user` / `unassign-from-user` / `assign-to-agent` | 1 | Assignment |

### Pull requests

| Key | Max | Writes |
|---|---|---|
| `create-pull-request` | 1 | A PR from the agent's commits, signed |
| `update-pull-request` | 1 | Title or body |
| `close-pull-request` | 10 | Closes without merging |
| `merge-pull-request` | 1 | Merges (experimental) |
| `push-to-pull-request-branch` | 1 | Commits onto an existing PR branch |
| `create-pull-request-review-comment` / `reply-to-pull-request-review-comment` | 10 | Review threads |
| `submit-pull-request-review` | 1 | A consolidated review |
| `resolve-pull-request-review-thread` | 10 | Resolves a thread |
| `add-reviewer` | 3 | Requests a reviewer |

### Comments and labels

| Key | Max | Writes |
|---|---|---|
| `add-comment` | 1 | Comment on an issue, PR or discussion |
| `hide-comment` | 5 | Collapses a comment |
| `add-labels` / `remove-labels` | 3 | Labels |

### Everything else

Discussions (`create-discussion`, `update-discussion`, `close-discussion`), projects, releases,
assets, `create-code-scanning-alert`, `autofix-code-scanning-alert`, `create-check-run`,
`dispatch-workflow`, `call-workflow`, `dispatch-repository`.

`noop`, `missing-tool` and `missing-data` are enabled automatically. `noop` is how a run records "I
looked and there was correctly nothing to do", which distinguishes a quiet run from a broken one.

---

## Configuring the ones we use

### `create-issue`

```yaml
safe-outputs:
  create-issue:
    max: 1
    deduplicate-by-title: 1       # true = exact, 0-100 = edit distance
```

`deduplicate-by-title` replaces "check for duplicates before proposing anything", a rung-1 control
instead of a rung-5 instruction.

`max` defaults to 1, and the agent silently fails to create anything beyond it. Set it to match what
the prompt asks for.

Labels on created issues are applied by the `conclude` job, not by the agent's `create_issue` call.
The agent creates the issue without labels; `apply-agent-output` exposes `first-issue-number` and the
worker labels it deterministically.

The audit workflow uses score-then-select in a single issue: find 5 to 7 problems, score each 1 to 10
on severity times likelihood times blast radius, then emit one `create_issue` containing every finding
ranked, with the top 3 refined into user stories in the body. One issue, `max: 1`, and the ranking is
visible to a human.

### `add-comment`

```yaml
safe-outputs:
  add-comment:
    target: "*"
```

`target: "triggering"` is the default and needs a triggering issue or pull request. A `workflow_call`
worker has no triggering item, so use `"*"` and let the prompt name the number.

### `add-labels` / `remove-labels`

```yaml
safe-outputs:
  add-labels:
    allowed: [bot-working, review]
  remove-labels:
    allowed: [implement, bot-working, review]
```

`allowed:` is the real control, and it is why this beats granting `issues: write`: the workflow can
touch exactly those labels and no others, whatever the prompt is persuaded to attempt. Globs work, and
`blocked:` is evaluated first.

`review` must be in both lists on any worker that can stop for human input. Missing from
`remove-labels.allowed`, the bot silently fails to clear it and the issue looks like it still needs a
human when it does not.

The emitted item schema is exact:

```json
{"type":"add_labels","item_number":123,"labels":["review"]}
{"type":"remove_labels","item_number":123,"labels":["bot-working"]}
```

Do not invent `label_names` or `issue_number`. State this in the prompt whenever labels are allowed;
a wrong schema wastes a whole model run.

### `push-to-pull-request-branch`

```yaml
safe-outputs:
  push-to-pull-request-branch:
    target: "*"
    required-labels: [bot-working]

checkout:
  fetch: ["*"]
  fetch-depth: 0
```

`target: "*"` requires the wildcard fetch. Without it the branch is not in the shallow clone and the
push fails at the end of an otherwise successful run.

The `direct` worker uses `target: "*"` to push directly to `main` for trivial changes (typo fixes,
formatting, mechanical replacements). This is a maintainer-only shortcut: the agent decides whether a
change is trivial enough to bypass review and push directly. When the worker combines
`push-to-pull-request-branch` with `create-pull-request` and `add-comment`, the agent chooses one
based on what it did: no code changed produces a comment, non-trivial code produces a PR, and trivial
code pushes to main.

### `merge-pull-request`

Experimental, and the compiler says so on every compile. Merging is the highest-consequence write
available, so the prompt should be explicit that administrator merges and bypassed checks are not
permitted: if the merge is refused, the refusal is the answer.

### `threat-detection`

Enabled by default whenever safe outputs exist. Platform `agent-*.md` workflows set
`threat-detection: false` in their own frontmatter to avoid an additional model call, and rely on the
narrow safe-output surface, read-only agent permissions, the network allowlist, and deterministic
preconditions instead. Do not hide that setting in a shared import: the workflow must make its own
security and cost trade-off visible.

If you do enable it, pin `runs-on`, or the job goes to a GitHub-hosted runner independently of
`runs-on-slim`.

---

## Complete final payloads

Safe Outputs are terminal, not a conversational transport. A refinement that needs to ask three
questions emits one `add_comment` containing the introduction and all three, not a progress comment
and later follow-ups. This minimises turns, prevents duplicate comments, and makes the output job
atomic from the reader's point of view.

---

## Things that are not safe outputs

Some writes have no safe-output type and no API. Know them before you write a prompt that assumes
one.

A closing reference can only be created from the pull request body. There is no REST or GraphQL
mutation for it. `linkPullRequestToIssue` is not in GitHub's public schema, so code calling it
always falls through to whatever the error branch does. If a pull request must close an issue, put
`Closes #N` in the body, either at creation or by editing it afterwards:

```bash
pr="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json closingIssuesReferences,body)"
[ "$(jq '.closingIssuesReferences | length' <<<"$pr")" -gt 0 ] && exit 0
printf '%s\n\nCloses #%s\n' "$(jq -r '.body // ""' <<<"$pr")" "$ISSUE_NUMBER" > /tmp/body.md
gh pr edit "$PR_NUMBER" --repo "$REPO" --body-file /tmp/body.md
```

---

## Writing prompts for safe outputs

Use the language of proposal:

> Propose a pull request against `main` with the verified changes.
> Propose closing the issue, removing `implement`, and commenting `Auto-merged.`

Not "create a PR" or "run `gh issue close`". The agent has no such command, and asking for one sends
it hunting for a tool it does not have, which burns turns and ends in `missing-tool`.

Three habits:

- Declare only what the workflow needs. Every extra type widens the blast radius.
- Say what not to write. The `allowed:` lists enforce it; the prompt stops the agent wasting turns
  trying.
- Make the no-op explicit. "If the audit found nothing actionable, say so and propose nothing."
  Without that, a model asked for four issues tends to find four issues.

---

## Custom safe outputs

`safe-outputs.jobs` turns an Actions job into a tool the agent can call, which is how a write gh-aw
has no type for stays deterministic and keeps secrets away from the model.

```yaml
safe-outputs:
  jobs:
    notify-teams:
      description: "Post a message to the team channel"
      runs-on: ubuntu-latest
      inputs:
        message:
          required: true
          type: string
      steps:
        - env:
            WEBHOOK: ${{ secrets.TEAMS_WEBHOOK }}
          run: |
            set -euo pipefail
            MSG=$(jq -r '.items[] | select(.type == "notify_teams") | .message' "$GH_AW_AGENT_OUTPUT")
            curl -sS -X POST "$WEBHOOK" -H 'Content-Type: application/json' \
              -d "$(jq -n --arg t "$MSG" '{text: $t}')"
```

Dashes normalise to underscores, so `notify-teams` is emitted as `notify_teams`. Input types are
`string`, `boolean`, `choice`. `$GH_AW_AGENT_OUTPUT` is the JSON file holding the items. Honour
`GH_AW_SAFE_OUTPUTS_STAGED` so staged mode stays honest. The generated job is gated on
`contains(needs.agent.outputs.output_types, 'notify_teams')`, so it only runs when the agent called
it.
