// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
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
    .replaceAll("opencode run --print-logs --log-level DEBUG", "opencode run --port 4096 --log-level ERROR")
    .replaceAll("opencode run --print-logs --log-level ERROR", "opencode run --port 4096 --log-level ERROR")
    .replaceAll("opencode run --log-level ERROR", "opencode run --port 4096 --log-level ERROR")
    .replaceAll("--log-level DEBUG", "--log-level ERROR")
    .replace(/GH_AW_INFO_MODEL: "[^"]*"/g, 'GH_AW_INFO_MODEL: "per-agent"')
    .replace(/OPENCODE_MODEL: [^\n]+/g, "OPENCODE_MODEL: ''")
    .replace(/GH_AW_INFO_MODEL_COSTS: '[^']*'/g, 'GH_AW_INFO_MODEL_COSTS: \'{"providers":{}}\'')
    // The MCP gateway is the only thing the agent publishes on the host loopback, so it is the
    // one thing two runners on the same machine cannot share. Honour an inherited port so each
    // runner service can pick its own; everything else is namespaced by its Docker daemon.
    .replaceAll('export MCP_GATEWAY_PORT="8080"', 'export MCP_GATEWAY_PORT="${MCP_GATEWAY_PORT:-8080}"')
    // /tmp/gh-aw is a fixed host path used to stage prompt.txt, agent_output.json and
    // safeoutputs.jsonl. Two runners on one machine share it, so one agent overwrote another's
    // prompt and opencode started with no prompt at all. Give each runner its own directory.
    // ${{ github.run_id }} is substituted by Actions, so it works in run: blocks and with:/env:
    // runner context is not. The job id is appended because jobs of one run land on different
    // runners, and those run as different users: a directory created by one cannot be written
    // by the next. Jobs pass data through artifacts, so nothing needs a shared path. It stays under
    // /tmp where the -v /tmp:/tmp mount already reaches it.
    .replace(/\/tmp\/gh-aw(?!-\$\{\{)/g, () => '/tmp/gh-aw-${{ github.run_id }}-${{ github.job }}')
    // Three host-global resources were left, and concurrent agent jobs fought over all of them.
    // The global npm install rewrote the opencode binary another job was executing and killed it
    // with SIGKILL mid-run; the warm server and its data directory were shared by every runner.
    //
    // All of these sites are step-level run: or env:, where the runner context is available. It
    // is not available at workflow level, which is what broke the staging path earlier.
    //
    // Install only when the pinned version is missing, and take a lock so two jobs starting at
    // once cannot both write the global prefix.
    .replace(
      /npm install --ignore-scripts -g opencode-ai@([0-9][0-9.]*)/g,
      (_m, v) =>
        "opencode --version 2>/dev/null | grep -qF '" + v + "' || " +
        "flock /tmp/opencode-install.lock npm install --ignore-scripts -g opencode-ai@" + v)
    // One warm server per runner, on its own port, with its own data directory. Keyed on the
    // runner rather than the run so a runner keeps its server warm between its own jobs.
    // No double quotes here: the enclosing run: is a double-quoted YAML scalar, so a quote
    // would have to be escaped. The default has no spaces, so bare is safe shell.
    .replaceAll('OPENCODE_PORT=4096', 'OPENCODE_PORT=${OPENCODE_PORT:-4096}')
    .replace(/\/tmp\/opencode-data(?!-\$\{\{)/g, () => '/tmp/opencode-data-${{ runner.name }}');

  if (patched !== content) writeFileSync(path, patched);
}
