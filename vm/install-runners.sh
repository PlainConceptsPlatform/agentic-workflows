#!/usr/bin/env bash
# Registers N self-hosted runners on a host prepared by setup-vm.sh.
# Idempotent: an instance that is already configured is left alone, so re-run to add more.
#
#   TOKEN=$(gh api -X POST orgs/<org>/actions/runners/registration-token --jq .token)
#   sudo bash install-runners.sh --org <org> --token "$TOKEN" --count 4
#
# Each instance gets its own MCP gateway port and OpenCode port. Those two are the only host
# resources the workflows cannot share; see README.md.

set -euo pipefail

ORG=""
TOKEN=""
COUNT=4
GROUP="agentic"
LABELS="agents"
RUNNER_USER="${RUNNER_USER:-runner}"
ROOT="${ROOT:-/opt/actions-runner}"
VERSION="${RUNNER_VERSION:-2.336.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$ORG" ] && [ -n "$TOKEN" ] || { echo "--org and --token are required" >&2; exit 1; }
id -u "$RUNNER_USER" >/dev/null 2>&1 || { echo "user $RUNNER_USER does not exist; run setup-vm.sh first" >&2; exit 1; }

HOST=$(hostname)
mkdir -p "$ROOT"

# One package download, extracted per instance. Instances must not share a directory: each
# keeps its own _work, credentials and tool cache.
PKG="$ROOT/actions-runner-linux-x64-${VERSION}.tar.gz"
if [ ! -f "$PKG" ]; then
  echo "== downloading runner ${VERSION} =="
  curl -fsSL -o "$PKG" \
    "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-x64-${VERSION}.tar.gz"
fi

for i in $(seq 1 "$COUNT"); do
  DIR="$ROOT/$i"
  NAME="${HOST}-${i}"

  if [ -f "$DIR/.runner" ]; then
    echo "== instance $i already configured, skipping =="
    continue
  fi

  echo "== instance $i =="
  mkdir -p "$DIR"
  tar -xzf "$PKG" -C "$DIR"

  # Instance 1 keeps the upstream defaults so a single-runner host needs no environment at all.
  # Later instances move off them: both ports are published on the host loopback and cannot be
  # shared. Everything else is isolated at compile time, not here.
  {
    echo "LANG=C.UTF-8"
    if [ "$i" -gt 1 ]; then
      echo "MCP_GATEWAY_PORT=808${i}"
      echo "OPENCODE_PORT=409${i}"
    fi
  } > "$DIR/.env"

  chown -R "${RUNNER_USER}:${RUNNER_USER}" "$DIR"

  su "$RUNNER_USER" -s /bin/bash -c "cd '$DIR' && ./config.sh --unattended --replace \
    --url 'https://github.com/${ORG}' \
    --token '${TOKEN}' \
    --name '${NAME}' \
    --runnergroup '${GROUP}' \
    --labels '${LABELS}' \
    --work _work" >/dev/null

  ( cd "$DIR" && ./svc.sh install "$RUNNER_USER" >/dev/null && ./svc.sh start >/dev/null )
  echo "  registered as ${NAME} and started"
done

echo
echo "== services =="
systemctl list-units --type=service --plain --no-legend | awk '/actions.runner/{print "  "$1" "$4}'
echo
echo "== per-instance environment =="
for i in $(seq 1 "$COUNT"); do
  [ -f "$ROOT/$i/.env" ] && printf '  %s: %s\n' "$i" "$(tr '\n' ' ' < "$ROOT/$i/.env")"
done
echo
echo "Confirm the group does not allow public repositories:"
echo "  gh api orgs/${ORG}/actions/runner-groups/<id> --jq '.allows_public_repositories'"
