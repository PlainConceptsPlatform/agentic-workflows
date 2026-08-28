# Secrets the platform actually uses

Audited 2026-08-28 by grepping every workflow and lock in Numa and Odyssey. The placement
rule: **org-level when the value is platform-wide, repo-level when it differs per repo.**
Reusable workflows only see any of these because the router forwards them with
`secrets: inherit` at every lock call site — remove that and every agent run silently loses
its secrets again.

## Organization secrets (shared values)

| Secret | Used by | Purpose |
|---|---|---|
| `AZURE_SCALER_CLIENT_ID` / `TENANT_ID` / `SUBSCRIPTION_ID` / `CLIENT_SECRET` | runner-scaler.yml | `Platform Agents Pro` SP login to scale `agentrunner-vmss-01` |
| `RUNNER_SCALER_GH_TOKEN` | runner-scaler.yml | mints org JIT runner configs. **Currently a personal session token — replace with a fine-grained PAT (org, "Self-hosted runners: read/write") and rotate** |
| `AGENTMEMORY_SECRET` | every agent run | HMAC auth to the shared AgentMemory App Service; mirrored in the app's settings |
| `BOT_APP_ID` / `BOT_PRIVATE_KEY` | bot-approve, merge-gate | the platform-devbox GitHub App that approves and merges bot PRs |

## Repository secrets (per-repo values)

| Secret | Used by | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | agent runs | the **Forge key**: gh-aw's OpenAI-shaped slot, pointed at forge.plainconcepts.com; per-repo value |
| `CODEX_API_KEY` | agent runs | gh-aw's alternate engine slot; same Forge routing, kept because the locks reference it |
| `COPILOT_GITHUB_TOKEN` | refine paths | Copilot-engine calls where used |

## Present but unused

`FORGE_API_KEY` is referenced by **nothing** — the Forge value flows through `OPENAI_API_KEY`
because that is the env name gh-aw's engine wiring reads. Safe to delete, or keep as the
human-readable source of truth you copy into `OPENAI_API_KEY`.

`GH_AW_GITHUB_TOKEN`, `GH_AW_GITHUB_MCP_SERVER_TOKEN`, `GH_AW_CI_TRIGGER_TOKEN`,
`NPM_REGISTRY_TOKEN` appear in generated lock references with fallbacks to `GITHUB_TOKEN`;
none is configured and none is required in this setup.

## Rotation notes

- `AZURE_SCALER_CLIENT_SECRET` was exchanged over chat during setup: rotate it in the
  `Platform Agents Pro` app registration, then update the org secret.
- `AGENTMEMORY_SECRET` rotation: generate a new value, set it in the App Service settings
  **and** the org secret, restart the app.
