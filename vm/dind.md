# One Docker daemon per runner, and why the lock is gone

Agent jobs used to run one at a time, behind `flock /tmp/agentic-awf.lock`. That is no longer
true. Each runner has its own Docker-in-Docker daemon, so the four of them run in parallel.

## The problem the lock was solving

awf names its containers `awf-agent`, `awf-squid`, `awf-api-proxy`, and gh-aw names the MCP
gateway `awmg-mcpg`. Only the compose project label varies per run. Two agent jobs on one daemon
recreate each other's containers, and the first dies with `exit 137` partway through its work.
The names cannot be configured: `awf --help` has no project name, prefix or container name
option, and neither does the config schema.

## Why a daemon per runner, and not a user per runner

A Linux user per runner was tried first and reverted. It isolated the containers correctly and
broke everything the runners share on the filesystem, because gh-aw and awf both write
fixed-name files into `/tmp` that one user then cannot overwrite. `vm/serialise-agents.md`
records those six failures.

A daemon per runner gets the same isolation with one user, so none of that returns.

## The topology

| runner | daemon | `DOCKER_HOST` |
|---|---|---|
| 1 | `dind-1` | `tcp://127.0.0.1:2381` |
| 2 | `dind-2` | `tcp://127.0.0.1:2382` |
| 3 | `dind-3` | `tcp://127.0.0.1:2383` |
| 4 | `dind-4` | `tcp://127.0.0.1:2384` |

Each is a privileged `docker:dind` container with the host paths mounted 1:1, so bind-mount
sources resolve identically inside the daemon:

```bash
docker run -d --privileged --name dind-N --restart unless-stopped \
  -p 127.0.0.1:238N:2375 -e DOCKER_TLS_CERTDIR= \
  -v dind-N-data:/var/lib/docker \
  -v /tmp:/tmp -v /opt/actions-runner:/opt/actions-runner \
  docker:dind --host=tcp://0.0.0.0:2375 --tls=false
```

gh-aw needs no flag from us. It detects a `tcp://` `DOCKER_HOST` and switches to its ARC/DinD
path by itself, passing `--docker-host` to awf and patching the chroot config.

## The rule that is easy to get wrong

**`DOCKER_HOST` must not go in the runner's `.env`.** Ports published inside a DinD daemon are
not reachable from the host. Verified: a container in `dind-2` publishing `15533` answers from
inside the daemon and gives `curl status: 000` from the host. A runner-wide `DOCKER_HOST` would
therefore break every CI job that reaches a service container on `localhost`, which is how
`app-ci.yml` talks to SQL Server.

Set it only in the two steps of the agent lock that need it, "Start MCP Gateway" and "Execute
OpenCode CLI", derived from `$RUNNER_NAME`. Everything else keeps using the host daemon.

## Verifying the isolation

Create the same container name in every daemon at the same moment. On one shared daemon the
second create fails, which is the collision. Across four daemons all four succeed:

```bash
for i in 1 2 3 4; do
  DOCKER_HOST=tcp://127.0.0.1:238$i docker run -d --name awf-agent --rm alpine sleep 25
done
```

## Still open

`/tmp/awf-cmd-1.sh` is a fixed host path that awf rewrites on every run, along with `/tmp/awf-lib`
and `/tmp/awf-init`. Whether two concurrent agent jobs collide on it has **not** been tested. If
they do, the failure will be intermittent and silent, one run executing another run's script,
which is worse than the loud failure the lock used to prevent. Test two concurrent runs before
trusting parallelism. The fix, if needed, is a per-runner `/tmp` mounted into each DinD.
