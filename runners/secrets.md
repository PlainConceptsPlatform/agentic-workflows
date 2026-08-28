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
| `FORGE_API_KEY` | every agent run | the **Forge key** (forge.plainconcepts.com), the only stored LLM credential; per-repo value (Numa and Odyssey differ) |

**One stored secret, three names.** gh-aw's generated locks read `OPENAI_API_KEY`,
`CODEX_API_KEY` and `COPILOT_GITHUB_TOKEN`, but all three always held the same Forge
key. Every agent lock is `workflow_call`-only, so the secrets it sees are exactly what
the router passes, and the router aliases all three names to the one real secret at
each call site:

```yaml
    secrets:
      OPENAI_API_KEY: ${{ secrets.FORGE_API_KEY }}
      CODEX_API_KEY: ${{ secrets.FORGE_API_KEY }}
      COPILOT_GITHUB_TOKEN: ${{ secrets.FORGE_API_KEY }}
```

No lock rewriting is involved; gh-aw upgrades cannot break the mapping. The old
`OPENAI_API_KEY` / `CODEX_API_KEY` / `COPILOT_GITHUB_TOKEN` repo secrets were deleted
on 2026-08-28. If a workflow ever moves to the real Copilot engine (an actual GitHub
token, not a Forge key), give that call site its own secret instead of the alias.

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

`GH_AW_GITHUB_TOKEN`, `GH_AW_GITHUB_MCP_SERVER_TOKEN`, `GH_AW_CI_TRIGGER_TOKEN`,
`NPM_REGISTRY_TOKEN` appear in generated lock references with fallbacks to `GITHUB_TOKEN`;
none is configured and none is required in this setup.

## Generating every secret from scratch

How to recreate each value if it is lost, leaked, or expiring. `--org` commands need
`gh auth` with `admin:org`.

### `AGENTMEMORY_SECRET` (org secret + App Service setting, same value)

```bash
V=$(openssl rand -hex 32)
gh secret set AGENTMEMORY_SECRET --org PlainConceptsPlatform --visibility private --body "$V"
az webapp config appsettings set -g agentrunner-pro-rg-01 -n agentmemory-pro-01 --settings AGENTMEMORY_SECRET="$V"
az webapp restart -g agentrunner-pro-rg-01 -n agentmemory-pro-01
```

### `BOT_APP_ID` / `BOT_PRIVATE_KEY` (org secrets)

From the **platform-devbox** GitHub App: org Settings → Developer settings → GitHub
Apps → platform-devbox. `BOT_APP_ID` is the Client ID shown on that page.
`BOT_PRIVATE_KEY`: "Generate a private key" downloads a `.pem`; store its full text:

```bash
gh secret set BOT_APP_ID --org PlainConceptsPlatform --visibility private --body "<client id>"
gh secret set BOT_PRIVATE_KEY --org PlainConceptsPlatform --visibility private < platform-devbox.*.pem
```

### `GH_PAT` (scaler app setting)

Fine-grained PAT: github.com → Settings → Developer settings → Fine-grained tokens →
Generate. **Resource owner must be `PlainConceptsPlatform`** (the "Self-hosted
runners" permission is invisible until then), authorize the enterprise SSO gate when
prompted, Repository access: none needed, Organization permissions → Self-hosted
runners → **Read and write**. Then:

```bash
az webapp config appsettings set -g agentrunner-pro-rg-01 -n agentrunner-scaler-01 --settings GH_PAT="github_pat_..."
az webapp restart -g agentrunner-pro-rg-01 -n agentrunner-scaler-01
```

### `WEBHOOK_SECRET` (scaler app setting + org webhook, same value)

```bash
V=$(openssl rand -hex 32)
az webapp config appsettings set -g agentrunner-pro-rg-01 -n agentrunner-scaler-01 --settings WEBHOOK_SECRET="$V"
az webapp restart -g agentrunner-pro-rg-01 -n agentrunner-scaler-01
```

Then paste the same value into the org webhook: PlainConceptsPlatform → Settings →
Webhooks → the `agentrunner-scaler-01.azurewebsites.net/github` hook → Secret.

### `VM_TOKEN` (scaler app setting + VMSS custom data, same value)

```bash
V=$(openssl rand -hex 32)
az webapp config appsettings set -g agentrunner-pro-rg-01 -n agentrunner-scaler-01 --settings VM_TOKEN="$V"
az webapp restart -g agentrunner-pro-rg-01 -n agentrunner-scaler-01
sed "s/__VM_TOKEN__/$V/" cloud-init.yaml > /tmp/ci.yaml
az vmss update -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 \
  --set virtualMachineProfile.osProfile.customData="$(base64 -w0 /tmp/ci.yaml)" && rm /tmp/ci.yaml
```

Only instances created after the update use the new token; the fleet is ephemeral so
that is every future VM.

### `FORGE_API_KEY` (repo secret, per-repo values)

Issued by **Plain Concepts Forge** (forge.plainconcepts.com): create or rotate a key
per consuming repo there, then:

```bash
gh secret set FORGE_API_KEY --repo PlainConceptsPlatform/Numa --body "<forge key>"
```

Numa and Odyssey deliberately hold **different** key values. The router aliases this
one secret into every name the locks expect (see above); no other LLM secret exists.

### Deleting the retired ones

```bash
for s in AZURE_SCALER_CLIENT_ID AZURE_SCALER_CLIENT_SECRET AZURE_SCALER_SUBSCRIPTION_ID AZURE_SCALER_TENANT_ID RUNNER_SCALER_GH_TOKEN; do
  gh secret delete "$s" --org PlainConceptsPlatform
done
```

Deleting `RUNNER_SCALER_GH_TOKEN` removes only the org-secret copy; the PAT itself
lives on as the app's `GH_PAT` (same underlying token).

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
