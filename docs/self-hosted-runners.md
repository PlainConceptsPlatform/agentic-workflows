# Runners and the compiled lock files

The agent workflows target `runs-on: agents-arc`: ephemeral VM Scale Set runners. A VM serves
one job at a time and takes consecutive jobs until the queue is empty, then deletes itself. For the platform itself (scale set, bootstrap, scaler, credentials, costs, the policy
findings that rule out AKS) see [`../runners/README.md`](../runners/README.md).

## The lock files are post-processed

`gh aw compile` is never called directly. `loops/scripts/compile-agent-workflows.mjs` runs it
and rewrites the generated `.lock.yml` files. Consumers get the wrapper through
`workflows update`, so the rewrites survive every recompile. Never hand-edit a `.lock.yml`.

Validate the compiled output, not the patch: every lock must parse as YAML, every `run:` block
must pass `bash -n`, no empty `${{ }}` anywhere, and the route matrix must pass in both
consumer repos. A wrapper rewrite that misses its anchor is silent, and one broken lock takes
the router down with zero-job runs that carry no annotation.

## What the wrapper rewrites, and which era each rewrite belongs to

| Rewrite | Why | On ephemeral VMs |
|---|---|---|
| `opencode-ai` pinned to 1.18.23 + explicit postinstall | gh-aw pins a Feb-2026 build at every release; `--ignore-scripts` blocks the postinstall that downloads the binary | required |
| `NPM_CONFIG_MIN_RELEASE_AGE` 3 to 1 | the 3-day cooldown rejects fresh releases with a misleading ETARGET | required |
| copilot-staging guard | gh-aw's arc-dind step assumes the Copilot engine and fails under `engine: opencode` | inert without the topology, kept for safety |
| `GH_AW_MODELS_JSON_PATH` at workflow level | the writer defaulted to a path outside the uploaded directory, so the artifact lost models.json | required |
| staging keyed on `github.run_id` | two jobs on one host crossed prompts and outputs | harmless with one job per VM |
| `flock /tmp/agentic-awf.lock` around awf | awf's fixed container names killed concurrent jobs on a shared daemon | uncontended no-op, kept |
| log level, model name, cost table | noise and wrong constants for per-agent routing | cosmetic |

`VERIFY_COMMANDS` is split per area (`_API` / `_WEB`) so a web-only change does not pay for a
cold .NET Release build; the route matrix asserts each variable is defined wherever printed.

## Tools on the runner

The VM image is built by [`cloud-init`](../runners/cloud-init.yaml): docker-ce with the
compose plugin, gh, git, jq, and the actions runner. Everything else the workflows need
arrives per run and user-space: setup-node and setup-dotnet into the tool cache, ripgrep and
rtk from release artifacts into `$HOME/.local/bin`, `dotnet tool` output onto PATH explicitly
(fresh VMs do not have `~/.dotnet/tools` on PATH), and OpenCode via npm into the tool-cache
prefix. Nothing requires root at job time, which also keeps the workflows valid for ARC
should the AKS path open up.

## CodeGraph

The index (`.codegraph/` in the checkout plus the `~/.codegraph` registry) rides
`actions/cache`, which is repository-scoped: consumer repositories cannot see each other's graphs.
Every run restores the newest snapshot via `restore-keys` and saves its own immutable key at
job end, so concurrent runs never write one database. Centralised AgentMemory is deferred:
ACI is policy-denied, and the URL of a dead server is worse than no URL, because the MCP shim
retries it on every call.
