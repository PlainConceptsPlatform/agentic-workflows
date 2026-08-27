#!/usr/bin/env bash
# Tools that app-ci.yml and app-infra.yml expect on PATH.
#
# GitHub-hosted runners ship these. This host does not, and moving those workflows here made
# that the host's problem. Install to /usr/local/bin rather than a user's home: with a runner
# per user, anything under /home/<user> is invisible to the other three, which surfaces as
# "command not found" and exit 127 in a step that names no cause.
#
#   sudo bash install-host-tools.sh

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "== reportgenerator =="
export DOTNET_CLI_HOME=/tmp/dotnetcli
mkdir -p "$DOTNET_CLI_HOME"
dotnet tool install --tool-path /usr/local/bin dotnet-reportgenerator-globaltool 2>&1 | tail -1

echo "== trivy =="
url=$(curl -sSfL https://api.github.com/repos/aquasecurity/trivy/releases/latest \
  | grep -oE '"browser_download_url": *"[^"]*Linux-64bit\.tar\.gz"' | head -1 | cut -d'"' -f4)
[ -n "$url" ] || { echo "  could not resolve the trivy asset" >&2; exit 1; }
tmp=$(mktemp -d)
curl -sSfL "$url" -o "$tmp/trivy.tgz"
tar xzf "$tmp/trivy.tgz" -C "$tmp" trivy
install -m 0755 "$tmp/trivy" /usr/local/bin/trivy
rm -rf "$tmp"

# The agent workflows check for these and skip installing when the version matches. They cannot
# install them themselves: `npm install -g` as the runner user fails with EACCES because
# /usr/lib/node_modules is root-owned, and the job only ever succeeded because the pinned version
# was already present. Bumping a pin without running this script makes the job fail at install.
echo "== opencode and codegraph (pins must match the workflows) =="
export NPM_CONFIG_MIN_RELEASE_AGE=1
OPENCODE_VERSION=1.18.23
CODEGRAPH_VERSION=1.6.0
npm install --ignore-scripts -g "opencode-ai@${OPENCODE_VERSION}"
# opencode's postinstall downloads its platform binary. --ignore-scripts blocks it, so run only
# this one explicitly and leave every other package's scripts blocked.
( cd "$(npm root -g)/opencode-ai" && node postinstall.mjs )
npm install -g "@colbymchenry/codegraph@${CODEGRAPH_VERSION}"

echo "== verify =="
for u in runner; do
  id -u "$u" >/dev/null 2>&1 || continue
  printf '  %s: ' "$u"
  sudo -u "$u" bash -lc 'for t in reportgenerator trivy opencode codegraph; do command -v $t >/dev/null || { echo "MISSING: $t"; exit 1; }; done; echo ok'
done
