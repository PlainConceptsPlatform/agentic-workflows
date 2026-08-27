---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/shared/opencode-ci.md. Update with `workflows update --force`; consumer edits may be overwritten.
env:
  AGENTMEMORY_VERSION: "0.9.28"
  CODEGRAPH_VERSION: "1.6.0"
  RTK_VERSION: "0.44.1"
  RTK_SHA256: "986f29704469b3d1051e2474105c6c75ab8b73651068dcd61612c1fb3938ad95"
description: |
  Shared CI setup for Platform agent workflows. Installs pinned tooling and merges
  opencode.ci.json into opencode.jsonc so the CI agent gets its provider and model config.

  Consumer-specific steps (NuGet, .NET restore, OpenSpec, etc.) should be added after the
  shared baseline in the consumer copy. The merge step below is package-owned and required
  for the agent to resolve its provider and its models.

# Consumer repositories should add stack-specific steps (NuGet cache, dotnet restore,
# OpenSpec, Playwright, etc.) after the shared baseline. The merge step at the end is
# package-owned and required for the agent to resolve its provider and models. Do not
# remove it.
pre-agent-steps:
  - name: Create agent scratch directory
    run: mkdir -p .opencode/.tmp

  - name: Start OpenCode server (persistent warm server for faster agent runs)
    run: |
      set -euo pipefail

      OPENCODE_PORT=4096
      mkdir -p /tmp/opencode-data /tmp/gh-aw

      # Check if server is already running
      if curl -sf "http://127.0.0.1:${OPENCODE_PORT}/health" >/dev/null 2>&1; then
        echo "OpenCode server already running on port ${OPENCODE_PORT}"
        exit 0
      fi

      echo "Starting OpenCode server on port ${OPENCODE_PORT}..."
      export XDG_DATA_HOME=/tmp/opencode-data
      nohup opencode serve --port "${OPENCODE_PORT}" --hostname 127.0.0.1 \
        > /tmp/gh-aw/opencode-server.log 2>&1 &

      SERVER_PID=$!
      echo "Server PID: ${SERVER_PID}"

      # Wait for server to be ready (max 30 seconds)
      for i in $(seq 1 30); do
        if curl -sf "http://127.0.0.1:${OPENCODE_PORT}/health" >/dev/null 2>&1; then
          echo "OpenCode server is ready on port ${OPENCODE_PORT}"
          exit 0
        fi
        sleep 1
      done

      # Server didn't start in time - continue without it (agent will cold-start)
      echo "::warning::OpenCode server did not start in 30s, agent will run without warm server"
      kill "${SERVER_PID}" 2>/dev/null || true

  - name: Install ripgrep
    run: |
      set -euo pipefail

      if command -v rg > /dev/null 2>&1; then
        echo "ripgrep already installed: $(rg --version | head -1)"
        exit 0
      fi

      sudo apt-get update
      sudo apt-get install --yes ripgrep
      rg --version

  - name: Activate the pnpm version package.json pins
    run: |
      set -euo pipefail
      corepack enable
      corepack prepare --activate
      pnpm --version

  - name: Cache the pnpm store
    uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
    with:
      path: ~/.local/share/pnpm/store
      key: pnpm-store-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      restore-keys: pnpm-store-${{ runner.os }}-

  - name: Install RTK
    run: |
      set -euo pipefail

      if command -v rtk > /dev/null 2>&1 && rtk --version 2>/dev/null | grep -q "${RTK_VERSION}"; then
        echo "RTK ${RTK_VERSION} already installed"
        exit 0
      fi

      tarball="$RUNNER_TEMP/rtk.tar.gz"
      curl -fsSL -o "$tarball" \
        "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz"
      echo "${RTK_SHA256}  $tarball" | sha256sum --check --strict

      tar -xzf "$tarball" -C "$RUNNER_TEMP"
      sudo install -m 0755 "$RUNNER_TEMP/rtk" /usr/local/bin/rtk

      rtk --version
      rtk init -g --opencode --auto-patch

  - name: Install agentmemory
    run: |
      set -euo pipefail

      if command -v agentmemory > /dev/null 2>&1 && agentmemory --version 2>/dev/null | grep -q "${AGENTMEMORY_VERSION}"; then
        echo "agentmemory ${AGENTMEMORY_VERSION} already installed"
        exit 0
      fi

      npm install -g "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}"
      agentmemory --version

  - name: Install codegraph and index the repository
    continue-on-error: true
    run: |
      set -euo pipefail

      if command -v codegraph > /dev/null 2>&1 && codegraph --version 2>/dev/null | grep -q "${CODEGRAPH_VERSION}"; then
        echo "codegraph ${CODEGRAPH_VERSION} already installed"
      else
        npm install -g "@colbymchenry/codegraph@${CODEGRAPH_VERSION}"
      fi

      codegraph init

  - name: Install OpenSpec CLI
    run: |
      set -euo pipefail

      if command -v openspec > /dev/null 2>&1 && openspec --version 2>/dev/null | grep -q "1.8.0"; then
        echo "openspec 1.8.0 already installed"
        exit 0
      fi

      npm install -g "@fission-ai/openspec@1.8.0"
      openspec --version

  # NOTE: playwright-cli and SQL Server startup steps are not part of the shared CI
  # baseline. The agent path captures no visual evidence: it cannot reach a browser
  # from inside the awf sandbox, and a screenshot with no baseline to compare against
  # gated nothing. Run /ops-evidence locally when a change warrants screenshots. If
  # you need playwright-cli or SQL Server inside the agent sandbox for other reasons,
  # add them as consumer-specific steps after the shared baseline.

  - name: Cache NuGet packages
    uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
    with:
      path: ~/.nuget/packages
      key: nuget-${{ runner.os }}-${{ hashFiles('**/*.slnx', '**/Directory.Packages.props') }}
      restore-keys: nuget-${{ runner.os }}-

  - name: Install workspace dependencies
    run: pnpm install --frozen-lockfile

  - name: Merge the CI-only OpenCode provider into opencode.jsonc
    run: |
      set -euo pipefail

      CONFIG=opencode.jsonc
      FRAGMENT=opencode.ci.json

      [ -f "$FRAGMENT" ] || { echo "::error::$FRAGMENT is missing from the checkout"; exit 1; }

      # Pure JSON on purpose, not JSONC: jq cannot parse `//` comments, and a naive
      # comment-stripper would corrupt the `http://` inside the provider's api URL.
      jq -e . "$FRAGMENT" > /dev/null \
        || { echo "::error::$FRAGMENT is not valid JSON. Comments are not allowed in it."; exit 1; }

      # Despite the .jsonc name, this file is committed in this repository and is read by
      # jq below, so it must contain no comments. A single `//` line fails the merge with
      # "Invalid numeric literal", which names neither the file nor the reason.
      if [ -f "$CONFIG" ] && ! jq -e . "$CONFIG" > /dev/null 2>&1; then
        echo "::error::$CONFIG is tracked and must be comment-free JSON: jq cannot parse it."
        exit 1
      fi

      # opencode.jsonc is untracked in most repositories, so it usually does not exist here.
      # Create it from the fragment when absent, merge when a checkout did provide one.
      if [ -f "$CONFIG" ]; then
        merged=$(jq -s '.[0] * .[1]' "$CONFIG" "$FRAGMENT")
      else
        merged=$(jq -S . "$FRAGMENT")
      fi
      printf '%s\n' "$merged" > "$CONFIG"

      # gh-aw's own "Write OpenCode Config" step runs next and merges its base config with
      # `$existing * $base`. Base wins on conflicting keys, but it defines neither `model`
      # nor this provider, so both survive and `awf-proxy` is added alongside.
      echo "Wrote $CONFIG from $FRAGMENT:"
      jq -r '"  model: \(.model // "unset")", "  plugins: \(.plugin // [] | join(", "))", "  providers: \(.provider // {} | keys | join(", "))"' "$CONFIG"
---
