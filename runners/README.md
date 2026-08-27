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

The service principal and the scale set's managed identity both need **Virtual Machine
Contributor** on `agentrunner-pro-rg-01`. The identity's grant is what lets a finished
instance delete itself.

## Why not AKS (yet)

The management-group policy assignment `Resources` ("Not allowed resource types",
definition `0a15ec92-a229-4763-bb14-0ea34a568f8d`, MG `3f0bfe2a-8abd-464d-aa27-57fc11146eb4`)
denies every resource AKS can use for node egress. Verified by real attempts, not docs:
Standard LB and NAT Gateway are policy-denied; `outbound none` demands an ACR bootstrap
cache; AKS rejects UDR combined with node public IPs. A VMSS with per-instance public IPs
and no load balancer is the allowed shape.

If a policy exemption for the AKS node RG ever lands, the `aks-nodes` subnet and the
`agentrunner-arc-rt-01` route table are already in place in `agentrunner-pro-rg-01`, and the
workflows need nothing: they only see the `agents-arc` label.

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
