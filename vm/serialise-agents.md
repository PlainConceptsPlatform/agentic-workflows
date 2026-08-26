# Why agent jobs run one at a time

awf names its containers `awf-agent`, `awf-squid` and `awf-api-proxy`. Only the compose project
label varies per run, and the schema offers no option for container names, a prefix, or a
project name. Two agent jobs on one host therefore recreate each other's containers, and the
first dies with `exit 137` partway through its work. The timestamped network name
`awf-<timestamp>_awf-ext` makes runs look isolated. They are not.

## What was tried first, and why it failed

Giving each runner its own Linux user and its own rootless Docker daemon. The container
isolation worked: the identical names lived in separate namespaces, proven by creating the same
container name in two daemons at once.

Everything the runners share through the filesystem broke instead. awf and gh-aw both write
fixed-name files into `/tmp`, and a file created by one user cannot be overwritten by the next.
Six distinct failures came from that one cause, each looking unrelated:

| Symptom | Actually |
|---|---|
| `EACCES` on `/tmp/gh-aw/models.json` | writer used a hardcoded path, uploader used the keyed one |
| implement "succeeded" with no safe outputs | an hour of work written where nothing read it |
| `EACCES` on `/tmp/gh-aw/agent_output.json` | the staging tree belonged to another user |
| gateway "exited during initialization", empty stdout | `--user <host uid>` cannot open a socket that maps to uid 0 |
| same message again, still empty stdout | `--group-add <host gid>` is unmapped, runc fails at `setgroups` |
| `/host/tmp/awf-cmd-1.sh: Permission denied` | fixed-name script owned by a different user |

An ACL on `/tmp` fixes only some of these. Default ACLs are masked by the mode a file is created
with, so a script written `0755` still cannot be overwritten by another user, and one written
`0600` cannot even be read.

## What runs now

Every runner is the `runner` user again, on the one rootful daemon, and the compiled lock wraps
the awf call in `flock /tmp/agentic-awf.lock`. One agent job runs at a time. Every other job,
CI and deploy included, still uses all four runners.

The cost is small in practice. The feature chain implements one story at a time by design, so
the only real serialisation is Numa queueing behind Odyssey.

The lock deliberately lives outside the `/tmp/gh-aw` namespace. The staging-path rewrite keys
anything starting `/tmp/gh-aw` on run and job, which would give every job its own lock file and
silently no mutual exclusion at all. That was caught in validation, not in production, and only
because the compiled output was checked rather than the patch.

## If agent parallelism is needed later

Run several daemons under the single `runner` user, each with its own socket and data root, and
point each runner at one with `DOCKER_HOST`. That keeps one user, so none of the `/tmp` problems
return, while still separating the container namespaces. It needs a pre-created bridge and
subnet per daemon, and concurrent daemons writing iptables is not officially supported.
