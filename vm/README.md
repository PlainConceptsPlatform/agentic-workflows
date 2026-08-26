# Agentic runner VM

How to build a self-hosted runner host for agentic workflows, and why it is built this way.

The agent workflows run on `runs-on: [self-hosted, linux, agents]`. GitHub-hosted runners are
not used for them: the agent needs a persistent warm OpenCode server, a large tool cache, and
minutes that a hosted runner would bill by the second.

Everything below was derived from a working host. Where a decision looks arbitrary, the
reasoning is recorded, because most of it was learned by watching a run fail.

## What exists today

| | |
|---|---|
| Cloud | Azure, subscription `Nonproduction - Operations` |
| Resource group | `AGENTRUNNER-PRO-RG-01` (northeurope) |
| VM | `agentrunner-pro-vm-01`, `Standard_D2ads_v5`, Ubuntu 24.04 LTS |
| Cost | about $123/month: $84 VM, $35 P15 256GB premium disk, $4 public IP |
| Runners | four, `/opt/actions-runner/{1,2,3,4}`, all as user `runner` |
| Runner group | `agentic`, visible to all org repositories |
| Labels | `agents` (plus the automatic `self-hosted,Linux,X64`) |

## What runs here

Everything that needs either an agent or a container:

| Workflow | Why here |
|---|---|
| the eight `agent-*` workers | warm OpenCode server, large tool cache, long runs |
| `app-ci.yml` | needs Docker for service containers |
| `app-infra.yml` | needs the Azure tooling and Docker |
| `visual-evidence.yml` | starts SQL Server with `docker compose` |

Deliberately **not** here: `work-router.yml`, `authorize-bot-work.yml`,
`agent-feature-chain.yml` and `agentics-checks.yml`. Those are seconds-long coordination jobs,
and running them on GitHub-hosted runners keeps them from queueing behind a forty-minute agent
job. That queueing was the original bottleneck, so moving them here would undo the benefit.

If you are wiring a repository up, look for `runs-on: RunnerLandingZone`. That label belongs to
a decommissioned host and no runner carries it, so any workflow still targeting it never starts
at all: it queues forever with no error to read.

## Docker

The runner user is in the `docker` group and talks to the host daemon directly, so workflows
can call `docker` and `docker compose` with no extra setup. `setup-vm.sh` installs the engine
and the compose plugin.

This is not Docker-in-Docker and does not need to be. DinD matters when a *container* has to
start containers; here the job runs on the host, so it just uses the daemon. It is simpler and
faster than nesting.

The agent sandbox is the one place where nesting would apply: awf can expose the Docker socket
inside the agent container through `container.enableDind`, which would let the model itself run
`docker`. That is off, and turning it on is a real security decision rather than a convenience,
because it hands the sandboxed agent control of the host daemon.

Watch disk when container work lands here. Images, build caches and four runners' worth of tool
caches accumulate on the OS disk, and nothing prunes them automatically.

## Non-negotiables

**The runner group must never allow public repositories.** A self-hosted runner executes
arbitrary code from any pull request that can reach it. The organisation has public
repositories, so `allows_public_repositories` stays `false`. Check it after any group edit:

```bash
gh api orgs/<org>/actions/runner-groups/<id> --jq '.allows_public_repositories'
```

**Size for RAM, not just cores.** Each concurrent agent job runs the firewall containers, an
OpenCode server and a full language toolchain. Two cores and 8GB handle roughly two concurrent
agent jobs. The creation-time SKU allow-list does not restrict resizing, so the VM can be
resized later without rebuilding.

**Swap is not optional.** The VM shipped without any. Without swap a memory spike is an
immediate kill rather than a slowdown, and the resulting SIGKILL looks exactly like a workflow
bug. `setup-vm.sh` adds 8GB.

## Building a new host

```bash
# 1. base host: packages, docker, swap, the runner user
sudo bash setup-vm.sh

# 2. runners: pass a registration token and how many you want
TOKEN=$(gh api -X POST orgs/<org>/actions/runners/registration-token --jq .token)
sudo bash install-runners.sh --org <org> --token "$TOKEN" --count 4 --group agentic --labels agents

# 3. give every runner after the first its own Docker daemon
sudo bash setup-rootless.sh --count 4
```

All three are idempotent: they skip what is already done, so re-run them to add runners.

Step 3 is not optional above one runner. Without it a second agent job recreates the first
job's awf containers and kills it.

## Why each runner needs its own environment

Four runners on one machine are not four independent machines. They share a filesystem, a
network namespace and a Docker daemon, and the agent workflow was written for a host running
one job at a time. Three things collide, and each one was found by a failed run.

| Resource | Collision | Isolation |
|---|---|---|
| **awf containers** | **fixed names `awf-agent`, `awf-squid`, `awf-api-proxy`; a second job recreates the first job's containers and kills it** | **one Docker daemon per runner** |
| MCP gateway port | published on `127.0.0.1:8080`, so the second job cannot bind | `MCP_GATEWAY_PORT` per runner |
| OpenCode server | one server on `4096` with one data directory | `OPENCODE_PORT` per runner, data directory keyed on runner name |
| gh-aw staging tree | `/tmp/gh-aw` holds `prompt.txt`, `agent_output.json`, `safeoutputs.jsonl` | keyed on `github.run_id` |
| OpenCode install | a global `npm install -g` rewrites the binary a running job is executing | installed only when the pinned version is missing, behind `flock` |

Only the first two are set on the host, in each instance's `.env`. See
[`runner.env.template`](runner.env.template). The other two are handled when the workflows are
compiled, described in [`../docs/self-hosted-runners.md`](../docs/self-hosted-runners.md).

The failure modes are worth recognising, because none of them names its cause:

- **`Port 8080 does not appear to be listening`** , two gateways, one port.
- **`cat: /tmp/gh-aw/aw-prompts/prompt.txt: No such file or directory`** followed by
  `Error: You must provide a message or a command` , one job cleared the staging tree while
  another was reading its prompt. OpenCode then starts with no prompt at all.
- **`exit code 137`** in the middle of the agent's work, with no OOM in `dmesg` , a global
  `npm install` replaced the binary the running job was executing. The other, and the one
  that matters, is a second job recreating the shared awf containers. It announces itself
  only as a compose warning that is easy to read past:

  ```
  a network with name awf-net exists but was not created for project "awf-1787774939451"
  Container awf-squid Recreate
  ```

The last one is the dangerous shape. A crossed `agent_output.json` would not crash: safe
outputs create pull requests and close issues, so one run's work can be attributed to another
and nothing looks wrong.

## One Docker daemon per runner

This is the piece that makes concurrency possible at all, and it is the easiest thing to get
wrong.

awf gives its containers fixed names: `awf-agent`, `awf-squid`, `awf-api-proxy`. Only the
compose project label varies per run. On a shared daemon a second agent job therefore recreates
the first job's containers and kills it, and the first job dies with exit 137 partway through
its work.

The network name looks per-run (`awf-<timestamp>_awf-ext`) and that is misleading. `awf-net`
itself is shared, and the container names are what collide. Do not conclude from the timestamped
network that runs are isolated, because they are not. That mistake cost an afternoon here.

The schema offers no option for container names, a name prefix, or a project name, so the names
cannot be changed. The supported lever is `container.dockerHost`, auto-detected from
`DOCKER_HOST`. Give each runner its own daemon and the identical names live in separate
namespaces.

| runner | user | daemon |
|---|---|---|
| 1 | `runner` | rootful, `/var/run/docker.sock` |
| 2 | `runner2` | `/run/user/1002/docker.sock` |
| 3 | `runner3` | `/run/user/1003/docker.sock` |
| 4 | `runner4` | `/run/user/1004/docker.sock` |

`setup-rootless.sh` builds these. To confirm the isolation is real rather than assumed, create a
container with the same name in two daemons at the same moment: on one daemon the second create
fails, which is the collision itself; across two daemons both succeed.

## Checks

```bash
# runners registered, online, correctly labelled
gh api orgs/<org>/actions/runners --jq '.runners[]|"\(.name) \(.status) [\([.labels[].name]|join(","))]"'

# per-runner environment on the host
for i in 1 2 3 4; do echo "$i: $(tr '\n' ' ' < /opt/actions-runner/$i/.env)"; done

# services
systemctl list-units --type=service --plain --no-legend | grep actions.runner
```

A runner that shows `offline` while its service is `running` is usually mid-shutdown; GitHub's
registry lags the host by a minute or so.

## Operational notes

- **Stopping a runner is graceful.** `systemctl stop` lets the current job finish rather than
  killing it, so draining a runner is safe mid-feature.
- **A cancelled run leaves labels behind.** The `incomplete` job releases `bot-working`, but a
  cancelled workflow never runs it. The issue then looks reserved forever and no retrigger
  fires. Clear it by hand before retriggering.
- **The tool cache is worth keeping.** It lives under the runner directory, so removing an
  instance discards its cache and the next job on a fresh instance is slower.
