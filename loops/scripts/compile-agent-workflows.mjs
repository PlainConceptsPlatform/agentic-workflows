// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

const OPENCODE_VERSION = '1.18.23'
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workflowDirectory = existsSync("loops/workflows") ? "loops/workflows" : ".github/workflows";

// On Windows, `gh` resolves to a shim that spawnSync cannot find without a shell.
// Resolve the full path via `where` so spawnSync works with shell: false (security-safe).
function resolveGhPath() {
  if (process.platform !== "win32") return "gh";
  const result = spawnSync("where", ["gh"], { encoding: "utf8", shell: false });
  if (result.status === 0) {
    const first = result.stdout.split("\n").map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  return "gh";
}

const compile = spawnSync(resolveGhPath(), ["aw", "compile", "--strict", "--dir", workflowDirectory], {
  stdio: "inherit",
  shell: false,
});

if (compile.error?.code === "ENOENT" || compile.status === null) {
  process.stderr.write("Could not run `gh aw compile`. Install githubnext/gh-aw first.\n");
  process.exit(1);
}

if (compile.status !== 0) process.exit(compile.status ?? 1);

for (const file of readdirSync(workflowDirectory)) {
  if (!file.endsWith(".lock.yml")) continue;

  const path = join(workflowDirectory, file);
  const content = readFileSync(path, "utf8");
  const patched = content
    .replaceAll("opencode run --print-logs --log-level DEBUG", "opencode run --log-level ERROR")
    .replaceAll("opencode run --print-logs --log-level ERROR", "opencode run --log-level ERROR")
    .replaceAll("opencode run --log-level ERROR", "opencode run --log-level ERROR")
    .replaceAll("--log-level DEBUG", "--log-level ERROR")
    .replace(/GH_AW_INFO_MODEL: "[^"]*"/g, 'GH_AW_INFO_MODEL: "per-agent"')
    .replace(/OPENCODE_MODEL: [^\n]+/g, "OPENCODE_MODEL: ''")
    .replace(/GH_AW_INFO_MODEL_COSTS: '[^']*'/g, 'GH_AW_INFO_MODEL_COSTS: \'{"providers":{}}\'')
    // The MCP gateway is the only thing the agent publishes on the host loopback, so it is the
    // one thing two runners on the same machine cannot share. Honour an inherited port so each
    // runner service can pick its own; everything else is namespaced by its Docker daemon.
    // awf names its containers awf-agent, awf-squid and awf-api-proxy with no way to change
    // them, so two agent jobs on one host recreate each other's containers and the first dies
    // with exit 137. Giving each runner its own user and daemon isolated the containers but
    // broke everything the runners share through the filesystem: awf and gh-aw both write
    // fixed-name files into /tmp, and a file one user creates cannot be overwritten by the
    // next. Six separate failures came from that. One host lock is the smaller trade: agent
    // jobs run one at a time, every other job still uses all the runners, and every user is
    // the same again. The chain is serial anyway, so in practice this only queues Numa behind
    // Odyssey. Held for the whole agent run, which is deliberate. The lock lives outside the
    // /tmp/gh-aw namespace on purpose: the keying rewrite below would otherwise make the lock
    // file per job, which is silently no lock at all.
    // Agent jobs run in parallel again. Each runner has its own Docker-in-Docker daemon, so
    // awf's fixed container names (awf-agent, awf-squid, awf-api-proxy, awmg-mcpg) live in
    // separate namespaces and cannot recreate each other. gh-aw detects the tcp DOCKER_HOST
    // and switches to its ARC/DinD path by itself, so no flag is needed here. The host-wide
    // flock this replaces made every agent job wait for the previous one.
    // Three host-global resources were left, and concurrent agent jobs fought over all of them.
    // The global npm install rewrote the opencode binary another job was executing and killed it
    // with SIGKILL mid-run; the warm server and its data directory were shared by every runner.
    //
    // All of these sites are step-level run: or env:, where the runner context is available. It
    // is not available at workflow level, which is what broke the staging path earlier.
    //
    // Install only when the pinned version is missing, and take a lock so two jobs starting at
    // once cannot both write the global prefix.
    // gh-aw pins opencode-ai 1.2.14 at every release checked, up to v0.87.5. That version is
    // from 2026-02-25. The harness expects 1.18.9 and this is the current release, so a gh-aw
    // upgrade does not move it and the pin is ours to choose.
    // gh-aw defaults NPM_CONFIG_MIN_RELEASE_AGE to 3 days, which blocks any package
    // published in the last three days with ETARGET "No matching version found ... with a
    // date before". Lowered to 1 so a fix released yesterday is usable. This is a
    // supply-chain cooldown: shortening it accepts a newer package sooner.
    .replace(/NPM_CONFIG_MIN_RELEASE_AGE: ['\"]?3['\"]?/g, "NPM_CONFIG_MIN_RELEASE_AGE: '1'")
    // The MCP gateway runs inside a per-runner Docker-in-Docker daemon. gh-aw publishes it on
    // 127.0.0.1, which is the DinD container's own loopback, while the outer publish forwards to
    // that container's eth0, so the two never meet and gh-aw's health check fails 120 times with
    // ECONNREFUSED. Binding 0.0.0.0 inside the daemon connects them. The host still exposes the
    // port on loopback only, because the DinD container is published as 127.0.0.1:<port>.
    .replaceAll("-p 127.0.0.1:'\"${MCP_GATEWAY_PORT}\"':", "-p '\"${MCP_GATEWAY_PORT}\"':")
    // Each runner needs its own gateway port: four DinD daemons publish through to one host
    // loopback, so two jobs on 8080 would collide. The runner sets it in .env.
    // awf chroots into the Docker daemon's filesystem and requires it to be the runner's own
    // glibc host. A Docker-in-Docker daemon fails with "Detected Alpine/musl host filesystem
    // under /host", and no dind image fixes it: the agent needs the runner's toolchain and
    // workspace, which a separate daemon container never has. So every agent job shares one
    // daemon, awf's container names are fixed, and the jobs must be serialised.
    .replaceAll('          awf --config', '          flock /tmp/agentic-awf.lock awf --config')
    .replaceAll('export MCP_GATEWAY_PORT="8080"', 'export MCP_GATEWAY_PORT="${MCP_GATEWAY_PORT:-8080}"')
    // The agent's safe outputs land in safeoutputs.jsonl, but the collector reads
    // agent_output.json, and nothing in the generated workflow converts one to the other.
    // With the OpenCode engine the tool calls go through the MCP server rather than stdout,
    // so the log parser never produces agent_output.json and the placeholder step writes
    // {"items":[]} over a run that did real work: the job goes green and the pull request
    // is silently dropped. Build the collector's input from what the agent actually emitted.
    .replaceAll("echo '{\"items\":[]}' > /tmp/gh-aw-${{ github.run_id }}/agent_output.json", "if [ -s /tmp/gh-aw-${{ github.run_id }}/safeoutputs.jsonl ]; then jq -s '{items: .}' /tmp/gh-aw-${{ github.run_id }}/safeoutputs.jsonl > /tmp/gh-aw-${{ github.run_id }}/agent_output.json; else echo '{\"items\":[]}' > /tmp/gh-aw-${{ github.run_id }}/agent_output.json; fi")
    // v0.87.5's arc-dind mode stages the engine CLI to a daemon-visible path but assumes the
    // Copilot engine: command -v copilot is empty under engine: opencode and cp "" fails the
    // job before the agent starts. OpenCode needs no staging, because npm -g installs it under
    // the tool-cache prefix inside _work, which the dind daemon shares.
    // Centralised AgentMemory: an always-on App Service; the shim proxies to it when the
    // URL is set and authenticates with the HMAC secret. Local development leaves both
    // unset and keeps the local per-run store.
    .replace(/^env:\n/m, 'env:\n  AGENTMEMORY_URL: https://agentmemory-pro-01.azurewebsites.net\n')
    // the secret is scoped to the one step that runs the agent (semgrep: a secret in
    // workflow-level env is visible to every job and step)
    .replaceAll('          OPENAI_BASE_URL: https://forge.plainconcepts.com/v1',
      '          OPENAI_BASE_URL: https://forge.plainconcepts.com/v1' + '\n' +
      '          AGENTMEMORY_SECRET: ${{ secrets.AGENTMEMORY_SECRET }}')
    // the router passes secrets explicitly (semgrep flags secrets: inherit as over-broad),
    // so the callee must declare everything it accepts
    .replace(/^      COPILOT_GITHUB_TOKEN:/m,
      '      AGENTMEMORY_SECRET:' + '\n' + '        required: false' + '\n' + '      COPILOT_GITHUB_TOKEN:')
    .replaceAll('          COPILOT_SRC="$(command -v copilot)"',
      '          command -v copilot >/dev/null 2>&1 || { echo "no copilot binary (engine is opencode); skipping"; exit 0; }' + '\n' +
      '          COPILOT_SRC="$(command -v copilot)"')
    // "A failed run is already a red run": report-failure-as-issue: false silences one
    // reporter, but gh-aw hardcodes a second one (report_failed_jobs) that files an
    // "[aw] Failed jobs" issue per red run. Same philosophy, same off switch.
    .replaceAll('GH_AW_REPORT_FAILED_JOBS: "true"', 'GH_AW_REPORT_FAILED_JOBS: "false"')
    // gh-aw sees a custom step calling dotnet and injects its own setup-dotnet, which carries
    // no DOTNET_INSTALL_DIR and so tries to write /usr/share/dotnet. The runner user has no
    // sudo, so the job dies with "Permission denied" before the agent starts. The shared
    // baseline step already redirects to the tool cache; this gives every other one the same
    // env, including ones a future gh-aw release injects.
    .replace(
      /^( +)- name: Setup \.NET\n\1  uses: actions\/setup-dotnet@[^\n]*\n\1  with:\n((?:\1    [^\n]*\n)+)(?!\1  env:)/gm,
      (_m, indent, withBody) =>
        indent + '- name: Setup .NET\n' + indent + '  uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0\n' +
        indent + '  with:\n' + withBody +
        indent + '  env:\n' + indent + '    DOTNET_INSTALL_DIR: ${{ runner.tool_cache }}/dotnet\n')
    .replace(/opencode-ai@[0-9][0-9.]*/g, 'opencode-ai@' + OPENCODE_VERSION)
    // gh-aw installs with --ignore-scripts, which blocks opencode's own postinstall. That
    // script downloads the platform binary, so 1.18 fails at first use with "opencode-ai's
    // postinstall script was not run". 1.2.14 did not need it. Run only opencode's postinstall
    // explicitly, so every other package's scripts stay blocked.
    .replace(
      /npm install --ignore-scripts -g opencode-ai@([0-9][0-9.]*)/g,
      (_m, v) =>
        "opencode --version 2>/dev/null | grep -qF '" + v + "' || " +
        "flock /tmp/opencode-install.lock sh -c 'npm install --ignore-scripts -g opencode-ai@" + v +
        " && cd \"$(npm root -g)/opencode-ai\" && node postinstall.mjs' # opencode-ai@" + v)
    // One warm server per runner, on its own port, with its own data directory. Keyed on the
    // runner rather than the run so a runner keeps its server warm between its own jobs.
    // No double quotes here: the enclosing run: is a double-quoted YAML scalar, so a quote
    // would have to be escaped. The default has no spaces, so bare is safe shell.
    .replace(/\/tmp\/opencode-data(?!-\$\{\{)/g, () => '/tmp/opencode-data-${{ runner.name }}');

  let rewritten = patched;
  // A queued implement executes hours after its run was created, but actions/checkout
  // without a ref checks out github.sha, which GitHub pins at run creation. Five children
  // queued together at 02:01 all carried the 02:01 base; once the first sibling merged,
  // every later push became a rebase onto a moved parent, which gh-aw's signed-commit
  // push cannot do (it dies with "cannot rebase: You have unstaged changes" and files the
  // pull request as an issue instead of a pull request). Checking out the branch tip at
  // execution time makes the commit parent current main; the implement-global queue
  // already keeps sibling merges out of the window while the agent runs.
  if (file === "agent-implement.lock.yml") {
    const start = rewritten.indexOf("\n  agent:\n");
    const rest = start === -1 ? "" : rewritten.slice(start + 1);
    const next = rest.search(/\n  [a-z_][a-zA-Z_-]*:\n/);
    if (start !== -1 && next !== -1) {
      const end = start + 1 + next;
      const span = rewritten.slice(start, end).replace(
        /(uses: actions\/checkout@[^\n]*\n(\s+)with:\n(?:\2  [^\n]+\n)*)/,
        (whole, _block, indent) =>
          whole.includes("ref:") ? whole : whole + indent + "  ref: ${{ github.event.repository.default_branch }}\n",
      );
      rewritten = rewritten.slice(0, start) + span + rewritten.slice(end);
    }
  }

  if (rewritten !== content) writeFileSync(path, rewritten);
}
