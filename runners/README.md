# Runner platform

Ephemeral GitHub Actions runners for the `agents-arc` label on Azure VM Scale Sets,
scaled by a small .NET app instead of workflows. Cost beats latency by design.

## Topology

```
GitHub org webhook (workflow_job) ──► agentrunner-scaler-01 (App Service, .NET)
                                            │  policy + ledger
                                            ▼
                              agentrunner-vmss-01 (VMSS, Uniform, D2ads_v5,
                              ephemeral OS disk, public IP per VM, capacity 0 at rest)
                                            │  cloud-init: one JIT runner, one job
                                            ▼
                              VM asks /vm/jit ► runs the job ► /vm/done ► deleted
```

Everything lives in `agentrunner-pro-rg-01`, which also hosts AgentMemory
(`agentmemory-pro-01`) and the shared B1 plan (`agentmemory-plan-01`) the scaler
app rides on for free.

## Scaling policy (hard rules)

| Demand (queued + running `agents-arc` jobs) | VMs |
|---|---|
| 0 | 0 |
| 1–4 | at most 1 |
| 5+ | at most 2 |

- `MAX_VMS = 2` is a compile-time constant in the app, clamped at every capacity
  write and re-verified after each one; a watchdog forces capacity back down if it
  ever reads more than 2. A third VM is never created automatically.
- Jobs beyond capacity wait in the GitHub queue on purpose.
- One VM hosts exactly one ephemeral JIT runner and executes exactly one job, with
  its own local Docker Engine, then is deleted. Two agentic workflows never share a
  VM.
- Demand comes from the org webhook (`workflow_job` events, label-filtered,
  private repos only), persisted as a job ledger in the app's `/home`. Missed
  webhooks self-heal: entries expire (queued 24h, in_progress 8h) and three
  fruitless VM boots with no job activity clear stale queued entries.

## Cost

- VM compute: $0 at rest; ~$0.115/h per running VM (D2ads_v5, ephemeral OS disk =
  no disk cost). Worst case 2 VMs 24/7 ≈ **$168/mo**.
- Scaler app: $0 extra (shares the existing AgentMemory B1 plan, ~$13/mo total).
- Public IPs: billed only while a VM exists, ≈ $6/mo worst case.
- **Worst case ≈ $187/mo, under the $200 target. Normal expected: $10–25/mo.**
- Budget `runner-platform-200` on the resource group emails
  quique.fernandez@plainconcepts.com at 80% actual, 100% actual, 100% forecast.

## The scaler app (`runners/scaler-app`)

.NET 10 minimal API, no external packages. Deployed as `agentrunner-scaler-01`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /github` | webhook HMAC | workflow_job events update the ledger, trigger evaluate |
| `POST /vm/jit` | VM bearer token | live instance asks for a JIT config; 204 when no demand |
| `POST /vm/done` | VM bearer token | instance reports finished; app deletes it, boots next if needed |
| `GET /status` | VM bearer token | demand, capacity, instances, ledger |
| `GET /healthz` | none | liveness |

App settings: `GH_PAT` (fine-grained PAT, sole grant org "Self-hosted runners: rw",
expires 2027-08-29), `GH_ORG`, `WEBHOOK_SECRET`, `VM_TOKEN`, `AZ_SUBSCRIPTION`,
`AZ_RG`, `AZ_VMSS`, `RUNNER_LABEL`, `RUNNER_GROUP_ID`. Azure access uses the app's
system-assigned managed identity (Virtual Machine Contributor on the RG).

Deploy an update:

```bash
cd runners/scaler-app
dotnet publish -c Release -o out && cd out && python -c "import shutil; shutil.make_archive('../scaler','zip','.')"
az webapp deploy -g agentrunner-pro-rg-01 -n agentrunner-scaler-01 --src-path ../scaler.zip --type zip
```

## VM lifecycle (`runners/cloud-init.yaml`)

cloud-init installs docker-ce + compose, gh, az, trivy, jq and the actions runner,
then `runner-job.service` runs `job.sh`: request a JIT config from the scaler, run
`run.sh --jitconfig` for at most one job, and call `/vm/done`. If GitHub hands the
runner nothing within 10 minutes the VM gives up and reports done anyway, so stale
demand cannot keep instances billing.

The repo copy has `__VM_TOKEN__` as a placeholder; the real value is only in the
VMSS model's custom data and the app settings. To rotate it: set a new value in
both places (`az webapp config appsettings set` + `az vmss update --set
virtualMachineProfile.osProfile.customData=...`).

## Operating

```bash
# state of everything (needs the VM token)
curl -s -H "Authorization: Bearer $VM_TOKEN" https://agentrunner-scaler-01.azurewebsites.net/status | jq

# app logs
az webapp log tail -g agentrunner-pro-rg-01 -n agentrunner-scaler-01

# fleet
az vmss show -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --query sku.capacity
az vmss list-instances -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 -o table

# emergency stop
az vmss scale -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --new-capacity 0
az webapp stop -g agentrunner-pro-rg-01 -n agentrunner-scaler-01
```

## Why not X

- **ARC / runner scale sets**: Kubernetes only; AKS is blocked by the management
  group's "Not allowed resource types" policy (load balancers, NAT gateways denied;
  every AKS outbound mode needs one).
- **KEDA on Container Apps Jobs**: the native queue-driven option, but Container
  Apps forbids privileged containers, and gh-aw's awf firewall needs a real Docker
  daemon. Dead end for this workload.
- **Azure native VMSS autoscale**: scales on metrics or schedules only. At capacity
  0 there is no metric to cross, and GitHub's queue is invisible to Azure Monitor.
- **B-series (burstable) VMs**: no ephemeral OS disk support, and fresh instances
  have no CPU credits, so CI jobs run at the ~40% baseline: slower jobs bill more
  minutes than the discount saves.
- **Workflow-based scaler** (the previous design): polled instead of reacting,
  lived per-repo while managing a global resource, raced against itself from two
  repos, and needed org secrets in repos. Replaced by the app on 2026-08-28.

## IAM

The RG has these role assignments (Portal: resource group → Access control (IAM) →
Add role assignment):

| Principal | Role | Why |
|---|---|---|
| `agentrunner-scaler-01` (managed identity) | Virtual Machine Contributor | scale the VMSS, delete instances |
| `Platform Agents Pro` (app registration) | Contributor | infra automation from this machine |

When adding the managed identity, pick "Managed identity" in the member picker and
select App Service → agentrunner-scaler-01; a plain name search will not find it.
Verify with:

```bash
az role assignment list --resource-group agentrunner-pro-rg-01 -o table
```

Failure symptom when the grant is missing: `/status` works but every capacity
change logs `AuthorizationFailed` and the fleet stays at 0 while demand grows.

## GitHub side

- Org webhook: `https://agentrunner-scaler-01.azurewebsites.net/github`,
  content type `application/json`, secret = the app's `WEBHOOK_SECRET`, single
  event **Workflow jobs**. Org → Settings → Webhooks.
- Runner group `agentic` (id 6), `allows_public_repositories=false`; JIT runners
  are minted into it with the `agents-arc` label.
- Secrets inventory: see [secrets.md](secrets.md).
