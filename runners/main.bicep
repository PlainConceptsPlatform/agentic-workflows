// Runner platform, complete: network, ephemeral runner scale set, AgentMemory App Service.
// Reproduces what was built by hand on 2026-08-27/28.
//
//   az deployment group create -g agentrunner-pro-rg-01 -f main.bicep \
//     -p adminPublicKey="$(cat ~/.ssh/id_rsa.pub)" \
//     -p agentMemorySecret="$(openssl rand -hex 32)" \
//     -p customData="$(base64 -w0 cloud-init.yaml)"
//
// Not covered here, by design:
//  - the Entra app (Platform Agents Pro) and its role assignments: directory-level, made in
//    the portal; grant the app SP and the VMSS identity "Virtual Machine Contributor" on this RG
//  - GitHub org secrets (AZURE_SCALER_*, RUNNER_SCALER_GH_TOKEN, AGENTMEMORY_SECRET)
//  - runner JIT registration: the runner-scaler workflow does that per job

@description('SSH public key for the VMSS admin user (never used interactively)')
param adminPublicKey string

@description('HMAC secret shared with the AGENTMEMORY_SECRET org secret')
@secure()
param agentMemorySecret string

@description('base64 of cloud-init.yaml')
param customData string

param location string = resourceGroup().location
param vmSku string = 'Standard_D2ads_v5'
param agentMemoryVersion string = '0.9.28'
param iiiVersion string = '0.11.2'

// ---------- network (allowed types only: no LB, no NAT gateway - org policy) ----------
resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'agentrunner-pro-nsg-01'
  location: location
}

resource routeTable 'Microsoft.Network/routeTables@2023-11-01' = {
  // kept for a future AKS attempt; free
  name: 'agentrunner-arc-rt-01'
  location: location
  properties: {
    routes: [
      {
        name: 'default-internet'
        properties: { addressPrefix: '0.0.0.0/0', nextHopType: 'Internet' }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'agentrunner-pro-vnet-01'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.60.0.0/16'] }
    subnets: [
      {
        name: 'runners'
        properties: {
          addressPrefix: '10.60.1.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
      {
        name: 'aks-nodes'
        properties: {
          addressPrefix: '10.60.8.0/22'
          routeTable: { id: routeTable.id }
        }
      }
    ]
  }
}

// ---------- ephemeral runner fleet ----------
resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-03-01' = {
  name: 'agentrunner-vmss-01'
  location: location
  sku: { name: vmSku, tier: 'Standard', capacity: 0 }
  identity: { type: 'SystemAssigned' }
  properties: {
    orchestrationMode: 'Uniform'
    upgradePolicy: { mode: 'Manual' }
    virtualMachineProfile: {
      osProfile: {
        computerNamePrefix: 'agent'
        adminUsername: 'azureuser'
        customData: customData
        linuxConfiguration: {
          disablePasswordAuthentication: true
          ssh: {
            publicKeys: [
              { path: '/home/azureuser/.ssh/authorized_keys', keyData: adminPublicKey }
            ]
          }
        }
      }
      storageProfile: {
        imageReference: {
          publisher: 'Canonical'
          offer: 'ubuntu-24_04-lts'
          sku: 'server'
          version: 'latest'
        }
        osDisk: {
          createOption: 'FromImage'
          diskSizeGB: 64
          caching: 'ReadOnly'
          diffDiskSettings: { option: 'Local', placement: 'ResourceDisk' }
        }
      }
      networkProfile: {
        networkInterfaceConfigurations: [
          {
            name: 'nic'
            properties: {
              primary: true
              ipConfigurations: [
                {
                  name: 'ipconfig'
                  properties: {
                    subnet: { id: '${vnet.id}/subnets/runners' }
                    publicIPAddressConfiguration: {
                      name: 'instance-pip'
                      properties: { idleTimeoutInMinutes: 15 }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
    }
  }
}

// ---------- AgentMemory ----------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'probe-plan'
  location: location
  kind: 'linux'
  sku: { name: 'B1' }
  properties: { reserved: true }
}

resource agentMemory 'Microsoft.Web/sites@2023-12-01' = {
  name: 'agentmemory-pro-01'
  location: location
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|node:22-bookworm'
      alwaysOn: true
      appCommandLine: 'bash -c "export HOME=/home; mkdir -p /home/.agentmemory/bin /home/opt && cd /home/opt && if [ ! -x /home/.agentmemory/bin/iii ]; then curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v${iiiVersion}/iii-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /home/.agentmemory/bin && chmod +x /home/.agentmemory/bin/iii; fi && [ -d node_modules/@agentmemory/agentmemory ] || npm install --no-audit --no-fund @agentmemory/agentmemory@${agentMemoryVersion} && export PATH=/home/.agentmemory/bin:$PATH && exec ./node_modules/.bin/agentmemory"'
      appSettings: [
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'WEBSITES_PORT', value: '3111' }
        { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '900' }
        { name: 'AGENTMEMORY_DATA_DIR', value: '/home/data' }
        { name: 'AGENTMEMORY_SECRET', value: agentMemorySecret }
        { name: 'CI', value: 'true' }
      ]
    }
  }
}

output vmssIdentityPrincipalId string = vmss.identity.principalId
output agentMemoryUrl string = 'https://${agentMemory.properties.defaultHostName}'
