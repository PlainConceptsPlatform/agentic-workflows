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
    // gh-aw's bundled action scripts default models.json to a hardcoded /tmp/gh-aw, which the
    // lock rewrites cannot reach, so the activation job wrote it outside the directory it
    // uploads from and the agent reported unknown_model_ai_credits.
    .replace(/^env:\n/m, 'env:\n  GH_AW_MODELS_JSON_PATH: /tmp/gh-aw-${{ github.run_id }}/models.json\n')
    // /tmp/gh-aw is a fixed host path used to stage prompt.txt, agent_output.json and
    // safeoutputs.jsonl. Two runners on one machine share it, so one agent overwrote another's
    // prompt and opencode started with no prompt at all. Give each runner its own directory.
    // ${{ github.run_id }} is substituted by Actions, so it works in run: blocks and with:/env:
    // runner context is not. It stays under
    // /tmp where the -v /tmp:/tmp mount already reaches it.
    // Keyed on the run only. A job suffix was added while each runner had its own Linux user,
    // and it broke the activation-to-agent handoff: awf mounts only the current job's
    // directory into the container, so the agent could not read a path built in activation.
    // One user again means the run key is enough, and it still separates concurrent runs.
    .replace(/\/tmp\/gh-aw(?!-\$\{\{)/g, () => '/tmp/gh-aw-${{ github.run_id }}')
    // Three host-global resources were left, and concurrent agent jobs fought over all of them.
    // The global npm install rewrote the opencode binary another job was executing and killed it
    // with SIGKILL mid-run; the warm server and its data directory were shared by every runner.
    //
    // All of these sites are step-level run: or env:, where the runner context is available. It
    // is not available at workflow level, which is what broke the staging path earlier.
    //
    // Install only when the pinned version is missing, and take a lock so two jobs starting at
    // once cannot both write the global prefix.
    // Each runner has its own Docker-in-Docker daemon, so awf's fixed container names cannot
    // collide between parallel jobs. This is set here and NOT in the runner's .env: ports
    // published inside a DinD daemon are unreachable from the host, so a runner-wide value
    // breaks any CI job that reaches a service container on localhost, as app-ci.yml does for
    // SQL Server. Only the gateway and the agent sandbox need the DinD daemon.
    // The gateway defaults its log directory to the unkeyed /tmp/gh-aw/mcp-logs, shared by every
    // run and every runner, so a failing run's log is overwritten by the next one and the only
    // diagnostic left is an empty stdout. Point it at this run's own directory.
    // gh-aw spawns the gateway with stdio [pipe, outputFd, 'ignore'], so docker's stderr is
    // discarded. Every gateway failure then reports an empty "Gateway stdout" and no cause,
    // which is unreadable. Wrapping the command in sh -c with 2>&1 routes stderr into the
    // stdout they already capture. spawn() takes cmd + args with no shell, so the wrapper has
    // to be an explicit sh -c rather than a bare redirect.
    .replace(/^([ \t]*)(export MCP_GATEWAY_DOCKER_COMMAND=.*)$/m,
      (m, indent) => m + '\n' + indent +
        'MCP_GATEWAY_DOCKER_COMMAND="sh -c '+String.fromCharCode(39)+'exec ${MCP_GATEWAY_DOCKER_COMMAND} 2>&1'+String.fromCharCode(39)+'"')
    .replace(/^([ \t]*)export MCP_GATEWAY_DOCKER_COMMAND=/m,
      (m, indent) => indent + 'export MCP_GATEWAY_LOG_DIR="/tmp/gh-aw-${{ github.run_id }}/mcp-logs"' + '\n' + m)
    .replace(/^([ \t]*)export MCP_GATEWAY_DOCKER_COMMAND=/m,
      (m, indent) => indent + 'case "${RUNNER_NAME:-}" in *-[1-9]) export DOCKER_HOST="tcp://127.0.0.1:$((2380 + ${RUNNER_NAME##*-}))" ;; esac' + '\n' + m)
    .replace(/^([ \t]*)GH_AW_DOCKER_HOST=""/m,
      (m, indent) => indent + 'case "${RUNNER_NAME:-}" in *-[1-9]) export DOCKER_HOST="tcp://127.0.0.1:$((2380 + ${RUNNER_NAME##*-}))" ;; esac' + '\n' + m)
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
    .replaceAll('export MCP_GATEWAY_PORT="8080"', 'export MCP_GATEWAY_PORT="${MCP_GATEWAY_PORT:-8080}"')
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

  if (patched !== content) writeFileSync(path, patched);
}
