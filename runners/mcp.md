# MCP persistence on ephemeral runners

Ephemeral one-VM-per-job runners keep nothing between runs, so the two stateful MCP servers
get their state elsewhere. Everything here degrades gracefully: with the org secrets absent
(a fork, a local checkout), both fall back to their local behaviour.

## AgentMemory — one shared server

`https://agentmemory-pro-01.azurewebsites.net` — an App Service (plan `agentmemory-plan-01`, B1,
always-on, ~$13/month, the platform's only fixed cost). The public `node:22-bookworm` image
runs `bash /home/start.sh` — [`agentmemory-start.sh`](agentmemory-start.sh), uploaded once to
the persistent `/home` via Kudu VFS. It installs the `iii` engine and
`@agentmemory/agentmemory@0.9.28` on first boot, self-repairs interrupted installs, and later
boots reuse everything; the store lives in `/home/data`. The command must stay quote-free:
App Service's container CMD parsing shreds nested quotes, silently killing the container in
under a second with no log line — that cost three attempts to see.

The `@agentmemory/mcp` shim inside every agent proxies to that server when `AGENTMEMORY_URL`
is set, authenticating with `AGENTMEMORY_SECRET` (org secret, mirrored in the app settings).
The compile wrapper injects both at workflow level, and the egress allowlist admits the host.
Projects are separated by agentmemory's own project scoping.

Why not the alternatives, all verified against the org policy:
- **ACI** is policy-denied outright.
- **Azure Functions** is the wrong shape: agentmemory is a stateful daemon with a WebSocket
  stream and a minutes-long cold boot; the consumption plan's cold start blows the MCP shim's
  120s timeout, and container Functions need this same App Service plan underneath anyway.
- **Container Apps** is allowed, but scale-to-zero has the same fatal cold start, and pinned
  to min-replica 1 it costs the same as B1 with three more resources to own.

Operations:

```bash
curl -s https://agentmemory-pro-01.azurewebsites.net/agentmemory/health   # expect 200
az webapp restart -g agentrunner-pro-rg-01 -n agentmemory-pro-01
# wipe memory entirely: delete /home/data via Kudu (Advanced Tools) and restart
```

To stop paying the $13: `az webapp delete` + `az appservice plan delete`, remove the
`AGENTMEMORY_*` injection from the compile wrapper, recompile. Agents then keep per-run
local memory only.

## CodeGraph — per-repository index on actions/cache

The index (`.codegraph/` in the checkout plus the `~/.codegraph` registry) is restored before
`codegraph init` and saved by the cache action's post step under an immutable key:

```
key:          codegraph-<repository_id>-<run_id>
restore-keys: codegraph-<repository_id>-
```

- **Isolation**: actions/cache is repository-scoped by design — one consumer can never read another's
  graph, no configuration needed.
- **Concurrency**: every run saves its own key; two parallel runs never write one database.
  The newest snapshot wins the next restore, and GitHub's 10 GB per-repo cache evicts old ones.
- **Reuse evidence**: in the agent job, the step "Restore the CodeGraph index" logs
  `Cache restored from key: codegraph-…` and `codegraph init` completes incrementally instead
  of indexing from scratch.

First write verified in a consumer's run on 2026-08-26.
