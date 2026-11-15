// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
//
// gh-aw 1.2.2 replaced the legacy OpenCode wiring this script used to rewrite. The engine
// definition (loops/workflows/shared/opencode.md) now installs @opencode/cli with its
// postinstall allowed, forces lowercase log levels, disables the models-registry fetch, and
// collects safe outputs natively ("Ingest agent output"; bundles are in the artifact glob).
// The rewrites that carried those fixes until upstream shipped them are gone. What remains
// here is fleet integration: VM affinity, per-runner MCP gateway ports, the awf host lock,
// the Forge gateway and AgentMemory wiring, secret fallbacks, and the safe-output contracts
// (update_issue must carry a body; the MCP config must not see the pull request base).

// The engine's install step runs in the shared runner's global npm prefix. Two agent jobs on
// one VM installing the same package concurrently rewrite the binary the other is executing
// and kill it with SIGKILL mid-run, so installs serialize behind a per-VM lock. The
// opencode-ai guard this replaces is gone: the engine pins @opencode/cli itself.
const OPENCODE_INSTALL_FLOCK = "flock /tmp/opencode-install.lock npm install -g @opencode/cli@"
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

// gh-aw folds a workflow's top-level `if:` into the activation job but computes activation.needs
// on its own, so a compiled `if:` can read `needs.<job>` for a job activation never waits for.
// GitHub does not reject that: the reference resolves to '' at runtime and the clause is silently
// true (agent-merge-gate's protected_changes guard, Pliny-Bot run 34042143350). actionlint would
// flag it, but it is deliberately not run on generated files (it does not model concurrency.queue
// or job.workflow_*). This is the one check that reads the locks, and it needs no dependency:
// gh-aw emits jobs at two spaces, job keys at four, list items at six.
function undeclaredNeeds(lock) {
  const violations = [];
  let inJobs = false;
  let job = null;
  let inList = false;
  let jobs = 0;
  let needs = new Set();
  let refs = new Set();
  const flush = () => {
    if (!job) return;
    for (const ref of refs) if (!needs.has(ref)) violations.push({ job, ref, needs: [...needs].sort() });
  };
  for (const line of lock.split("\n")) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^[^\s#]/.test(line)) inJobs = false;
    if (!inJobs) continue;
    const start = line.match(/^  ([a-z_][a-zA-Z0-9_-]*):\s*$/);
    if (start) { flush(); job = start[1]; jobs += 1; needs = new Set(); refs = new Set(); inList = false; continue; }
    if (!job) continue;
    if (/^    needs:\s*$/.test(line)) { inList = true; continue; }
    const inline = line.match(/^    needs:\s*(.+?)\s*$/);
    if (inline) {
      for (const n of inline[1].replace(/[\[\]]/g, "").split(",")) if (n.trim()) needs.add(n.trim());
      inList = false;
      continue;
    }
    if (inList) {
      const item = line.match(/^      - (\S+)\s*$/);
      if (item) { needs.add(item[1]); continue; }
      inList = false;
    }
    // A JSON mapping key is not a read. gh-aw's prompt interpolation defers the prompt's
    // needs.* references into literal keys like "needs.reserve.outputs.has_conflicts" in
    // activation metadata, quoted or backslash-escaped inside env JSON; the runner never
    // evaluates a key, so strip keys first, then any remaining needs.X counts: ${{ }}
    // expressions and bare `if:` conditions alike.
    const bare = line.replace(/\\?"needs\.[a-zA-Z0-9_.-]+\\?":/g, "");
    for (const m of bare.matchAll(/needs\.([a-z_][a-zA-Z0-9_-]*)\./g)) refs.add(m[1]);
  }
  flush();
  return { jobs, violations };
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

function lintLock(file, text) {
  const lint = undeclaredNeeds(text);
  if (lint.jobs === 0) {
    process.stderr.write(
      `${file}: the needs lint found no jobs; the gh-aw lock layout changed. ` +
      `Re-anchor undeclaredNeeds() in loops/scripts/compile-agent-workflows.mjs.\n`,
    );
    process.exitCode = 1;
  }
  for (const v of lint.violations) {
    process.stderr.write(
      `${file}: job "${v.job}" reads needs.${v.ref} but its needs are [${v.needs.join(", ")}]; ` +
      `the reference resolves to '' at runtime. For activation, list the job under on.needs in the ` +
      `source frontmatter; for a custom job, add it to that job's needs.\n`,
    );
    process.exitCode = 1;
  }
}

// gh aw compile leaves a lock alone when its frontmatter and body hashes still match the source.
// This script then ran over a lock it had already patched: AGENTMEMORY_URL was inserted a second
// time, the opencode install line was wrapped in itself, and the consumer freshness check could
// never be clean (Pliny-Bot agentics-checks run 33963600563). The sentinel marks a processed
// lock; a lock that carries it is linted and otherwise left as it is.
const SENTINEL = "# post-processed by scripts/compile-agent-workflows.mjs; run it again and nothing changes";

for (const file of readdirSync(workflowDirectory)) {
  if (!file.endsWith(".lock.yml")) continue;

  const path = join(workflowDirectory, file);
  const content = readFileSync(path, "utf8");
  if (content.includes(SENTINEL)) {
    lintLock(file, content);
    continue;
  }
  const patched = content
    .replace(/^(# This file was automatically generated by gh-aw[^\n]*\n)/m, `$1${SENTINEL}\n`)
    // Workflow affinity: every agent job carries a per-run label so the scaler can pin a
    // whole run to one VM, and the base label moves to agents-aw so a CI-only job
    // (agents-arc) can never land on a run's dedicated VM. Done post-compile because
    // gh-aw's frontmatter runs-on is a plain scalar. The function form keeps ${{ }} literal.
    .replace(/runs-on: agents-arc/g, () => 'runs-on: [agents-aw, "affinity-${{ github.repository_id }}-${{ github.run_id }}-${{ github.run_attempt }}"]')
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
    // the same again. The chain is serial anyway, so in practice this only queues one consumer behind
    // the other. Held for the whole agent run, which is deliberate. The lock lives outside the
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
    // "A failed run is already a red run": report-failure-as-issue: false and
    // GH_AW_REPORT_FAILED_JOBS: "false" were supposed to silence issue creation, but
    // 0.87.5's engine-failure reporter files an "[aw] ... failed" issue anyway (seen as
    // Pliny-Bot #57: an OOM-killed gate produced a fresh issue nobody needs, while the
    // retry belt is the actual remediation). `if: false` keeps the step compiled but
    // never runs it, so the failure stays visible in the run and in the belt's attempt
    // comment, and out of the issue tracker.
    .replace(
      /^([ \t]+)- name: Report failed jobs\n([ \t]*)id: report_failed_jobs\n[ \t]*if: always\(\)\n/m,
      '$1- name: Report failed jobs\n$2id: report_failed_jobs\n$2if: false # never: failures surface in the run and the retry belt\n')

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
    // "A failed run is already a red run": report-failure-as-issue: false silences one
    // reporter, but gh-aw hardcodes a second one (report_failed_jobs) that files an
    // "[aw] Failed jobs" issue per red run. Same philosophy, same off switch.
    .replaceAll('GH_AW_REPORT_FAILED_JOBS: "true"', 'GH_AW_REPORT_FAILED_JOBS: "false"')
    // The engine installs @opencode/cli into the shared global npm prefix. Two agent jobs
    // on one VM installing concurrently rewrite the binary the other is about to execute;
    // the flock serializes installs per machine. The version is the engine definition's.
    .replace(/( *)run: npm install -g @opencode\/cli@/,
      (_, indent) => `${indent}run: ${OPENCODE_INSTALL_FLOCK}`)
    // One XDG data directory per runner, not one shared: standalone runs keep session state
    // on the host, and two runners on one VM must not see each other's sessions. No double
    // quotes here: the enclosing run: is a double-quoted YAML scalar, so a quote would have
    // to be escaped. The default has no spaces, so bare is safe shell.
    .replace(/\/tmp\/opencode-data(?!-\$\{\{)/g, () => '/tmp/opencode-data-${{ runner.name }}')
    // The engine key falls back to FORGE_API_KEY, the one secret every repository here has. The
    // router maps it to OPENAI_API_KEY when it CALLS a worker, but a stack child is DISPATCHED on
    // its feature branch, and a dispatched run reads repository secrets by their own names: with
    // no OPENAI_API_KEY or CODEX_API_KEY set, activation died on "Validate CODEX_API_KEY or
    // OPENAI_API_KEY secret" and every stack child in Pliny-Bot failed that way for hours. gh-aw
    // reads the key in four places, the validation step, the engine env and the redaction list
    // included, and all of them must see the fallback or the key would run unredacted. The
    // longest form goes first so the shorter ones do not match inside it.
    .replaceAll('${{ secrets.CODEX_API_KEY || secrets.OPENAI_API_KEY }}',
      '${{ secrets.CODEX_API_KEY || secrets.OPENAI_API_KEY || secrets.FORGE_API_KEY }}')
    .replaceAll('${{ secrets.CODEX_API_KEY }}', '${{ secrets.CODEX_API_KEY || secrets.FORGE_API_KEY }}')
    .replaceAll('${{ secrets.OPENAI_API_KEY }}', '${{ secrets.OPENAI_API_KEY || secrets.FORGE_API_KEY }}');

  let rewritten = patched;

  // update_issue declares no required field, so the safe-outputs MCP server accepts a call
  // carrying only issue_number and answers success. An agent that drops the body - the
  // documented way is omitting the trailing `.` so the bridge never reads stdin - loses its
  // whole story, is told nothing, and goes on to claim completion. add_comment declares body
  // required and rejects the identical mistake, which is how the agent recovers from it on
  // the next turn. Measured on Lyceum before this: one refine run in five wrote its story,
  // the other four ended green with the issue untouched (#44, #59 twice, #62), and Numa #698
  // reached `refined, implement` still carrying its original form body.
  //
  // Only agent-refine calls update_issue, and always to replace the body; labels and status
  // are workflow-owned and the prompt forbids the agent from touching them, so requiring the
  // body costs no legitimate call. The check below fails the compile if this stops matching.
  {
    const toolStart = rewritten.indexOf('"update_issue": {');
    if (toolStart !== -1) {
      const bodyField = rewritten.indexOf('"body": {', toolStart);
      if (bodyField !== -1) {
        const insertAt = bodyField + '"body": {'.length;
        if (!rewritten.slice(insertAt, insertAt + 80).includes('"required": true')) {
          rewritten = rewritten.slice(0, insertAt) + '\n' + ' '.repeat(20) + '"required": true,' + rewritten.slice(insertAt);
        }
      }
    }
  }

  // The pull request base belongs to the handler, never to the MCP server. agent-implement sets
  // base-branch from the dispatched ref so a stack child lands on its feature branch, and gh-aw
  // writes that base into both configs. The safe-outputs MCP server runs inside the sandbox,
  // where remote refs are not visible, and given a base it insists on a merge-base against
  // origin/<base>: on Lyceum #73 it answered "No remote refs available for merge-base
  // calculation" twice and the run died at max-turns with the code already written (run
  // 38737284343). With no base it patches from the pinned SHA, which the stack dispatch sets to
  // the feature tip, and that is exactly the patch the handler then applies onto the base. So
  // the MCP config loses the base and the handler config keeps it. The check below fails the
  // compile if this stops matching.
  rewritten = rewritten.replace(
    /^([ \t]+GH_AW_SAFE_OUTPUTS_CONFIG: "[^\n]*?)\\"base_branch\\":\\"[^\\"]*\\",/m,
    "$1",
  );

  // Guard the two rewrites the compiled agent jobs cannot work without. The anchors are
  // upstream template text: when a gh-aw upgrade reshapes either step, the silent
  // failure mode returns (an artifact with no bundle, a skipped push, a green gate on
  // an untouched pull request). Failing the compile is the only loud signal there is.
  for (const check of [
    { name: "placeholder step intact", ok: /\n( +)- name: Write agent output placeholder if missing\n\1  if: always\(\)\n\1  run: \|\n\1    if \[ ! -f \/tmp\/gh-aw\/agent_output\.json \]; then\n\1      echo '\{"items":\[\]\}' > \/tmp\/gh-aw\/agent_output\.json\n\1    fi\n/ },
    // Every read of the engine key carries the FORGE_API_KEY fallback; see the rewrite above.
    {
      name: "engine key falls back to FORGE_API_KEY",
      ok: lock => !lock.includes("${{ secrets.OPENAI_API_KEY }}") && !lock.includes("${{ secrets.CODEX_API_KEY }}"),
    },
    { name: "failed-jobs reporter disabled", ok: /- name: Report failed jobs\n[ \t]*id: report_failed_jobs\n[ \t]*if: false[^\n]*\n/ },
    // Only agent-refine declares update_issue; the other workers never carry the tool.
    {
      name: "update_issue requires a body",
      ok: lock =>
        !lock.includes('"update_issue": {') ||
        /"update_issue": \{[\s\S]{0,3000}?"body": \{\s*\n\s*"required": true,/.test(lock),
    },
    // The base reaches the handler and never the MCP server; see the rewrite above. Anchored on
    // the escaped quotes because allowed_base_branches contains the bare text base_branch.
    {
      name: "pull request base stays out of the MCP config",
      ok: lock => {
        const mcp = (lock.match(/^[ \t]+GH_AW_SAFE_OUTPUTS_CONFIG: "[^\n]*/m) || [""])[0];
        const handler = (lock.match(/^[ \t]+GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG: "[^\n]*/m) || [""])[0];
        if (mcp.includes('\\"base_branch\\"')) return false;
        // The handler config keeps the expression for Actions to expand before the job starts;
        // only the MCP config is rewritten to an env reference. Either form is the run's ref.
        return !file.startsWith("agent-implement") ||
          handler.includes('\\"base_branch\\":\\"${{ github.ref_name }}\\"') ||
          handler.includes('\\"base_branch\\":\\"${GITHUB_REF_NAME}\\"');
      },
    },
  ]) {
    const passed = typeof check.ok === "function" ? check.ok(rewritten) : check.ok.test(rewritten);
    if (!passed) {
      process.stderr.write(
        `compile patch "${check.name}" no longer matches in ${file}: the gh-aw template changed. ` +
        `Re-anchor the rewrite in loops/scripts/compile-agent-workflows.mjs, or agent pushes are silently dropped.\n`,
      );
      process.exitCode = 1;
    }
  }

  if (!rewritten.includes(SENTINEL)) {
    process.stderr.write(
      `${file}: the generated-file header changed and the post-processing sentinel was not placed; ` +
      `re-anchor the SENTINEL insert in loops/scripts/compile-agent-workflows.mjs.\n`,
    );
    process.exitCode = 1;
  }
  lintLock(file, rewritten);

  if (rewritten !== content) writeFileSync(path, rewritten);
}
