#!/bin/bash
# Fleet scaler. Runs on every instance from a systemd timer; only the leader (lowest
# instance id) acts, so there is no race. Scales the VMSS with the managed identity:
# out when queued agents-arc jobs exceed available runners, in when instances sit
# idle, never below MIN. No GitHub workflow is involved.
set -uo pipefail
ORG=PlainConceptsPlatform
RG=agentrunner-pro-rg-01
VMSS=agentrunner-vmss-01
MIN=1
MAX=4
REPOS="Numa Odissey"
PAT=$(cat /opt/runner/.pat) || exit 0
IDLE_GRACE_FILE=/opt/runner/.idle-since

api() { curl -fsSL -H "Authorization: Bearer $PAT" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

az login --identity --allow-no-subscriptions -o none 2>/dev/null || exit 0

# leader election: lowest instance id currently in the set
MYID=$(curl -fsSL -H Metadata:true "http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text" | grep -oE '[0-9a-f]+$')
IDS=$(az vmss list-instances -g "$RG" -n "$VMSS" --query "[].instanceId" -o tsv | tr -d '\r' | sort -n)
LEADER=$(echo "$IDS" | head -1)
MYNUM=$(az vmss list-instances -g "$RG" -n "$VMSS" --query "[?contains(osProfile.computerName, '$(hostname)')].instanceId | [0]" -o tsv | tr -d '\r')
[ "$MYNUM" = "$LEADER" ] || exit 0

# demand: queued jobs labeled agents-arc across both repos
Q=0
for R in $REPOS; do
  for RUN in $(api "https://api.github.com/repos/$ORG/$R/actions/runs?per_page=25" | jq -r '.workflow_runs[]|select(.status=="queued" or .status=="in_progress")|.id'); do
    N=$(api "https://api.github.com/repos/$ORG/$R/actions/runs/$RUN/jobs" | jq '[.jobs[]|select(.status=="queued" and (.labels|index("agents-arc")))]|length')
    Q=$((Q + ${N:-0}))
  done
done

RUNNERS_JSON=$(api "https://api.github.com/orgs/$ORG/actions/runners?per_page=100")
IDLE=$(echo "$RUNNERS_JSON" | jq '[.runners[]|select(.busy==false and .status=="online")]|length')
CAP=$(az vmss show -g "$RG" -n "$VMSS" --query sku.capacity -o tsv | tr -d '\r')
BOOTING=$((CAP - $(echo "$RUNNERS_JSON" | jq '[.runners[]|select(.status=="online")]|length')))
[ "$BOOTING" -lt 0 ] && BOOTING=0

echo "queued=$Q idle=$IDLE booting=$BOOTING cap=$CAP"

DEFICIT=$((Q - IDLE - BOOTING))
if [ "$DEFICIT" -gt 0 ]; then
  TARGET=$((CAP + DEFICIT)); [ "$TARGET" -gt "$MAX" ] && TARGET=$MAX
  if [ "$TARGET" -gt "$CAP" ]; then
    echo "scale out $CAP -> $TARGET"
    az vmss scale -g "$RG" -n "$VMSS" --new-capacity "$TARGET" -o none
  fi
  rm -f "$IDLE_GRACE_FILE"
  exit 0
fi

# scale in: surplus idle runners for 10 straight minutes; delete idle non-leader
# instances, never the leader, never below MIN
SURPLUS=$((IDLE - Q))
if [ "$CAP" -gt "$MIN" ] && [ "$SURPLUS" -gt 0 ]; then
  NOW=$(date +%s)
  SINCE=$(cat "$IDLE_GRACE_FILE" 2>/dev/null || echo "$NOW")
  [ -f "$IDLE_GRACE_FILE" ] || echo "$NOW" > "$IDLE_GRACE_FILE"
  if [ $((NOW - SINCE)) -ge 600 ]; then
    for VICTIM in $(echo "$IDS" | tail -n +2 | tac); do
      [ "$CAP" -le "$MIN" ] && break
      VMNAME=$(az vmss list-instances -g "$RG" -n "$VMSS" --query "[?instanceId=='$VICTIM'].osProfile.computerName | [0]" -o tsv | tr -d '\r')
      BUSY=$(echo "$RUNNERS_JSON" | jq --arg n "vmss-$VMNAME" '[.runners[]|select(.name==$n and .busy==true)]|length')
      if [ "${BUSY:-0}" -eq 0 ]; then
        echo "scale in: deleting idle instance $VICTIM ($VMNAME)"
        az vmss delete-instances -g "$RG" -n "$VMSS" --instance-ids "$VICTIM" -o none
        CAP=$((CAP - 1))
      fi
    done
    rm -f "$IDLE_GRACE_FILE"
  fi
else
  rm -f "$IDLE_GRACE_FILE"
fi
