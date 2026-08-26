#!/usr/bin/env bash
# Prepares a fresh Ubuntu host to act as an agentic runner host.
# Idempotent: safe to re-run on a host that is already set up.
#
#   sudo bash setup-vm.sh
#
# Installs Docker, the packages the agent toolchain needs, a runner user with passwordless
# sudo, and swap. It does not register any runner: see install-runners.sh.

set -euo pipefail

RUNNER_USER="${RUNNER_USER:-runner}"
SWAP_GB="${SWAP_GB:-8}"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# curl/jq/git are used by the workflows themselves; the rest are agent toolchain prerequisites.
apt-get install -y -qq curl jq git build-essential ca-certificates gnupg unzip >/dev/null

echo "== docker =="
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker version --format '  server {{.Server.Version}}'

echo "== node =="
# The agent installs OpenCode through npm, so a system node is required.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node --version)"

echo "== runner user =="
if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$RUNNER_USER"
  echo "  created $RUNNER_USER"
fi
usermod -aG docker "$RUNNER_USER"
# The workflows install packages during a run (ripgrep, toolchains), which needs sudo without
# a prompt. A run that stops for a password looks like a hang with no diagnostic.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$RUNNER_USER" > "/etc/sudoers.d/${RUNNER_USER}"
chmod 0440 "/etc/sudoers.d/${RUNNER_USER}"

echo "== swap =="
# Without swap a memory spike is an instant SIGKILL, and exit 137 in the middle of an agent run
# is indistinguishable from a workflow bug. Swappiness stays low so it is a safety net, not a
# routine path.
if swapon --show 2>/dev/null | grep -q .; then
  echo "  already present"
else
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  added ${SWAP_GB}G"
fi
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo
echo "Host ready. Register runners with install-runners.sh."
free -m | head -3
