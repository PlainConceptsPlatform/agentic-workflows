# Secrets the platform actually uses

Audited 2026-08-28. Placement rule: **org-level when the value is platform-wide,
repo-level when it differs per repo, app settings when only the scaler app needs it.**
The router forwards secrets to reusable workflows with an explicit per-callee list at
every lock call site; each callee only receives what its `workflow_call` contract
declares.

## Organization secrets (shared values)

| Secret | Used by | Purpose |
|---|---|---|
| `AGENTMEMORY_SECRET` | every agent run | HMAC auth to the shared AgentMemory App Service; mirrored in the app's settings |
| `BOT_APP_ID` / `BOT_PRIVATE_KEY` | bot-approve, merge-gate, feature chain | the platform-devbox GitHub App that approves and merges bot PRs |

## Repository secrets (per-repo values)

| Secret | Used by | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | agent runs | the **Forge key**: gh-aw's OpenAI-shaped slot, pointed at forge.plainconcepts.com; per-repo value |
| `CODEX_API_KEY` | agent runs | gh-aw's alternate engine slot; same Forge routing, kept because the locks reference it |
| `COPILOT_GITHUB_TOKEN` | refine paths | Copilot-engine calls where used |

## Scaler app settings (agentrunner-scaler-01, not GitHub secrets)

| Setting | Purpose |
|---|---|
| `GH_PAT` | fine-grained PAT, sole grant org "Self-hosted runners: rw", expires 2027-08-29; mints JIT configs |
| `WEBHOOK_SECRET` | HMAC for the org workflow_job webhook |
| `VM_TOKEN` | bearer VMs use for `/vm/jit` and `/vm/done`; also baked into the VMSS custom data |
| `AZ_SUBSCRIPTION` / `AZ_RG` / `AZ_VMSS` / `GH_ORG` / `RUNNER_LABEL` / `RUNNER_GROUP_ID` | plain configuration |

Azure access is the app's **managed identity** (Virtual Machine Contributor on the
RG): no Azure credential is stored anywhere.

## Removed 2026-08-28 (delete if still present)

`AZURE_SCALER_CLIENT_ID` / `TENANT_ID` / `SUBSCRIPTION_ID` / `CLIENT_SECRET` and
`RUNNER_SCALER_GH_TOKEN` were org secrets for the retired workflow scaler
(runner-scaler.yml). No workflow references them anymore; the PAT value moved into
the app's `GH_PAT` setting, and the SP is no longer in the scaling path at all.

## Present but unused

`FORGE_API_KEY` is referenced by **nothing** — the Forge value flows through `OPENAI_API_KEY`
because that is the env name gh-aw's engine wiring reads. Safe to delete, or keep as the
human-readable source of truth you copy into `OPENAI_API_KEY`.

`GH_AW_GITHUB_TOKEN`, `GH_AW_GITHUB_MCP_SERVER_TOKEN`, `GH_AW_CI_TRIGGER_TOKEN`,
`NPM_REGISTRY_TOKEN` appear in generated lock references with fallbacks to `GITHUB_TOKEN`;
none is configured and none is required in this setup.

## Rotation notes

- `AGENTMEMORY_SECRET`: generate a new value, set it in the App Service settings
  **and** the org secret, restart the app.
- `GH_PAT` expires 2027-08-29. Renew at Settings, Developer Settings, Fine-grained
  tokens, resource owner PlainConceptsPlatform (the org permission "Self-hosted
  runners" only appears once that owner is selected, and the enterprise SSO gate
  must be authorized). Update the app setting, restart the app.
- `WEBHOOK_SECRET` / `VM_TOKEN`: random hex; on rotation update the app settings
  plus, respectively, the org webhook config and the VMSS custom data.
- `Platform Agents Pro` client secret transited chat during setup: still worth
  rotating in the app registration; nothing in the runner platform uses it anymore.
