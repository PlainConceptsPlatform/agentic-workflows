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
                                            │  cloud-init: one job at a time, reused
                                            ▼
                              VM asks /vm/jit ► runs a job ► resets state ► asks again
                              ► idle 5 min ► /vm/done ► deleted
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
- One VM runs **one job at a time** on its own local Docker Engine; two agentic
  workflows never share a VM. A VM serves **consecutive** jobs rather than one, and
  resets Docker state between them, then retires after 5 minutes idle (2 minutes if
  it never got work), 20 jobs, or 85% disk.
- Why reuse: gh-aw locks split a run into many stages of a few seconds each, while a
  VM needs about three minutes to boot. Measured on 2026-08-28, one VM per stage put
  roughly 78% of billed time into booting (14 VMs, ~12 min of real work across ~45 min
  of VM life) and added that wait to every stage. Each JIT registration is still
  single-use and ephemeral; only the host is reused.
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
- Budget `runner-platform-200` on the resource group emails the platform owner
  at 80% actual, 100% actual, 100% forecast.

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
then `runner-job.service` runs `job.sh`, which loops: request a JIT config from the
scaler, run `run.sh --jitconfig` for exactly one job, reset Docker state (awf uses
fixed container names, so a leftover would collide by name), ask again. It reports
`/vm/done` and is deleted when the queue stays empty past the idle limit, at
`MAX_JOBS`, or when the disk crosses `DISK_LIMIT`. A VM that boots into no work at
all retires after 2 minutes, so stale demand cannot keep instances billing.

**`customData` is write-only.** `az vmss show` returns an empty string for it, so a
grep against that output proves nothing about what was deployed. Verify on an
instance instead:

```bash
az vmss run-command invoke -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --instance-id <id> --command-id RunShellScript --scripts 'grep -c MAX_JOBS /opt/runner/job.sh' --query "value[0].message" -o tsv
```

Model updates also block while instances churn: pass `--no-wait`. And a single stuck
instance can hold the whole set in `Failed` and reject model edits; delete that
instance first (`az vmss delete-instances --instance-ids <id>`).

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

## Break glass: manual runners

If the scaler app is down (or not yet authorized) and work must flow, register
persistent runners on manually-scaled instances. They serve jobs back to back, one
at a time, until removed — so tear them down as soon as the app is back.

```bash
az vmss scale -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --new-capacity 2
TOK=$(gh api -X POST orgs/PlainConceptsPlatform/actions/runners/registration-token --jq .token)
for id in $(az vmss list-instances -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --query "[].instanceId" -o tsv); do
  az vmss run-command invoke -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --instance-id "$id" \
    --command-id RunShellScript \
    --scripts "for i in \$(seq 1 120); do [ -f /opt/runner/.ready ] && break; sleep 5; done; cd /opt/actions-runner && sudo -u runner ./config.sh --unattended --url https://github.com/PlainConceptsPlatform --token $TOK --name interim-$id --labels agents-arc --runnergroup agentic --work _work --replace && ./svc.sh install runner && ./svc.sh start"
done
```

Tear-down: for each instance `./svc.sh stop && ./svc.sh uninstall && sudo -u runner
./config.sh remove --token $(gh api -X POST orgs/PlainConceptsPlatform/actions/runners/remove-token --jq .token)`,
then `az vmss scale --new-capacity 0` and delete any leftover offline registrations
with `gh api -X DELETE orgs/PlainConceptsPlatform/actions/runners/<id>`.

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
