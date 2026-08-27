#!/usr/bin/env bash
# Pull the agent's container images into every Docker-in-Docker daemon.
#
# Each dind daemon has its own image store, and awf starts its containers with
# `docker compose up --pull never`, so an image the daemon has never seen is a hard failure:
#
#   [ERROR] Fatal error: Command failed with exit code 1:
#   docker compose up -d --no-deps --pull never squid-proxy
#
# The host daemon having the image is irrelevant. Run this after creating or recreating any
# dind daemon, and after bumping an image version in the workflows.
#
#   sudo bash prepull-images.sh

set -uo pipefail

COUNT="${COUNT:-4}"
BASE_PORT="${BASE_PORT:-2380}"

# Keep in step with the images referenced by the compiled agent workflows:
#   grep -ohE 'ghcr\.io/[a-zA-Z0-9./_-]+:[a-zA-Z0-9._-]+' .github/workflows/agent-*.lock.yml | sort -u
IMAGES="
ghcr.io/github/gh-aw-firewall/agent:0.27.44
ghcr.io/github/gh-aw-firewall/api-proxy:0.27.44
ghcr.io/github/gh-aw-firewall/squid:0.27.44
ghcr.io/github/gh-aw-mcpg:v0.4.9
ghcr.io/github/github-mcp-server:v1.9.0
ghcr.io/github/gh-aw-node:latest
"

for i in $(seq 1 "$COUNT"); do
  port=$((BASE_PORT + i))
  export DOCKER_HOST="tcp://127.0.0.1:${port}"
  if ! timeout 10 docker version >/dev/null 2>&1; then
    echo "  dind-$i: daemon not reachable on ${port}, skipped" >&2
    continue
  fi
  for img in $IMAGES; do
    [ -n "$img" ] || continue
    if timeout 300 docker pull -q "$img" >/dev/null 2>&1; then
      echo "  dind-$i: $img"
    else
      echo "  dind-$i: FAILED $img" >&2
    fi
  done
done

echo
echo "== verify: every daemon should list the same set =="
for i in $(seq 1 "$COUNT"); do
  port=$((BASE_PORT + i))
  printf '  dind-%s: %s images\n' "$i" \
    "$(DOCKER_HOST=tcp://127.0.0.1:${port} timeout 10 docker images --format '{{.Repository}}' 2>/dev/null | grep -c 'ghcr.io')"
done
