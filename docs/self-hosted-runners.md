# Self-hosted runners and the compiled lock files

The agent workflows target `runs-on: [self-hosted, linux, agents]`. gh-aw generates their
`.lock.yml` files assuming a host that runs one job at a time, which is not true once a runner
host has more than one runner. This describes the differences between what gh-aw generates and
what actually ships, and why each one exists.

For building the host itself, see [`../vm/README.md`](../vm/README.md).

## What targets the host

The eight `agent-*` workers, plus the three workflows that need a container runtime:
`app-ci.yml`, `app-infra.yml` and `visual-evidence.yml`. The runner user is in the `docker`
group, so those call `docker` and `docker compose` directly. No Docker-in-Docker is involved:
the job runs on the host, not inside a container, so it simply uses the daemon.

The router, the authorizer, the feature chain and the agentics checks stay on GitHub-hosted
runners on purpose. They finish in seconds, and keeping them off the host stops them queueing
behind a forty-minute agent job.

`runs-on: RunnerLandingZone` is a decommissioned label. No runner carries it, so anything still
targeting it queues forever without an error. The CI templates under `loops/templates/ci/` and
`loops/templates/release/` were moved off it.

## The lock files are post-processed

`gh aw compile` is never called directly. `loops/scripts/compile-agent-workflows.mjs` runs it
and then rewrites the generated `.lock.yml` files. Consumers get the wrapper through
`workflows update`, so the rewrites survive every recompile.

Never hand-edit a `.lock.yml`. The next compile discards it. If a lock needs to differ from
what gh-aw generates, the change belongs in the wrapper.

### Noise and cost reporting

| Rewrite | Reason |
|---|---|
| `--log-level DEBUG` becomes `ERROR` | debug logging buries the agent's own output |
| `GH_AW_INFO_MODEL` becomes `per-agent` | the platform routes per agent, so a single model name is wrong |
| `OPENCODE_MODEL` emptied, `GH_AW_INFO_MODEL_COSTS` emptied | prices come from the internal proxy, and stale figures are worse than none |

### Concurrency on one host

Four things collide when two agent jobs run on the same machine. Each was found by a failing
run, and none of them names its cause in the error.

**MCP gateway port.** Published on `127.0.0.1:8080`. The lock now reads
`${MCP_GATEWAY_PORT:-8080}`, so a runner sets its own in `.env` and a single-runner host needs
no configuration. Symptom when shared: `Port 8080 does not appear to be listening`.

**The gh-aw staging tree.** `/tmp/gh-aw` holds `prompt.txt`, `agent_output.json` and
`safeoutputs.jsonl`. The real work already happens in `${RUNNER_TEMP}/gh-aw`, which is
per-instance, but the staging copies were not. Now keyed on `github.run_id`. Symptom when
shared:

```
cat: /tmp/gh-aw/aw-prompts/prompt.txt: No such file or directory
Error: You must provide a message or a command
```

One job cleared the tree while another was reading its prompt, so OpenCode started with no
prompt at all. The silent version is worse: safe outputs create pull requests and close issues,
so a crossed `agent_output.json` attributes one run's work to another and nothing looks wrong.

**The OpenCode install.** `npm install -g opencode-ai@<version>` ran unconditionally on every
job, rewriting a binary another job was executing. Now it installs only when the pinned version
is missing, behind `flock`, so two jobs starting together cannot both write the global prefix.
Symptom when shared: `exit code 137` partway through the agent's work, with no OOM anywhere in
`dmesg`. It reads like a memory problem and is not one.

**The OpenCode warm server.** One server on port 4096 with one `XDG_DATA_HOME`. The port now
reads `${OPENCODE_PORT:-4096}` and the data directory is keyed on `runner.name`, so each runner
keeps its own server warm between its own jobs.

### Why the keys differ

The staging tree uses `github.run_id`; the OpenCode data directory uses `runner.name`. That is
deliberate.

A warm server should survive between jobs on the same runner, which is what makes it warm, so
it is keyed on the runner. Staging files must never outlive their run, so they are keyed on the
run.

There is also a hard constraint. **The `runner` context does not exist at workflow level.** A
path rewritten to `${{ runner.name }}` in a workflow-level `env:` makes the workflow fail to
start at all, with no jobs and no log, which is very hard to read. `github.run_id` is valid
everywhere. Use `runner.*` only in step-level `run:` and `env:`, and check where a value
actually lands before keying it on the runner.

## Rules for changing the wrapper

**Validate the compiled output, not the patch.** A rewrite that looks right can still produce
an invalid lock. After changing the wrapper, confirm the lock parses as YAML, every `run:`
block passes `bash -n`, and no `runner.*` reference landed at workflow or job level.

**Mind the enclosing scalar.** gh-aw emits most `run:` blocks as double-quoted YAML scalars. A
rewrite that inserts an unescaped `"` produces a lock that no longer parses. Prefer values that
need no quoting.

**Prefer an environment default to a hard-coded value.** `${VAR:-default}` keeps a
single-runner host working with no configuration while letting a multi-runner host override it.
That pattern is why instance 1 has an almost empty `.env`.

## Docker

A single rootful daemon is shared by all runners. awf names its network per run
(`awf-<timestamp>_awf-ext`), so networks and containers never collide, and the daemon needs no
isolation.

If separate daemons are ever needed, awf reads `DOCKER_HOST` from the environment
(`container.dockerHost` in its config schema, auto-detected when unset). A rootless daemon per
runner user works without touching any workflow.
