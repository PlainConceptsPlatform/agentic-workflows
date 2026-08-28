# Runner platform: ephemeral VM Scale Set

Every `agents-arc` job runs on its own short-lived Azure VM from the scale set
`agentrunner-vmss-01` in `agentrunner-pro-rg-01` (North Europe). One VM, one job, then the
instance is deleted. There is no shared host, so nothing that plagued the single-VM era can
happen: no port claims, no fixed container names colliding, no shared `/tmp`, no lock.

| | |
|---|---|
| Scale set | `agentrunner-vmss-01`, Standard_D2ads_v5, ephemeral OS disk, per-instance public IP, no LB |
| Bootstrap | [`cloud-init.yaml`](cloud-init.yaml): docker-ce + compose plugin, gh, git, jq, actions runner |
| Registration | org-level JIT config into runner group `agentic`, label `agents-arc`, single job by construction |
| Autoscaling | [`runner-scaler.yml`](../loops/workflows/runner-scaler.yml) on `workflow_job` events: queued grows (cap 4), completed reaps |
| Idle cost | $0 compute: capacity rests at 0, the VMSS object is free, ephemeral disks are free |
| Running cost | ~$0.115/h per concurrent job (VM) plus ~$0.005/h per instance IP |

## Credentials

| Secret (org, private repos) | What it is |
|---|---|
| `AZURE_SCALER_CLIENT_ID` / `TENANT_ID` / `SUBSCRIPTION_ID` / `CLIENT_SECRET` | the `Platform Agents Pro` service principal the scaler logs in with |
| `RUNNER_SCALER_GH_TOKEN` | fine-grained PAT, org permission "Self-hosted runners: read and write", used only to mint JIT configs |
| `AGENTMEMORY_SECRET` | HMAC secret shared with the AgentMemory App Service, see [`mcp.md`](mcp.md) |

The full audited list, including per-repo secrets and what is safe to delete, lives in [`secrets.md`](secrets.md).

### Role assignments (IAM)

Two members need **Virtual Machine Contributor** on `agentrunner-pro-rg-01`, and without
them the platform degrades to manual scaling:

| Member | Why | IAM picker detail |
|---|---|---|
| `Platform Agents Pro` (service principal) | the scaler workflow logs in as it to grow and reap the fleet | Members type **User, group, or service principal**, search by name |
| `agentrunner-vmss-01` (managed identity) | a finished VM deletes itself through it | Members type **Managed identity** → category *Virtual machine scale set* — it does not appear in the normal people search |

Portal path: Resource groups → `agentrunner-pro-rg-01` → Access control (IAM) → Add →
Add role assignment → role **Virtual Machine Contributor** → add each member → Review + assign.

Verify:

```bash
az role assignment list   --scope /subscriptions/c63519b4-84a6-448c-b0e6-4ebef696b8ff/resourceGroups/agentrunner-pro-rg-01   --query "[?roleDefinitionName=='Virtual Machine Contributor'].principalName" -o tsv
```

Symptoms when missing: the runner-scaler run fails at `azure/login`'s first az call with
`AuthorizationFailed`, and finished VMSS instances linger instead of deleting themselves.

## The proven pipeline

The platform's first fully autonomous cycle completed on 2026-08-28: Numa issue #540 was
labelled `implement`, the router dispatched the agent to a fresh ephemeral VM, the agent
implemented the change inside the awf sandbox, safe outputs produced PR #579, CI ran on more
ephemeral VMs, and merge-gate merged it and closed the issue. No human touched anything
between the label and the merge.

## What fresh VMs taught us

Every one of these failed a real run first, because a long-lived host had hidden the
dependency. If a job dies with `command not found` or exit 127, start here:

| missing | fix now lives in |
|---|---|
| `docker compose` plugin | user-space install step in shared/opencode-ci.md |
| `gh` | cloud-init |
| `trivy` | cloud-init (trivy-action assumes the binary exists) |
| `dotnet` | `setup-dotnet` in shared steps, `DOTNET_INSTALL_DIR` in the tool cache |
| `node` for CI scripts | `setup-node` in the app-ci API job |
| `~/.dotnet/tools` on PATH | exported before `reportgenerator` runs |

And the inverse lesson: shared-host armour must not follow us here. Keying `/tmp/gh-aw` per
run silently broke `create_pull_request` (gh-aw's safeoutputs server writes the patch to its
hardcoded path), and per-runner ports broke the MCP gateway. One job per VM wants gh-aw
exactly as shipped.

## MCP state

Centralised AgentMemory and the per-repo CodeGraph index are covered in [`mcp.md`](mcp.md).

## Org policy constraints, for any future infra work

The management-group policy "Not allowed resource types" (assignment `Resources`) denies load
balancers and NAT gateways in this subscription, among others. Anything needing managed
egress infrastructure is off the table; VMs and scale sets with per-instance public IPs, App
Service, storage accounts and Container Apps are allowed (all verified by real creation
attempts). Probe with a throwaway resource before designing around anything else.

## Rebuilding from scratch

[`main.bicep`](main.bicep) reproduces the whole platform (network, scale set, AgentMemory):

```bash
az deployment group create -g agentrunner-pro-rg-01 -f main.bicep   -p adminPublicKey="$(cat ~/.ssh/id_rsa.pub)"   -p agentMemorySecret="$(openssl rand -hex 32)"   -p customData="$(base64 -w0 cloud-init.yaml)"
```

Afterwards the three manual, directory-level steps: grant Virtual Machine Contributor on the
RG to the `Platform Agents Pro` SP and to the VMSS identity (the template outputs its
principal id), and mirror `agentMemorySecret` into the `AGENTMEMORY_SECRET` org secret.

## Operating it

```bash
# fleet state
az vmss list-instances -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 -o table
gh api orgs/PlainConceptsPlatform/actions/runners --jq '.runners[]|"\(.name) \(.status) busy=\(.busy)"'

# manual runner, when the scaler is down (JIT = ephemeral, one job)
az vmss scale -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --new-capacity 1
jit=$(gh api -X POST orgs/PlainConceptsPlatform/actions/runners/generate-jitconfig \
  -f name=vmss-manual -F runner_group_id=6 -f 'labels[]=agents-arc' -f work_folder=_work \
  --jq .encoded_jit_config)
az vmss run-command invoke -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --instance-id <id> \
  --command-id RunShellScript \
  --scripts "systemd-run --unit=gha-runner --uid=runner --gid=runner --working-directory=/opt/actions-runner /opt/actions-runner/run.sh --jitconfig '$jit'"

# nothing left running? (hidden-cost check)
az vmss show -g agentrunner-pro-rg-01 -n agentrunner-vmss-01 --query sku.capacity
```

Instances that fail to self-delete (role missing, crash) are reaped by the scaler's
`completed` handler; if in doubt, `az vmss scale --new-capacity 0` deletes everything and
costs stop.

## History, shortest useful version

One D2ads_v5 VM ran four runner services sharing everything. gh-aw assumes one job per
host, so the era produced: port collisions, awf's fixed container names killing concurrent
jobs (host-wide `flock` as the cure), a shared `/tmp` with cross-user permission wars, and a
green run whose outputs were silently discarded. A k3s+ARC detour proved ephemeral DinD
pods work but awf chroots into the daemon host and refuses Alpine, and AKS was policy-blocked.
Ephemeral VMs give the strong isolation with none of the machinery. The wrapper rewrites in
`loops/scripts/compile-agent-workflows.mjs` each carry their own rationale; several exist
purely because of that shared-host era and are now harmless belt-and-braces.
