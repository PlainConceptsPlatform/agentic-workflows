#!/bin/sh
set -eu

# Versions come from versions.env (uploaded by Packer) - single source of truth.
. /tmp/versions.env

# Provisioning script for the pre-baked runner image.
# Runs once at image build time (Packer), not at every VM boot.
# After this, cloud-init only needs to: create swap, drop the VM token, start the service.

# Install system packages

echo "=== [1/9] apt packages ==="
install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list

curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main" > /etc/apt/sources.list.d/azure-cli.list

# Node.js ${NODE_MAJOR} LTS from NodeSource
# Needed for pnpm, opencode, agentmemory, codegraph and openspec
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -

apt-get update -qq
apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  gh azure-cli \
  git jq curl unzip zip \
  apt-transport-https ca-certificates gnupg \
  nodejs \
  >/dev/null

echo "=== [2/9] runner user ==="
useradd -m -s /bin/bash runner || true
usermod -aG docker runner

# Actions runner binary (pinned version)

echo "=== [3/9] actions runner binary ==="
mkdir -p /opt/actions-runner
cd /opt/actions-runner

RUNNER_VERSION="${RUNNER_VERSION:?versions.env missing RUNNER_VERSION}"

curl -fsSL -o runner.tgz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

tar xzf runner.tgz
rm runner.tgz

./bin/installdependencies.sh >/dev/null 2>&1 || true

chown -R runner:runner /opt/actions-runner

# Trivy

echo "=== [4/9] trivy ==="

curl -fsSL \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
  | tar -xz -C /usr/local/bin trivy

# ripgrep

echo "=== [5/9] ripgrep ==="

curl -sSfL \
  "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
  | tar -xz --strip-components=1 -C /usr/local/bin --wildcards "*/rg"

chmod +x /usr/local/bin/rg

# Global npm tools

echo "=== [6/9] global npm tools (opencode, agentmemory, codegraph, openspec) ==="

npm install -g --no-audit --no-fund \
  @opencode/cli@${OPENCODE_VERSION} \
  @agentmemory/agentmemory@${AGENTMEMORY_VERSION} \
  @colbymchenry/codegraph@${CODEGRAPH_VERSION} \
  @fission-ai/openspec@${OPENSPEC_VERSION}

# OpenCode 2 ships as @opencode/cli, and its postinstall selects the platform
# binary. npm runs postinstall for a global install by default, so no explicit
# postinstall step is needed here.

# RTK

echo "=== [7/9] RTK ==="

RTK_VERSION="${RTK_VERSION:?}"
RTK_SHA256="${RTK_SHA256:?}"

mkdir -p /home/runner/.local/bin

curl -fsSL -o /tmp/rtk.tar.gz \
  "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz"

echo "${RTK_SHA256}  /tmp/rtk.tar.gz" | sha256sum --check --strict

tar -xzf /tmp/rtk.tar.gz -C /tmp

install -m 0755 /tmp/rtk /home/runner/.local/bin/rtk

rm -f /tmp/rtk.tar.gz /tmp/rtk

chown -R runner:runner /home/runner/.local

# .NET SDK

echo "=== [8/9] .NET SDK 10.0.x ==="

DOTNET_DIR="/opt/actions-runner/_work/_tool/dotnet"

mkdir -p "$DOTNET_DIR"

curl -fsSL -o /tmp/dotnet.tar.gz \
  "https://aka.ms/dotnet/${DOTNET_MAJOR}/dotnet-sdk-linux-x64.tar.gz"

tar -xzf /tmp/dotnet.tar.gz -C "$DOTNET_DIR"

rm -f /tmp/dotnet.tar.gz

# _work itself was created by the extraction above, running as root, so it is
# root:755 and the runner user cannot create _work/_temp at job time. Own the
# whole tree, not just _tool.
chown -R runner:runner /opt/actions-runner/_work

echo "export DOTNET_INSTALL_DIR=$DOTNET_DIR" >> /home/runner/.bashrc
echo "export PATH=$DOTNET_DIR:\$PATH" >> /home/runner/.bashrc
echo 'export PATH=/home/runner/.local/bin:$PATH' >> /home/runner/.bashrc

# pnpm via corepack

echo "=== [9/9] pnpm via corepack ==="

corepack enable

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@latest
fi

echo "pnpm: $(pnpm --version)"

# ==== IMG-06: In-build asserts ====

# az CLI first-run (above, as root) creates /home/runner/.azure root-owned.
# The runner user (who runs all GitHub Actions jobs) then can't write the
# MSAL token cache, and azure/login@v3 fails with Permission denied.
mkdir -p /home/runner/.azure
chown -R runner:runner /home/runner/.azure

echo "=== Asserts (IMG-06) ==="

fail=0

for bin in docker gh az trivy node pnpm opencode agentmemory codegraph openspec zip; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ASSERT FAIL: $bin not on PATH"
    fail=1
  }
done

command -v rg >/dev/null 2>&1 || {
  echo "ASSERT FAIL: rg not on PATH"
  fail=1
}

id runner >/dev/null 2>&1 || {
  echo "ASSERT FAIL: runner user missing"
  fail=1
}

id -nG runner | grep -qw docker || {
  echo "ASSERT FAIL: runner not in docker group"
  fail=1
}

[ -x "/opt/actions-runner/run.sh" ] || {
  echo "ASSERT FAIL: actions runner binary missing"
  fail=1
}

[ -x "/home/runner/.local/bin/rtk" ] || {
  echo "ASSERT FAIL: rtk missing"
  fail=1
}

[ "$(/opt/actions-runner/_work/_tool/dotnet/dotnet --version 2>/dev/null)" ] || {
  echo "ASSERT FAIL: dotnet in toolcache missing"
  fail=1
}

# Write _work directly (not a pre-made subdir: that one would be root-owned and
# the test would measure the subdir, not _work). At job time run.sh creates
# _work/_temp itself, so the requirement is exactly "runner can create entries here".
su -s /bin/bash runner -c "touch /opt/actions-runner/_work/.write-test" 2>/dev/null || {
  echo "ASSERT FAIL: runner user cannot write /opt/actions-runner/_work (ownership wrong)"
  fail=1
}
rm -f /opt/actions-runner/_work/.write-test
chown runner:runner /opt/actions-runner/_work

if grep -rq "VM_TOKEN" /etc /opt 2>/dev/null; then
  echo "ASSERT FAIL: VM_TOKEN found on disk"
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

echo "All asserts passed"

# ==== Completion message ====

echo "=== Provisioning complete ==="
echo "Versions:"

export PATH="/home/runner/.local/bin:$DOTNET_DIR:$PATH"

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