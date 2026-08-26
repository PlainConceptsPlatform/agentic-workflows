# Self-hosted runners and the compiled lock files

The agent workflows target `runs-on: [self-hosted, linux, agents]`. gh-aw generates their
`.lock.yml` files assuming a host that runs one job at a time, which is not true once a runner
host has more than one runner. This describes the differences between what gh-aw generates and
what actually ships, and why each one exists.

For building the host itself, see [`../vm/README.md`](../vm/README.md).

## What targets the host

The eight `agent-*` workers, plus the two workflows that need a container runtime:
`app-ci.yml` and `app-infra.yml`. The runner user is in the `docker`
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
per-instance, but the staging copies were not. Now keyed on `github.run_id` and
`github.job`. Symptom when
shared:

```
cat: /tmp/gh-aw/aw-prompts/prompt.txt: No such file or directory
Error: You must provide a message or a command
```

One job cleared the tree while another was reading its prompt, so OpenCode started with no
prompt at all. The silent version is worse: safe outputs create pull requests and close issues,
so a crossed `agent_output.json` attributes one run's work to another and nothing looks wrong.

The job id is in the key for a second reason, and it only appeared once the runners moved to a
user each. A run's jobs land on different runners, so they run as different users. Keyed on the
run alone, the first job creates the tree and the next job cannot write into it:

```
/tmp/gh-aw-<run_id>/agent_output.json: Permission denied
EACCES: permission denied, scandir '/tmp/gh-aw-<run_id>/aw-prompts'
```

Loosening the permissions would not have been enough, because the individual files are owned by
the job that wrote them too. Jobs hand data to each other through artifacts, so no job needs to
read another's staging path, and giving each its own removes the sharing rather than trying to
make it safe.

**The OpenCode install.** `npm install -g opencode-ai@<version>` ran unconditionally on every
job, rewriting a binary another job was executing. Now it installs only when the pinned version
is missing, behind `flock`, so two jobs starting together cannot both write the global prefix.
Symptom when shared: `exit code 137` partway through the agent's work, with no OOM anywhere in
`dmesg`. It reads like a memory problem and is not one.

**The OpenCode warm server.** One server on port 4096 with one `XDG_DATA_HOME`. The port now
reads `${OPENCODE_PORT:-4096}` and the data directory is keyed on `runner.name`, so each runner
keeps its own server warm between its own jobs.

### Why the keys differ

The staging tree uses `github.run_id` and `github.job`; the OpenCode data directory uses
`runner.name`. That is
deliberate.

A warm server should survive between jobs on the same runner, which is what makes it warm, so
it is keyed on the runner. Staging files must never outlive their run, so they are keyed on the
run.

There is also a hard constraint. **The `runner` context does not exist at workflow level.** A
path rewritten to `${{ runner.name }}` in a workflow-level `env:` makes the workflow fail to
start at all, with no jobs and no log, which is very hard to read. `github.run_id` is valid
everywhere, and `github.job` resolves per job there too, which is why the staging key can use
it and cannot use the runner name. Use `runner.*` only in step-level `run:` and `env:`, and
check where a value actually lands before keying it on the runner. Make that check a probe
rather than a reading of the documentation: a two-job workflow echoing the value costs a minute,
and it has already caught one wrong assumption here.

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

awf gives its containers fixed names: `awf-agent`, `awf-squid`, `awf-api-proxy`. Only the
compose project label varies per run, so two agent jobs on one daemon recreate each other's
containers and the first dies with exit 137 partway through its work.

The timestamped network name `awf-<timestamp>_awf-ext` suggests runs are isolated. They are
not: `awf-net` is shared and the container names are what collide. That misreading is worth
naming, because it is the reason this took an afternoon to find.

The schema has no option for container names, a prefix, or a project name. The supported lever
is `container.dockerHost`, auto-detected from `DOCKER_HOST`, so each runner beyond the first
runs as its own user with a rootless daemon. No workflow changes are needed: awf reads the
variable itself. See [`../vm/setup-rootless.sh`](../vm/setup-rootless.sh).
