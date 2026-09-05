# The engine: OpenCode on an OpenAI-compatible gateway

Verified against gh-aw v0.83.4 by compiling and running against worker lockfiles.

Repositories run agentic workflows on an OpenAI-compatible model gateway. The wiring is spread
across three files and none of it is discoverable from the gh-aw docs.

---

## The contract

```yaml
engine:
  id: opencode
  version: "1.2.14"
  env:
    OPENAI_BASE_URL: ${{ vars.FORGE_API_URL }}

model: openai/glm-5-3
secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

max-turns: 300
max-turn-cache-misses: 3000
max-ai-credits: 5000

network:
  allowed:
    - defaults
    - <gateway-host>            # not in `defaults`; the firewall blocks it otherwise
    - dotnet                    # NuGet
    - node                      # npm, pnpm, yarn
```

All parts are load-bearing:

1. `id: opencode` with a pinned `version`. Experimental in gh-aw; the compiler says so on every
   compile. That warning is expected.
2. All three budgets. `max-turns` bounds tool loops. `max-turn-cache-misses: 3000` stops otherwise
   healthy runs failing at the compiler default of five consecutive misses, because Forge has no
   prompt cache so every turn is a miss. `max-ai-credits` gives multi-phase pipelines room.
3. `network.allowed` includes `forge.plainconcepts.com`. It is not in `defaults`, and the firewall
   blocking it presents as a model timeout, not a network error, which is expensive to diagnose.
4. Ecosystem identifiers, not hostnames. `dotnet` and `node` expand to every registry, CDN and OCSP
   endpoint. The compiler nags on every compile if you list hostnames.

---

## Where the model actually comes from

This is the part that confuses everyone, because the model is named in three places and only one of
them decides anything.

| Layer | Value | What it does |
|---|---|---|
| gh-aw `model:` | `openai/glm-5-3` | Satisfies the compiler's provider validation. Nothing else. |
| `opencode.ci.json` `model` | `forge/glm-5-3` | The model OpenCode actually loads |
| `opencode.ci.json` `provider.forge.api` | `{env:FORGE_API_URL}` | Where the request goes |
| `engine.args: ["--model", ...]` | discarded | The compiler drops it. See below |

The gh-aw provider segment must be one of `copilot`, `anthropic`, `openai`, `codex`. Naming our own
gateway is rejected at compile time:

```
unsupported provider "plainconcepts";
supported providers: copilot, anthropic, openai, codex
```

The segment only selects which client library gh-aw thinks it is configuring, so declaring the
OpenAI-compatible one is enough to get past validation. The real routing is done by
`opencode.ci.json`, whose `provider` block is not validated by gh-aw at all.

A repository needs a provider matching its gateway configuration and the CI merge step that
installs it. The merge fragment lives in the consumer repository, not in this package's source.

### `engine.args` is discarded, so do not reach for it

Adding `args: ["--model", "plainconcepts/glm-5-3"]` to be explicit is a reasonable instinct and it
does nothing. Verified on v0.83.4 by compiling two workers that differ only in that block: neither
lock file contains `--model` anywhere, and both set `OPENCODE_MODEL: awf-proxy/glm-5-3`.

So the model comes from `model:` plus `opencode.ci.json`, and the provider gh-aw hands the CLI is its
own. A worker carrying `engine.args` is dead configuration that reads like a control, which is worse
than absent. Delete it.

### The CI config merge

`opencode.jsonc` is a developer's local config and is not tracked, so it does not exist in a CI
checkout. Without a merge step the only config the agent gets is the one gh-aw generates, which
declares provider `awf-proxy` with a model that is not ours.

The merge belongs in `pre-agent-steps:`, not `steps:`. Verified ordering inside the agent job:

```
Checkout repository
steps:                                         <- too early
Checkout PR branch
Restore agent config folders from base branch  <- reverts opencode.jsonc
pre-agent-steps:                               <- correct window
Write OpenCode Config                          <- gh-aw merges its base on top
Execute OpenCode CLI
```

`steps:` runs before the base-branch restore, which lists `opencode.jsonc` in `GH_AW_AGENT_FILES`
and would undo the merge on any pull-request event.

Keep the fragment as pure JSON, not JSONC: `jq` cannot parse `//` comments, and a naive
comment-stripper corrupts the `http://` inside the provider's api URL.

gh-aw's own "Write OpenCode Config" step runs next and merges its base with `$existing * $base`. Base
wins on conflicting keys, but it defines neither `model` nor this provider, so both survive.

The shared file `loops/workflows/shared/opencode-ci.md` carries the `pre-agent-steps` merge logic.
Each worker imports it, but the worker owns the `engine`, `model`, and `secrets` blocks.

---

## The CI agent prompt

`opencode.ci.json` carries a `ci-workflow-agent` whose prompt sets three policies worth knowing
before you write a workflow prompt that contradicts them.

`gh` is intentionally unauthenticated. The agent must not use `gh` for GitHub reads or writes. Reads
come from files you precomputed to `/tmp/gh-aw/agent/` or from the GitHub MCP tools; writes go through
`safeoutputs`. A workflow prompt that says "run `gh issue view`" will burn turns and fail.

Stop after the last safe output. The agent is told a task is complete only once every required Safe
Outputs command succeeds, and to stop immediately afterwards without further tools or prose.

Output discipline. gh-aw runs `opencode run --print-logs --log-level ERROR`, which suppresses
opencode's own diagnostics but not the model's narration between tool calls. There is no flag for
that; the only knob is the system prompt:

```text
OUTPUT DISCIPLINE: Do not narrate. Do not explain what you are about to do before doing it.
Do not write prose between tool calls. Call tools silently. The only prose you produce is the
final result or a brief error explanation when something fails.
```

Place it at the end of the agent `prompt` string. It applies to every workflow using the shared CI
agent, so no per-workflow change is needed. Local interactive sessions do not want it: narration is
useful when a human is reading along.

### Unattended repository reads

An Actions agent cannot approve a runtime permission request, so make it explicit:

```json
{
  "permission": {
    "read": "allow",
    "external_directory": { "/tmp/**": "allow" }
  }
}
```

Diagnose `The user rejected permission to use this specific tool call` as a CI permission
configuration problem, not a model or Safe Outputs failure.

---

## The shared setup file

Every worker imports one shared markdown file (`loops/workflows/shared/platform-defaults.md`) that
prepares the runner. Three rules keep it from becoming the least reliable part of the fleet.

Pin every version. A run that installs a different toolchain than the last one is not reproducible,
and a failure caused by a floating dependency reads as a model failure. Put the pins in the shared
file's `env:` block, which does merge from an import:

```yaml
env:
  OPENSPEC_VERSION: "1.8.0"
  RTK_VERSION: "0.44.1"
  RTK_SHA256: "986f29704469b3d1051e2474105c6c75ab8b73651068dcd61612c1fb3938ad95"
```

Checksum anything you download. A tarball fetched from a release page and installed to
`/usr/local/bin` is the one binary in the fleet nothing else verifies:

```bash
curl -fsSL -o "$tarball" "https://github.com/.../v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz"
echo "${RTK_SHA256}  $tarball" | sha256sum --check --strict
```

Do not swallow failures. A chain of installs each ending in `|| echo "skipped"` produces a silently
degraded agent that then fails in a way that looks like bad judgement. Decide per tool: if it is
optional, mark it `continue-on-error: true` once and say so; if it is required, let it fail. In
particular `pnpm install --frozen-lockfile || pnpm install` hides lockfile drift, which is the one
failure you most want to see.

Take the package manager from the repository rather than installing a floating one:

```yaml
- run: |
    corepack enable
    corepack prepare --activate      # honours packageManager in package.json
```

Cache the stores. Every worker pays this setup cost on every run, and one `actions/cache` block in
the shared file covers all of them.

---

## Git identity inside the agent container

The framework sets up HTTP auth but not `user.name` or `user.email`, so any `git commit` inside the
agent fails:

```
fatal: unable to auto-detect email address (got 'runner@3360f280c5cf.(none)')
```

The guardrails forbid touching git config, so use environment variables, which git respects natively.
Every worker carries these in its top-level `env:` block:

```yaml
env:
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
```

---

## Bot pull requests

Two related traps when a worker opens pull requests as a bot.

CI stalls at `action_required`. GitHub may require manual approval before CI workflows start on a
bot's pull request. The run shows `status: completed`, `conclusion: action_required`, `jobs: []`.
The setting is Settings, Actions, General, Workflow permissions, "Allow GitHub Actions to create and
approve pull requests". It is UI-only and cannot be set or verified by API. Even with it enabled, the
first bot pull request for a workflow may still need one approval.

The router handles the rest with a `bot-approve` route on `pull_request_target`, guarded on
`github.actor` being a trusted bot, which approves pending runs through the API. It takes
`actions: write` and no checkout, which is what makes `pull_request_target` acceptable here: the
fork's code is never fetched.

`workflow_run` does not fire for approved runs or PR-triggered CI on feature branches. GitHub's
documented behaviour:

> `workflow_run` events are NOT triggered for workflow runs that were initially pending approval and
> then approved.

In practice, `workflow_run` also does not fire for `pull_request`-triggered CI completions on feature
branches. The trigger works for `push`-to-main CI runs, but bot PRs on `feature/*` branches whose CI
was triggered by `pull_request` never produce a `workflow_run` event.

So after a manual approval, or after a bot PR's CI fails on a feature branch, the merge-gate route
never hears about the CI result. The pull request sits open with no gate action.

Mitigation is twofold:
1. The repo setting that auto-approves CI runs (so `workflow_run` fires for the main-push case).
2. The `stale-recovery` action polls every 2h for bot PRs whose CI concluded failure, and dispatches
   the merge-gate via `workflow_dispatch` with `operation=merge-gate`. This is the same thing the
   `workflow_run` trigger would have done. It requires `actions: write` permission on the
   `stale-recovery` job. If a merge-gate run is already in progress for the same PR, the router's
   concurrency group skips the duplicate.

---

## The trap: `tools:` is ignored

```
Warning: 'tools' section ignored when using engine: opencode
  (OpenCode doesn't support MCP tool allow-listing)
```

The compiler prints that once and drops the entire `tools:` block. Verified by compiling a workflow
with `tools.cache-memory` configured and finding zero references in the resulting lock file.

| You wrote | What happens |
|---|---|
| `tools: bash: ["gh run view"]` | Dropped. The agent's shell is unrestricted |
| `tools: cache-memory:` | Dropped. No cache is created or restored |
| `tools: repo-memory:` | Dropped. No memory branch |
| `tools: github: toolsets: [issues]` | Dropped. The GitHub MCP server is mounted unrestricted |
| `mcp-servers:` | Dropped |

Three consequences:

Do not write a `tools:` block. Dead configuration that reads like a control is worse than none: the
next reader believes the workflow is constrained when it is not.

The constraints that remain are the ones that matter. `permissions: read-all` means the token cannot
write. `safe-outputs` with `allowed:` lists means writes are enumerated and validated.
`network.allowed` filters egress. Those are enforced outside the agent, so they hold regardless of
what the engine supports.

Persistence needs another mechanism. Store state where GitHub already stores it: a label, a comment,
an issue body. An explicit `actions/cache` step at rung 3 works for build caches, but GitHub is the
database for anything a human should be able to see.

---

## Budgets

| Field | Works under opencode | Notes |
|---|---|---|
| `timeout-minutes:` | yes | Job wall clock. An implement agent needs 60 to 120 |
| `max-turns:` | yes | Platform: `300`. The real guard against a confused agent looping |
| `max-turn-cache-misses:` | yes | Platform: `3000`. Forge has no cache, so every turn is a miss |
| `max-ai-credits:` | unreliable | Platform: `5000`. Only engages when traffic passes gh-aw's proxy accounting |
| `tools.timeout:` | no | Inside the dropped block |

---

## Cost telemetry

gh-aw's AI Credits system tracks usage automatically, visible in the Actions run summary and in the
`effective_tokens` job output. Do not report tokens in issue comments: it duplicates the run summary
and Forge routing often yields `not reported` anyway.

`gh aw audit <run-id>` gives duration, tokens, credits and turn count when the proxy observed the
traffic, and `gh aw logs --format markdown` gives a cross-run report with anomaly detection. The proxy
log at `sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl` may be absent entirely.

---

## Self-hosted runners

Platform workflows target `ubuntu-latest`. The fleet moved off `[self-hosted, linux, agents]` in
`0fc7b08`; the model comes from Forge either way, so the only thing the self-hosted runner provided
was a queue of one.

Never on a public repository. A fork pull request would execute arbitrary code on a machine holding
your credentials.

If a repository moves back, all three runner keys must be set together or the framework jobs go to a
GitHub-hosted `ubuntu-slim`:

```yaml
runs-on: [self-hosted, linux, agents]
runs-on-slim: [self-hosted, linux, agents]
safe-outputs:
  threat-detection:
    runs-on: [self-hosted, linux, agents]
```

A persistent machine breaks assumptions a hosted runner lets you make:

- A step that installs something may find it already there. `gh extension install github/gh-aw` exits
  non-zero with "there is already an installed extension". Fall back to `upgrade` and assert with
  `gh aw version`.
- The runner's user does not own `/usr/share`. `actions/setup-dotnet` installs there by default and
  fails. Set `DOTNET_INSTALL_DIR` to `${{ runner.tool_cache }}/dotnet`.
- The workspace persists between runs. A `.npmrc` written with a token stays. A build output
  directory from a previous run is still there, so a `[ -d dist ]` check can bundle stale artifacts.
  Clean what you create, and write transient state to `$RUNNER_TEMP`.

---

## Other engines

| Engine | `id` | Needs |
|---|---|---|
| GitHub Copilot (gh-aw default) | `copilot` | `copilot-requests: write` or `COPILOT_GITHUB_TOKEN` |
| Claude Code | `claude` | `ANTHROPIC_API_KEY` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |

`claude` and `copilot` both support `tools:` properly, so a repository that genuinely needs tool
allow-listing or `cache-memory` has a reason to pick one. That is a deliberate trade against Forge,
not a default: state it in the workflow's `description:` if you make it.
