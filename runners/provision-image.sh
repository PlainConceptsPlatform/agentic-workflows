#!/bin/sh
set -eu

# Versions come from versions.env (uploaded by Packer) — single source of truth.
. /tmp/versions.env

# Provisioning script for the pre-baked runner image.
# Runs once at image build time (Packer), not at every VM boot.
# After this, cloud-init only needs to: create swap, drop the VM token, start the service.

# ---- [1/9] Install system packages ----

echo "=== [1/9] apt packages ==="
install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list

curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main" > /etc/apt/sources.list.d/azure-cli.list

# Node.js ${NODE_MAJOR} LTS from NodeSource (needed for pnpm, opencode, agentmemory, codegraph, openspec)
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -

apt-get update -qq
apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  gh azure-cli \
  git jq curl unzip \
  apt-transport-https ca-certificates gnupg \
  nodejs \
  >/dev/null

# ---- [2/9] Create runner user ----
echo "=== [2/9] runner user ==="
useradd -m -s /bin/bash runner || true
usermod -aG docker runner

# ---- [3/9] actions runner binary (pinned version) ----
echo "=== [3/9] actions runner binary ==="
mkdir -p /opt/actions-runner && cd /opt/actions-runner
RUNNER_VERSION="${RUNNER_VERSION:?versions.env missing RUNNER_VERSION}"
curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

tar xzf runner.tgz && rm runner.tgz
./bin/installdependencies.sh >/dev/null 2>&1 || true
chown -R runner:runner /opt/actions-runner

# ---- [4/9] trivy ----
echo "=== [4/9] trivy ==="
curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
  | tar -xz -C /usr/local/bin trivy

# ---- [5/9] ripgrep ----
echo "=== [5/9] ripgrep ==="
mkdir -p /home/runner/.local/bin
curl -sSfL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
  | tar -xz --strip-components=1 -C /home/runner/.local/bin --wildcards "*/rg"

chown -R runner:runner /home/runner/.local

# ---- [6/9] Global npm tools (opencode, agentmemory, codegraph, openspec) ----
echo "=== [6/9] global npm tools (opencode, agentmemory, codegraph, openspec) ==="
npm install -g --no-audit --no-fund \
  opencode-ai@${OPENCODE_VERSION} \
  @agentmemory/agentmemory@${AGENTMEMORY_VERSION} \
  @colbymchenry/codegraph@${CODEGRAPH_VERSION} \
  @fission-ai/openspec@${OPENSPEC_VERSION}
# Install opencode's postinstall (platform binary) — the global npm install with --ignore-scripts skips this, so do it explicitly here
cd "$(npm root -g)/opencode-ai" && node postinstall.mjs || true

# ---- [7/9] RTK (pinned version) ----
echo "=== [7/9] RTK ==="
RTK_VERSION="${RTK_VERSION:?}"
RTK_SHA256="${RTK_SHA256:?}"
curl -fsSL -o /tmp/rtk.tar.gz "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz"

echo "${RTK_SHA256}  /tmp/rtk.tar.gz" | sha256sum --check --strict

tar -xzf /tmp/rtk.tar.gz -C /tmp
install -m 0755 /tmp/rtk /home/runner/.local/bin/rtk
rm -f /tmp/rtk.tar.gz /tmp/rtk
chown runner:runner /home/runner/.local/bin/rtk

# ---- [8/9] .NET SDK 10.0.x ----
echo "=== [8/9] .NET SDK 10.0.x ==="
DOTNET_DIR="/opt/actions-runner/_work/_tool/dotnet"
mkdir -p "$DOTNET_DIR"
curl -fsSL -o /tmp/dotnet.tar.gz "https://aka.ms/dotnet/${DOTNET_MAJOR}/dotnet-sdk-linux-x64.tar.gz"

tar -xzf /tmp/dotnet.tar.gz -C "$DOTNET_DIR"
rm -f /tmp/dotnet.tar.gz
chown -R runner:runner /opt/actions-runner/_work/_tool

echo "export DOTNET_INSTALL_DIR=$DOTNET_DIR" >> /home/runner/.bashrc

echo "export PATH=$DOTNET_DIR:\$PATH" >> /home/runner/.bashrc

# ---- [9/9] pnpm via corepack ----
echo "=== [9/9] pnpm via corepack ==="
corepack enable
# pnpm already ships with Node.js ${NODE_MAJOR}; just verify it's on PATH
if ! command -v pnpm > /dev/null 2>&1; then
  npm install -g pnpm@latest
fi

echo "pnpm: $(pnpm --version)"

# ==== IMG-06: In-build asserts (verify environment) ====

echo "=== Asserts (IMG-06) ==="
fail=0
for bin in docker gh az trivy node pnpm opencode agentmemory codegraph openspec; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ASSERT FAIL: $bin not on PATH"; fail=1; }
done
command -v rg >/dev/null 2>&1 || { echo "ASSERT FAIL: rg not on PATH"; fail=1; }
id runner >/dev/null 2>&1 || { echo "ASSERT FAIL: runner user missing"; fail=1; }
id -nG runner | grep -qw docker || { echo "ASSERT FAIL: runner not in docker group"; fail=1; }
[ -x "/opt/actions-runner/run.sh" ] || { echo "ASSERT FAIL: actions runner binary missing"; fail=1; }
[ "$( /opt/actions-runner/_work/_tool/dotnet/dotnet --version 2>/dev/null )" ] || { echo "ASSERT FAIL: dotnet in toolcache missing"; fail=1; }
if grep -rq "VM_TOKEN" /etc /opt 2>/dev/null; then echo "ASSERT FAIL: VM_TOKEN found on disk"; fail=1; fi
[ "$fail" -eq 0 ] || exit 1
[ "$fail" -eq 0 ] && echo "All asserts passed"

# ==== Completion message ====

echo "=== Provisioning complete ==="
echo "Versions:"
export PATH="/home/runner/.local/bin:$PATH"
docker --version 2>&1 | head -1
gh --version 2>&1 | head -1
az --version 2>&1 | head -1
node --version 2>&1
npm --version 2>&1
pnpm --version 2>&1 || echo "pnpm: not found"
rg --version 2>&1 | head -1 || echo "rg: not found"
trivy --version 2>&1 || echo "trivy: not found"
opencode --version 2>&1 || echo "opencode: not found"
agentmemory --version 2>&1 || echo "agentmemory: not found"
codegraph --version 2>&1 || echo "codegraph: not found"
openspec --version 2>&1 || echo "openspec: not found"
rtk --version 2>&1 || echo "rtk: not found"
dotnet --version 2>&1 || echo "dotnet: not found"
