---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/shared/opencode.md. Update with `workflows update --force`; consumer edits may be overwritten.
engine:
  id: opencode
  detection-engine: copilot
  version: "2.0.26"
  display-name: OpenCode
  description: OpenCode CLI with headless mode and multi-provider LLM support
  runtime-id: opencode
  experimental: true
  provider:
    name: github
  behaviors:
    secret-strategy: universal-llm-consumer
    capabilities:
      tools-allowlist: true
      max-turns: true
    manifest:
      files:
        - opencode.json
        - opencode.jsonc
        - AGENTS.md
      path-prefixes:
        - .opencode/
    network:
      defaults:
        - host.docker.internal
        - github.com
        - raw.githubusercontent.com
      provider-domains:
        copilot: api.githubcopilot.com
        anthropic: api.anthropic.com
        openai: api.openai.com
        google: generativelanguage.googleapis.com
        codex: api.openai.com
    installation:
      package-manager: npm
      package-name: "@opencode/cli"
      step-name: Install OpenCode CLI
      binary-name: opencode
      include-node-setup: true
      # The pinned package's postinstall links its platform binary into bin/opencode.exe.
      post-install-scripts: true
      verify-command: opencode --version
      verify-step-name: Verify OpenCode CLI installation
      docs-url: https://opencode.ai/v2/docs
    execution:
      command-name: opencode
      args:
        - run
        - --standalone
        - --format
        - json
        - --thinking
        - --print-logs
        - --log-level
        - info
      step-name: Execute OpenCode CLI
      model-env-var: OPENCODE_MODEL
      mcp-config-env-var: GH_AW_MCP_CONFIG
      write-timestamp: true
      provider-env-mode: universal-llm-consumer
      env:
        XDG_DATA_HOME: /tmp/opencode-data
        XDG_CONFIG_HOME: /tmp/opencode-config
        XDG_CACHE_HOME: /tmp/opencode-cache
        XDG_STATE_HOME: /tmp/opencode-state
        OPENCODE_DISABLE_MODELS_FETCH: "1"
        NO_COLOR: "1"
    mcp:
      config-path: /tmp/gh-aw/opencode-mcp.json
      config-adapter: |
        const { loadGatewayContext, filterAndTransformServers, rewriteUrl, writeSecureOutput } = require("./convert_gateway_config_shared.cjs");
        const context = loadGatewayContext();
        const servers = filterAndTransformServers(context.servers, context.cliServers, (name, entry) => {
          if (typeof entry.url !== "string") {
            throw new Error(`OpenCode requires a gateway HTTP URL for MCP server ${name}`);
          }
          return {
            type: "remote",
            url: rewriteUrl(entry.url, context.urlPrefix),
            disabled: false,
            codemode: false,
            oauth: false,
            ...(entry.headers ? { headers: entry.headers } : {}),
          };
        });
        writeSecureOutput("/tmp/gh-aw/opencode-mcp.json", JSON.stringify({ mcp: { servers } }, null, 2));
    harness-script: |
      const { readFileSync, existsSync } = require("fs");
      const { execFile } = require("child_process");
      const { runProcess } = require("./process_runner.cjs");
      const { isOpenCodeEvent, getOpenCodeMCPFailures, getOpenCodeSessionSteps } = require("./parse_opencode_log.cjs");
      const { fetchAWFReflect, deriveBaseUrlFromModelsURL, normalizeReflectProviderName, REFLECT_PROVIDER_ALIASES } = require("./awf_reflect.cjs");

      const [command, ...commandArgs] = process.argv.slice(2);
      const log = message => process.stderr.write(`[opencode-harness] ${message}\n`);
      const main = async () => {
        if (!command) throw new Error("OpenCode command is required");
        const selectedModel = process.env.OPENCODE_MODEL;
        const separator = selectedModel?.indexOf("/") ?? -1;
        if (separator <= 0 || separator === selectedModel.length - 1) {
          throw new Error("OPENCODE_MODEL must use provider/model format");
        }
        const model = selectedModel.slice(separator + 1);
        const provider = process.env.GH_AW_LLM_PROVIDER;
        if (!["github", "anthropic", "openai"].includes(provider)) {
          throw new Error("GH_AW_LLM_PROVIDER must be github, anthropic, or openai");
        }
        // The model roster. The lead model (from OPENCODE_MODEL) is always declared; a workflow
        // names additional models through GH_AW_OPENCODE_MODELS so per-agent `model:` values in the
        // repository's opencode.ci.json resolve. Every model rides the awf-proxy provider, so the
        // deny-all provider policy and the placeholder key stay intact.
        const rosterEnv = process.env.GH_AW_OPENCODE_MODELS || "";
        const roster = rosterEnv
          .split(",")
          .map(entry => entry.trim())
          .filter((entry, index, all) => entry && all.indexOf(entry) === index);
        if (!roster.includes(model)) roster.unshift(model);
        const rawMaxTurns = process.env.GH_AW_MAX_TURNS;
        const maxTurns = rawMaxTurns === undefined || rawMaxTurns === "" ? undefined : Number(rawMaxTurns);
        if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
          throw new Error("GH_AW_MAX_TURNS must be a positive integer");
        }
        const isAnthropic = provider === "anthropic";
        const timeoutMs = name => {
          const value = process.env[name];
          if (value === undefined || value === "") return undefined;
          const milliseconds = Number(value) * 1000;
          if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
            throw new Error(`${name} must specify a positive timeout in seconds`);
          }
          return milliseconds;
        };
        const startupTimeout = timeoutMs("GH_AW_STARTUP_TIMEOUT");
        const toolTimeout = timeoutMs("GH_AW_TOOL_TIMEOUT");
        let baseURL;
        let apiKey;
        if (process.env.AWF_REFLECT_ENABLED === "1") {
          const result = await fetchAWFReflect({ logger: log });
          if (!result.ok || !result.reflectData) throw new Error("Unable to discover the OpenCode LLM endpoint from /reflect");
          const aliases = REFLECT_PROVIDER_ALIASES[provider];
          const endpoint = result.reflectData.endpoints?.find(
            entry => entry?.configured === true && aliases.has(normalizeReflectProviderName(entry.provider))
          );
          if (!endpoint || typeof endpoint.models_url !== "string") {
            throw new Error(`No configured /reflect models endpoint found for provider ${provider}`);
          }
          baseURL = deriveBaseUrlFromModelsURL(endpoint.models_url);
          // The firewall owns upstream credentials; the agent only needs a placeholder.
          apiKey = "awf-proxy";
        } else {
          if (provider === "github") throw new Error("OpenCode Copilot routing requires the AWF sandbox");
          baseURL = isAnthropic ? process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1" : process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
          apiKey = isAnthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
          if (!apiKey) throw new Error("OpenCode provider API key is required without AWF");
        }
        const config = {
          model: `awf-proxy/${model}`,
          update: "disable",
          share: "disabled",
          experimental: {
            policies: [
              { action: "provider.use", resource: "*", effect: "deny" },
              { action: "provider.use", resource: "awf-proxy", effect: "allow" },
            ],
          },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          agents: { build: { permissions: [{ action: "*", resource: "*", effect: "allow" }], ...(maxTurns !== undefined ? { steps: maxTurns } : {}) } },
          mcp: {
            servers: {},
            timeout: {
              ...(startupTimeout !== undefined ? { startup: startupTimeout, catalog: startupTimeout } : {}),
              ...(toolTimeout !== undefined ? { execution: toolTimeout } : {}),
            },
          },
          providers: {
            "awf-proxy": {
              name: "GitHub Agentic Workflows",
              package: isAnthropic ? "@opencode/ai/providers/anthropic" : "@opencode/ai/providers/openai-compatible",
              settings: { baseURL, apiKey },
              models: Object.fromEntries(roster.map(entry => [entry, { name: entry }])),
            },
          },
        };
        const mcpPath = process.env.GH_AW_MCP_CONFIG;
        if (mcpPath) {
          const content = readFileSync(mcpPath, "utf8");
          let mcpConfig;
          try {
            mcpConfig = JSON.parse(content);
          } catch (error) {
            throw new Error("Failed to parse OpenCode MCP configuration", { cause: error });
          }
          if (!mcpConfig?.mcp?.servers || typeof mcpConfig.mcp.servers !== "object" || Array.isArray(mcpConfig.mcp.servers)) {
            throw new Error("OpenCode MCP configuration must contain an mcp.servers object");
          }
          config.mcp.servers = mcpConfig.mcp.servers;
        }
        const promptPath = process.env.GH_AW_PROMPT;
        if (!promptPath) throw new Error("GH_AW_PROMPT is required");
        const prompt = readFileSync(promptPath, "utf8");
        let turns = 0;
        let reportedError = false;
        let maxTurnsHit = false;
        let sessionID;
        const finishedSteps = new Set();
        const finishedMessageParts = new Map();
        const observedMCPFailures = new Set();
        const runtimeEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
        delete runtimeEnv.PWD;
        const handleEvent = line => {
          let entry;
          try { entry = JSON.parse(line); } catch { return; }
          if (!isOpenCodeEvent(entry)) return;
          if (entry.sessionID) sessionID = entry.sessionID;
          if (entry?.type === "error" && entry.error) reportedError = true;
          if (maxTurns !== undefined && entry.type === "tool_use" && entry.part?.state?.status === "error" && entry.part.state.error === "Tools are disabled after the maximum agent steps") {
            maxTurnsHit = true;
          }
          if (entry?.type !== "step_finish") return;
          const messageIdentity = typeof entry.part.messageID === "string" ? JSON.stringify([entry.sessionID, entry.part.messageID]) : undefined;
          const identity = messageIdentity ?? (typeof entry.part.id === "string" ? JSON.stringify([entry.sessionID, "part", entry.part.id]) : undefined);
          if (identity !== undefined && finishedSteps.has(identity)) return;
          if (identity !== undefined) finishedSteps.add(identity);
          if (messageIdentity !== undefined) finishedMessageParts.set(messageIdentity, { id: entry.part.id, messageID: entry.part.messageID });
          turns++;
          if (maxTurns !== undefined && turns >= maxTurns && entry.part?.reason === "tool-calls") {
            maxTurnsHit = true;
          }
        };
        let result = await runProcess({
          command,
          args: [...commandArgs, "--model", `awf-proxy/${model}`],
          logArgs: [...commandArgs, "--model", "(configured model)"],
          attempt: 0,
          log,
          stdin: prompt,
          env: runtimeEnv,
          maxCollectedOutputBytes: 1024 * 1024,
          onStderrLine: line => {
            for (const server of getOpenCodeMCPFailures(line)) observedMCPFailures.add(server);
          },
          onStdoutLine: handleEvent,
          runtimeGuard: { shouldTerminate: () => ({ terminate: maxTurnsHit, reason: "OpenCode max-turns limit reached" }), pollIntervalMs: 100 },
        });
        // A run that ends in text ends `opencode run`, whatever the text promised. When the run
        // exited clean but produced no safe output, the session is continued, twice at most, and
        // told to finish with the safe-output call the task names. A run that exits non-zero, or
        // one that hit the turn ceiling, is not worth continuing.
        const safeOutputsPath = process.env.GH_AW_SAFE_OUTPUTS || "";
        const hasSafeOutputs = () => {
          if (!safeOutputsPath || !existsSync(safeOutputsPath)) return false;
          try { return readFileSync(safeOutputsPath, "utf8").trim().length > 0; } catch { return false; }
        };
        const nudgeMessage = "Your last message ended without a tool call, so nothing has been delivered and this run is about to end with no output. Do not explain or plan: continue the task now and finish with the safe-output call the task names.";
        for (let nudge = 1; nudge <= 2; nudge++) {
          if (result.exitCode !== 0 || maxTurnsHit || hasSafeOutputs() || !sessionID) break;
          log(`No safe output yet, continuing the session (nudge ${nudge} of 2)`);
          result = await runProcess({
            command,
            args: [...commandArgs, "--session", sessionID],
            logArgs: [...commandArgs, "--session", "(same session)"],
            attempt: 0,
            log,
            stdin: nudgeMessage,
            env: runtimeEnv,
            maxCollectedOutputBytes: 1024 * 1024,
            onStderrLine: line => {
              for (const server of getOpenCodeMCPFailures(line)) observedMCPFailures.add(server);
            },
            onStdoutLine: handleEvent,
            runtimeGuard: { shouldTerminate: () => ({ terminate: maxTurnsHit, reason: "OpenCode max-turns limit reached" }), pollIntervalMs: 100 },
          });
        }
        if (maxTurnsHit) {
          process.stdout.write(JSON.stringify({ type: "opencode.max_turns", timestamp: Date.now(), data: { maxTurns } }) + "\n");
          throw new Error("OpenCode max-turns limit reached");
        }
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
          throw new Error(`OpenCode execution failed with exit code ${result.exitCode}`);
        }
        const mcpFailures = [...new Set([...observedMCPFailures, ...getOpenCodeMCPFailures(result.stderr)])];
        if (mcpFailures.length) {
          for (const serverName of mcpFailures) {
            process.stdout.write(JSON.stringify({ type: "opencode.mcp_failure", timestamp: Date.now(), data: { serverName } }) + "\n");
          }
          throw new Error(`OpenCode MCP server(s) failed to start: ${mcpFailures.join(", ")}`);
        }
        if (reportedError) throw new Error("OpenCode reported an error despite exiting with code 0");
        if (!sessionID) throw new Error("OpenCode produced no session events");
        const exported = await new Promise((resolve, reject) => {
          execFile(command, ["session", "export", "--standalone", sessionID], {
            env: runtimeEnv,
            cwd: process.env.GH_AW_ENGINE_CWD || process.env.GITHUB_WORKSPACE || undefined,
            timeout: 60000,
            maxBuffer: 64 * 1024 * 1024,
          }, (error, stdout) => {
            if (error) {
              const diagnostics = [];
              if (Number.isSafeInteger(error.code) || (typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code))) diagnostics.push(`code=${error.code}`);
              if (typeof error.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(error.signal)) diagnostics.push(`signal=${error.signal}`);
              if (error.killed === true) diagnostics.push("killed=true");
              const detail = diagnostics.length ? ` (${diagnostics.join(", ")})` : "";
              return reject(new Error(`Unable to export the OpenCode session for step reconciliation${detail}`, { cause: error }));
            }
            try { resolve(JSON.parse(stdout)); } catch {
              reject(new Error("Failed to parse the OpenCode session export"));
            }
          });
        });
        const records = getOpenCodeSessionSteps(exported, sessionID);
        const steps = records.filter(entry => entry.type === "step_finish");
        if (!steps.length) throw new Error("OpenCode session export contains no completed model steps");
        for (const entry of records) {
          if (entry.type === "step_finish") {
            const observedPart = finishedMessageParts.get(JSON.stringify([entry.sessionID, entry.part.messageID]));
            if (observedPart) entry.part = { ...entry.part, id: observedPart.id, messageID: observedPart.messageID };
          }
          process.stdout.write(JSON.stringify(entry) + "\n");
        }
        if (maxTurns !== undefined && steps.slice(maxTurns - 1).some(entry => entry.part.reason === "tool-calls")) {
          process.stdout.write(JSON.stringify({ type: "opencode.max_turns", timestamp: Date.now(), data: { maxTurns } }) + "\n");
          throw new Error("OpenCode max-turns limit reached");
        }
      };
      main().catch(error => {
        log(error instanceof Error ? error.message : String(error));
        if (!process.exitCode) process.exitCode = 1;
      });
    log-parser: |
      function parseLog(logContent) {
        return require("./parse_opencode_log.cjs").parseOpenCodeLog(logContent);
      }
---

<!--
# OpenCode CLI (Platform fork)

Forked from githubnext/gh-aw's shared/engine definition at v1.2.2 (ed39509).
Three deltas, each with a production incident behind it; everything else tracks
upstream byte for byte so a future upstream change re-diffs cleanly:

1. **Multi-model roster (`GH_AW_OPENCODE_MODELS`).** Upstream declares exactly one
   model on the `awf-proxy` provider, so a repository running a cast of agents
   (lead on one model, a verification subagent on another at temperature 0,
   harness-tier subagents on a third) cannot resolve any model but the lead. The
   harness now declares the workflow's roster alongside the lead, all through the
   awf-proxy provider, so the deny-all provider policy and the placeholder key are
   untouched. Per-agent `model:` values in `opencode.ci.json` pick their model by
   naming `awf-proxy/<model>`.

2. **No forced `--agent build`.** Upstream pins the run to OpenCode's built-in
   `build` agent, which ignores the repository's `default_agent`. Repositories
   here define `ci-workflow-agent` in `opencode.ci.json` with a system prompt that
   carries CI rules the built-in agent does not know (the GitHub CLI is
   unauthenticated, one complete safe-output payload per call, no narration).
   With no `--agent` flag, `default_agent` from repository config applies, and
   OpenCode itself falls back to `build` when a repository defines none.

3. **The nudge.** A turn that ends in text ends `opencode run`, whatever the text
   promised (an agent writing "let me discover the exact safeoutputs command"
   then stopping is not hypothetical). Upstream's harness ends the job with the
   work done and nothing delivered. This harness checks the safe-outputs file
   after a clean exit and continues the same session (`--session <id>`, the ID
   already captured from the event stream) up to twice, telling it to finish with
   the safe-output call the task names.

The rest of this file matches upstream: installation of the pinned
`@opencode/cli@2.0.26` (postinstall allowed), AWF `/reflect` endpoint discovery,
placeholder credentials inside the sandbox, MCP failure surfacing, and the
bounded `session export` reconciliation. See upstream's `.github/workflows/shared/opencode.md`
for the full commentary.
-->
