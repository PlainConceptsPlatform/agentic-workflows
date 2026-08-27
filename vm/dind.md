# One Docker daemon per runner

Agent jobs used to run one at a time behind `flock /tmp/agentic-awf.lock`. Each runner now has
its own Docker-in-Docker daemon, so four of them run in parallel.

## The problem this solves

awf names its containers `awf-agent`, `awf-squid`, `awf-api-proxy`, and gh-aw names the MCP
gateway `awmg-mcpg`. Only the compose project label varies per run, so two agent jobs on one
daemon recreate each other's containers and the first dies with `exit 137` partway through its
work. The names cannot be configured: neither `awf --help` nor the config schema offers a
project name, prefix or container name.

A Linux user per runner was tried first and reverted. It isolated the containers and broke
everything the runners share on the filesystem, because gh-aw and awf both write fixed-name
files into `/tmp` that one user then cannot overwrite. `serialise-agents.md` records those six
failures. A daemon per runner gets the same isolation with one user, so none of that returns.

## The topology

| runner | daemon port | gateway port | `DOCKER_HOST` |
|---|---|---|---|
| 1 | 2381 | 8081 | `tcp://127.0.0.1:2381` |
| 2 | 2382 | 8082 | `tcp://127.0.0.1:2382` |
| 3 | 2383 | 8083 | `tcp://127.0.0.1:2383` |
| 4 | 2384 | 8084 | `tcp://127.0.0.1:2384` |

```bash
docker run -d --privileged --name dind-N --restart unless-stopped \
  -p 127.0.0.1:238N:2375 -p 127.0.0.1:808N:808N \
  -e DOCKER_TLS_CERTDIR= \
  -v dind-N-data:/var/lib/docker \
  -v /tmp:/tmp -v /opt/actions-runner:/opt/actions-runner \
  docker:dind --tls=false
```

Host paths are mounted 1:1 so bind-mount sources resolve identically inside the daemon. gh-aw
needs no flag from us: it detects a `tcp://` `DOCKER_HOST` and takes its ARC/DinD path, passing
`--docker-host` to awf and patching the chroot config.

## The gateway has to be reachable from the runner, and that takes three things

gh-aw starts the MCP gateway with `docker run` and then health-checks it over HTTP **from the
runner**, not from inside the daemon. Get any of these wrong and the job dies before the agent
starts, after retrying 120 times:

```
Health endpoint: http://localhost:8080/health
MCP gateway health check failed (attempt 1/120): connect ECONNREFUSED 127.0.0.1:8080
...
ERROR: Gateway failed to become ready
```

**1. The DinD container must publish the gateway port.** `-p 127.0.0.1:808N:808N` above. Without
it the port exists only inside the daemon.

**2. The gateway must bind `0.0.0.0` inside the daemon.** gh-aw generates
`-p 127.0.0.1:$MCP_GATEWAY_PORT:$MCP_GATEWAY_PORT`, and that `127.0.0.1` is the DinD container's
own loopback, while the outer publish forwards to its eth0. The two never meet. The compile
wrapper strips the inner `127.0.0.1:`. Measured on the host with an identical container:

| inner bind | curl from the runner | host exposure |
|---|---|---|
| `127.0.0.1` | `000` | — |
| `0.0.0.0` | `200` | still `127.0.0.1:<port>` only |

Nothing extra is exposed, because the outer publish is loopback-only.

**3. Each runner needs its own gateway port.** Four daemons publish through to one host
loopback, so two jobs on 8080 collide. Set `MCP_GATEWAY_PORT` in each runner's `.env`; the
wrapper makes the lock honour it via `${MCP_GATEWAY_PORT:-8080}`.

## Two things that look like fixes and are not

**`--network host` on the DinD containers.** It does make published ports reachable and it does
keep container names isolated, both verified. It then fails because `docker:dind` also binds
2375 by default, so only the first of four daemons starts:

```
failed to load listeners: listen tcp 0.0.0.0:2375: bind: address already in use
```

**Putting `DOCKER_HOST` in the runner's `.env`.** It looks tidier than setting it in two workflow
steps. It breaks every CI job that reaches a service container on `localhost`, because those
ports would then be published inside the daemon. `app-ci.yml` talks to SQL Server that way. Set
it only in "Start MCP Gateway" and "Execute OpenCode CLI", derived from `$RUNNER_NAME`.

## Verifying

```bash
# container names isolated: all four must succeed
for i in 1 2 3 4; do
  DOCKER_HOST=tcp://127.0.0.1:238$i docker run -d --name awf-agent --rm alpine sleep 25
done
for i in 1 2 3 4; do DOCKER_HOST=tcp://127.0.0.1:238$i docker rm -f awf-agent; done

# gateway port reaches the runner: expect 200, not 000
DOCKER_HOST=tcp://127.0.0.1:2382 docker run -d --rm --name pt -p 8082:80 nginx:alpine
curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 http://127.0.0.1:8082/
DOCKER_HOST=tcp://127.0.0.1:2382 docker rm -f pt
```

## Still open

`/tmp/awf-cmd-1.sh` is a fixed host path that awf rewrites on every run, along with
`/tmp/awf-lib` and `/tmp/awf-init`. Whether two concurrent agent jobs collide there has **not**
been tested. If they do, the failure will be intermittent and silent, one run executing
another's script, which is worse than the loud failure the lock used to prevent. Test two
concurrent runs before trusting parallelism. The fix, if needed, is a per-runner `/tmp` mounted
into each DinD.
