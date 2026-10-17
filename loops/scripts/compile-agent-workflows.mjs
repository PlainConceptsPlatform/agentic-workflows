// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

const OPENCODE_VERSION = '2.0.22'
const OPENCODE_PACKAGE = '@opencode/cli'

// The install the compiled locks carry, shared so both rewrite sites emit exactly
// the same command.
//
// `--allow-scripts` is the part that matters. npm now blocks a dependency's
// install scripts unless the package is explicitly allowed, and @opencode/cli
// downloads its platform binary from its own postinstall. Without the flag the
// install "succeeds" (exit 0, `added N packages`) while the postinstall is
// skipped with a warning, leaving a stub bin and the previous version in place,
// so the job runs OpenCode 1 against OpenCode 2 config and the gateway rejects
// every model. `NPM_CONFIG_ALLOW_SCRIPTS` is the spelling npm accepts for a
// global install; the CLI form is refused for project-scoped installs.
//
// The trailing check turns a silent bad install into a loud failure: if the
// version still is not there after installing, the step exits non-zero rather
// than letting the agent run on the wrong binary.
const OPENCODE_INSTALL_GUARD =
  "opencode --version 2>/dev/null | grep -qF '" + OPENCODE_VERSION + "' || " +
  "flock /tmp/opencode-install.lock sh -c " +
  "'NPM_CONFIG_ALLOW_SCRIPTS=" + OPENCODE_PACKAGE + " npm install -g " + OPENCODE_PACKAGE + "@" + OPENCODE_VERSION + "' ; " +
  "opencode --version 2>/dev/null | grep -qF '" + OPENCODE_VERSION + "' || " +
  "{ echo \"::error::opencode " + OPENCODE_VERSION + " is not installed after the install step\"; exit 1; }"
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
    for (const m of line.matchAll(/needs\.([a-z_][a-zA-Z0-9_-]*)\./g)) refs.add(m[1]);
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
    // The engine command is normalized to one shape:
    //   - OPENCODE_DISABLE_MODELS_FETCH=1: opencode otherwise fetches its model
    //     registry from https://models.opencode.ai/api.json at startup and blocks
    //     bootstrap on it. Inside the awf sandbox that host is not on the egress
    //     allowlist, so the fetch hangs and every agent run stalls right after
    //     "init" until the runner kills it. The forge provider declares its models
    //     explicitly, so the remote registry is not needed here.
    //   - --print-logs + a non-silent level: stripping --print-logs and forcing
    //     ERROR hid every engine log, so a stalled bootstrap looked like silence.
    //     The level must be lower case: OpenCode 2 rejects `INFO` with
    //     "Invalid value for flag --log-level", aborting before the agent runs.
    //     The old upper-case spelling was valid in v1 and is not in v2.
    .replace(/opencode run(?: --print-logs)? --log-level (?:DEBUG|ERROR|INFO|debug|error|info)/g, "OPENCODE_DISABLE_MODELS_FETCH=1 opencode run --print-logs --log-level info")
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
    // Install only when the pinned version is missing, and take a lock so two jobs starting at
    // once cannot both write the global prefix.
    // gh-aw pins opencode-ai 1.2.14 at every release checked, up to v0.90.0. That version is
    // from 2026-02-25, and it was the pin the guard used until the OpenCode 2 migration: the
    // harness now ships @opencode/cli at OPENCODE_VERSION above, and the pin is ours to choose
    // because a gh-aw upgrade does not move it.
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
    // The "Copy Safe Outputs" step runs on the host after the awf container exits. At that
    // point /tmp/gh-aw/ IS the host's /tmp/gh-aw/, where the safeoutputs MCP container wrote
    // patch and bundle files (via the MCP gateway's -v /tmp:/tmp:rw mount). Extend the step
    // to also copy those files to RUNNER_TEMP/gh-aw/ so the upload step can include them.
    // Without this, the upload step's glob /tmp/gh-aw/aw-*.patch runs inside the awf chroot
    // (where /tmp/gh-aw is a different path) and finds nothing. The safe_outputs and conclude
    // jobs then receive no patches in the artifact and silently skip the push.
    .replace(
      '          cp "$GH_AW_SAFE_OUTPUTS" /tmp/gh-aw/safeoutputs.jsonl 2>/dev/null || true\n',
      '          cp "$GH_AW_SAFE_OUTPUTS" /tmp/gh-aw/safeoutputs.jsonl 2>/dev/null || true\n' +
      '          # Copy patch/bundle files generated by the safeoutputs MCP container to\n' +
      '          # RUNNER_TEMP/gh-aw/ so the upload step includes them in the artifact.\n' +
      '          mkdir -p "${RUNNER_TEMP}/gh-aw"\n' +
      '          ls -la /tmp/gh-aw/ 2>/dev/null || true\n' +
      '          cp /tmp/gh-aw/aw-*.patch "${RUNNER_TEMP}/gh-aw/" 2>/dev/null || true\n' +
      '          cp /tmp/gh-aw/aw-*.bundle "${RUNNER_TEMP}/gh-aw/" 2>/dev/null || true\n' +
      '          ls -la "${RUNNER_TEMP}/gh-aw/"aw-* 2>/dev/null || true\n')
    // Add patch/bundle paths to the upload glob so the agent artifact carries what
    // push-agent-branch needs. The anchor is the two adjacent path lines of the
    // "...agent" upload step; the "...agent-output-fallback" upload lists them in the
    // opposite order, so it cannot match. Anchoring matters: the first bare
    // '/tmp/gh-aw/agent_output.json\n' in the file is the placeholder step's echo line,
    // and replacing there corrupted the placeholder into executing the globs as
    // commands while the upload list stayed without bundles. The artifact then carried
    // no bundle, push-agent-branch silently skipped the push, and the gate reported
    // "remediated" on a pull request that was never touched.
    // Only the /tmp/gh-aw globs may be added: a ${{ runner.temp }} path as well would
    // move the upload's least-common-ancestor from /tmp/gh-aw to /, and every file in
    // the artifact (agent_output.json included) would gain a prefix that
    // download-agent-output does not look for.
    .replace(
      '            /tmp/gh-aw/safeoutputs.jsonl\n            /tmp/gh-aw/agent_output.json\n',
      '            /tmp/gh-aw/safeoutputs.jsonl\n' +
      '            /tmp/gh-aw/aw-*.patch\n' +
      '            /tmp/gh-aw/aw-*.bundle\n' +
      '            /tmp/gh-aw/agent_output.json\n')
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

    // v0.90.0's arc-dind mode stages the engine CLI to a daemon-visible path but assumes the
    // Copilot engine: command -v copilot is empty under engine: opencode and cp "" fails the
    // job before the agent starts. OpenCode needs no staging, because npm -g installs it under
    // the tool-cache prefix inside _work, which the dind daemon shares.
    // Centralised AgentMemory: an always-on App Service; the shim proxies to it when the
    // URL is set and authenticates with the HMAC secret. Local development leaves both
    // unset and keeps the local per-run store.
    .replace(/^env:\n/m, 'env:\n  AGENTMEMORY_URL: https://agentmemory-pro-01.azurewebsites.net\n')
    // the secret is scoped to the one step that runs the agent (semgrep: a secret in
    // workflow-level env is visible to every job and step)
    .replaceAll('          OPENAI_BASE_URL: http://host.docker.internal:10001',
      '          OPENAI_BASE_URL: https://forge.plainconcepts.com/v1')
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
    // gh-aw injects this "Restore .NET dependencies" step whenever a consumer's
    // frontend (e.g. VERIFY_COMMANDS) references dotnet. An AI agent can create a
    // .claude/worktrees/agent-XXX/ worktree at restore time — the first .slnx find
    // matches that scratch dir, and the hardcoded path lands in the lock, breaking
    // every agent run with MSB1009. Replace with dynamic discovery that excludes
    // agent scratch directories so a stale worktree never poisons the restore.
    .replace(
      /^( +)- name: Restore \.NET dependencies\n\1  run: dotnet restore .*$/m,
      (_m, indent) =>
        indent + '- name: Restore .NET dependencies\n' + indent +
        '  run: |-\n' + indent +
        '    SLNX=$(find . -maxdepth 5 -name "*.slnx" -not -path "./.claude/*" -not -path "./.opencode/*" | head -1)\n' + indent +
        '    [ -n "$SLNX" ] && dotnet restore "$SLNX" || echo "No .slnx found, skipping restore"')
    .replace(
      /^( +)- name: Setup \.NET\n\1  uses: actions\/setup-dotnet@[^\n]*\n\1  with:\n((?:\1    [^\n]*\n)+)(?!\1  env:)/gm,
      (_m, indent, withBody) =>
        indent + '- name: Setup .NET\n' + indent + '  uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0\n' +
        indent + '  with:\n' + withBody +
        indent + '  env:\n' + indent + '    DOTNET_INSTALL_DIR: ${{ runner.tool_cache }}/dotnet\n')
    // OpenCode 2 ships as @opencode/cli, not opencode-ai. gh-aw's engine manifest
    // still names opencode-ai and installs it with --ignore-scripts, which blocks
    // the postinstall that selects the platform binary.
    //
    // The whole guard is replaced, not just the install inside it. gh-aw emits
    //   opencode --version | grep -qF '<gh-aw pin>' || sh -c 'npm install … opencode-ai@<pin>'
    // and rewriting only the inner install left the outer grep on gh-aw's pin while
    // the image carries ours: the grep never matched, so the guard re-ran the install
    // on every job, and a lock already wearing the sentinel was never revisited. The
    // first pattern below collapses that shape — outer guard, wrapper and all — to a
    // single clean guard; the second handles a bare install the outer guard is absent from.
    .replace(
      /opencode --version[^\n]*grep -qF '[0-9][0-9.]*' \|\|[^\n]*?npm install --ignore-scripts -g opencode-ai@[0-9][0-9.]*[^\n]*/g,
      () =>
        OPENCODE_INSTALL_GUARD)
    .replace(
      /npm install --ignore-scripts -g opencode-ai@([0-9][0-9.]*)/g,
      () => OPENCODE_INSTALL_GUARD)
    .replace(/opencode-ai@[0-9][0-9.]*/g, OPENCODE_PACKAGE + '@' + OPENCODE_VERSION)
    .replace(/opencode-ai\b/g, OPENCODE_PACKAGE)
    // One warm server per runner, on its own port, with its own data directory. Keyed on the
    // runner rather than the run so a runner keeps its server warm between its own jobs.
    // No double quotes here: the enclosing run: is a double-quoted YAML scalar, so a quote
    // would have to be escaped. The default has no spaces, so bare is safe shell.
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
  // A queued implement executes hours after its run was created, but actions/checkout
  // without a ref checks out github.sha, which GitHub pins at run creation. Five children
  // queued together at 02:01 all carried the 02:01 base; once the first sibling merged,
  // every later push became a rebase onto a moved parent, which gh-aw's signed-commit
  // push cannot do (it dies with "cannot rebase: You have unstaged changes" and files the
  // pull request as an issue instead of a pull request). Checking out the branch tip at
  // execution time makes the commit parent current main; the implement queue, shared by the
  // children of one refine, keeps sibling merges out of the window while the agent runs.
  //
  // A stack child dispatches this workflow directly (`gh workflow run
  // agent-implement.lock.yml --ref feat/N`), and there the pin must select the feature
  // branch tip, not main: github.ref_name is the ref the dispatch named. Under
  // workflow_call the callee inherits the caller's event, and the router is only ever
  // dispatched on the default branch, so the dispatch arm of the ternary resolves to
  // main there too -- flat behavior is byte-identical.
  if (file === "agent-implement.lock.yml") {
    const start = rewritten.indexOf("\n  agent:\n");
    const rest = start === -1 ? "" : rewritten.slice(start + 1);
    const next = rest.search(/\n  [a-z_][a-zA-Z_-]*:\n/);
    if (start !== -1 && next !== -1) {
      const end = start + 1 + next;
      const span = rewritten.slice(start, end).replace(
        /(uses: actions\/checkout@[^\n]*\n(\s+)with:\n(?:\2  [^\n]+\n)*)/,
        (whole, _block, indent) =>
          whole.includes("ref:")
            ? whole
            : whole +
              indent +
              "  ref: ${{ github.event_name == 'workflow_dispatch' && github.ref_name || github.event.repository.default_branch }}\n",
      );
      rewritten = rewritten.slice(0, start) + span + rewritten.slice(end);
    }
  }

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
    { name: "bundle upload glob", ok: /\n( +)- name: Upload agent artifacts\n\1  if: always\(\)\n\1  continue-on-error: true\n\1  uses: actions\/upload-artifact@[^\n]*\n\1  with:\n\1    name: \$\{\{ needs\.activation\.outputs\.artifact_prefix \}\}agent\n\1    path: \|\n(?:\1      [^\n]*\n)*\1      \/tmp\/gh-aw\/aw-\*\.bundle\n/ },
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
