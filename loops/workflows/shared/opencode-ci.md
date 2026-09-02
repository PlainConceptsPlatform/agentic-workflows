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

  - name: Install the Docker Compose plugin
    # The ARC runner image ships the docker CLI without the compose plugin, and awf drives its
    # sandbox with `docker compose up`. User-space install; no root required.
    run: |
      set -euo pipefail
      if docker compose version >/dev/null 2>&1; then
        echo "compose already present"; exit 0
      fi
      mkdir -p "$HOME/.docker/cli-plugins"
      curl -sSfL "https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-x86_64"         -o "$HOME/.docker/cli-plugins/docker-compose"
      chmod +x "$HOME/.docker/cli-plugins/docker-compose"
      docker compose version

  - name: Install ripgrep
    run: |
      set -euo pipefail

      if command -v rg > /dev/null 2>&1; then
        echo "ripgrep already installed: $(rg --version | head -1)"
        exit 0
      fi

      # ARC runner pods have no root, so ripgrep comes from its release tarball into a
      # user-writable prefix instead of apt.
      mkdir -p "$HOME/.local/bin"
      curl -sSfL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz         | tar -xz --strip-components=1 -C "$HOME/.local/bin" --wildcards "*/rg"
      echo "$HOME/.local/bin" >> "$GITHUB_PATH"
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
      mkdir -p "$HOME/.local/bin"
      install -m 0755 "$RUNNER_TEMP/rtk" "$HOME/.local/bin/rtk"
      echo "$HOME/.local/bin" >> "$GITHUB_PATH"

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

  - name: Restore the CodeGraph index
    # Ephemeral ARC runners start empty, so without this every run rebuilds the whole graph.
    # actions/cache is repository-scoped by design, which keeps consumers isolated, and
    # each run saves an immutable snapshot under its own key at job end (the action's built-in
    # post step), so two concurrent runs never write the same entry: the newest snapshot simply
    # wins the next restore. The index lives in .codegraph inside the checkout plus a small
    # registry in ~/.codegraph.
    uses: actions/cache@v4
    with:
      path: |
        .codegraph
        ~/.codegraph
      key: codegraph-${{ github.repository_id }}-${{ github.run_id }}
      restore-keys: |
        codegraph-${{ github.repository_id }}-

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

  - name: Setup .NET
    # Ephemeral VMs carry no SDK; the old host had it baked in, and GitHub-hosted images made
    # the dependency invisible. setup-dotnet caches per run from the MS CDN.
    uses: actions/setup-dotnet@v5
    with:
      dotnet-version: 10.0.x
    env:
      # the default /usr/share/dotnet needs root; the tool cache belongs to the runner user
      DOTNET_INSTALL_DIR: ${{ runner.tool_cache }}/dotnet

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
