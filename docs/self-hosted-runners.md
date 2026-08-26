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

There is deliberately no visual evidence workflow. It was removed: the agent cannot capture
from inside the sandbox, and screenshots were never compared against a baseline, so they gated
nothing. `pc-ops-evidence` remains installed for running `/ops-evidence` locally.

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

A job suffix was added to this key for a while, when each runner ran as its own Linux user and
one user's staging directory could not be written by the next. It was reverted with the users:
awf mounts only the current job's directory into the container, so a path built in the
activation job could not be read by the agent. One user again means the run key is enough.

**models.json.** gh-aw's bundled action scripts default this to a hardcoded `/tmp/gh-aw`, which
the wrapper cannot reach because it only rewrites the compiled lock. The activation job
therefore wrote it outside the directory it uploads from, so `models.json` never reached the
activation artifact and the agent reported `unknown_model_ai_credits`. The wrapper now sets
`GH_AW_MODELS_JSON_PATH` at workflow level.

### Why the keys differ

The staging tree uses `github.run_id`; the OpenCode data directory uses `runner.name`. That is
deliberate.

A warm server should survive between jobs on the same runner, which is what makes it warm, so
it is keyed on the runner. Staging files must never outlive their run, so they are keyed on the
run.

There is also a hard constraint. **The `runner` context does not exist at workflow level.** A
path rewritten to `${{ runner.name }}` in a workflow-level `env:` makes the workflow fail to
start at all, with no jobs and no log, which is very hard to read. `github.run_id` is valid
everywhere. `github.job` also resolves per job there, which is worth knowing but is not used
for the staging key any more. Use `runner.*` only in step-level `run:` and `env:`, and
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

The schema has no option for container names, a prefix, or a project name, so the compiled
lock wraps the awf call in `flock /tmp/agentic-awf.lock` and one agent job runs at a time.
Every other job still uses all four runners.

Giving each runner its own user and rootless daemon was tried first and reverted: it isolated
the containers and broke every fixed-name path the runners share in `/tmp`. See
[`../vm/serialise-agents.md`](../vm/serialise-agents.md).

The lock name deliberately avoids the `/tmp/gh-aw` prefix. The staging rewrite keys anything
starting `/tmp/gh-aw` on run and job, which would give each job its own lock file and no mutual
exclusion at all.
