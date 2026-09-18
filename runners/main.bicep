// Runner platform, complete: network, ephemeral runner scale set, AgentMemory App Service.
// Reproduces what was built by hand on 2026-08-27/28.
//
//   az deployment group create -g agentrunner-pro-rg-01 -f main.bicep \
//     -p adminPublicKey="$(cat ~/.ssh/id_rsa.pub)" \
//     -p agentMemorySecret="$(openssl rand -hex 32)" \
//     -p customData="$(base64 -w0 cloud-init.yaml)" \
//     -p galleryImageVersion="1.0.0"  # use pre-baked image; omit for Ubuntu fallback
//
// Not covered here, by design:
//  - the Entra app (Platform Agents Pro): directory-level, made in the portal
//  - role assignment: the scaler app's managed identity (agentrunner-scaler-01) needs
//    "Virtual Machine Contributor" on this RG
//  - the org webhook and the scaler app's code deploy (zip): see README.md
//  - GitHub org secrets (AGENTMEMORY_SECRET, BOT_*)

@description('SSH public key for the VMSS admin user (never used interactively)')
param adminPublicKey string

@description('HMAC secret shared with the AGENTMEMORY_SECRET org secret')
@secure()
param agentMemorySecret string

@description('base64 of cloud-init.yaml (with __VM_TOKEN__ already substituted)')
param customData string

@description('Gallery image VERSION (e.g. 1.0.0) for the pre-baked runner image. Empty = Canonical marketplace image. WARNING: the image and customData must always move TOGETHER - the slim cloud-init assumes a baked image, the original cloud-init assumes a marketplace image.')
param galleryImageVersion string = ''

@description('Fine-grained PAT, sole grant org "Self-hosted runners: rw"')
@secure()
param ghPat string

@description('HMAC secret shared with the org workflow_job webhook')
@secure()
param webhookSecret string

@description('Bearer VMs use against /vm/jit and /vm/done; same value substituted into customData')
@secure()
param vmToken string

param location string = resourceGroup().location
param vmSku string = 'Standard_D4ads_v5'
param agentMemoryVersion string = '0.9.28'
param iiiVersion string = '0.11.2'

// ---------- network (allowed types only: no LB, no NAT gateway - org policy) ----------
resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'agentrunner-pro-nsg-01'
  location: location
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
    ]
  }
}

// The gallery lives in gallery.bicep, deployed once and separately, so a main.bicep deployment (live VMSS, capacity drift) can never create or update it.

// ---------- ephemeral runner fleet ----------
resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-03-01' = {
  name: 'agentrunner-vmss-01'
  location: location
  sku: { name: vmSku, tier: 'Standard', capacity: 0 }
  identity: { type: 'SystemAssigned' }
  properties: {
    orchestrationMode: 'Uniform'
    // FIX-01: overprovision creates "losing" instances that are real VMs. They boot,
    // pass the scaler's live-instance check, can be handed a single-use JIT registration,
    // then get force-deleted by Azure mid-job. The slow boot used to hide this (losers
    // died before setup finished); a fast baked-image boot activates it. Set-level,
    // PATCHable, applies to the next scale-out only.
    overprovision: false
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
        imageReference: galleryImageVersion == '' ? {
          publisher: 'Canonical'
          offer: 'ubuntu-24_04-lts'
          sku: 'server'
          version: 'latest'
        } : {
          id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/agentrunner-pro-rg-01/providers/Microsoft.Compute/galleries/agentrunner-gallery-01/images/agents-arc-runner/versions/${galleryImageVersion}'
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
                      name: 'instancepublicip'
                      properties: { idleTimeoutInMinutes: 10 }
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
  name: 'agentmemory-plan-01'
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
      appCommandLine: 'bash /home/start.sh' 
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

resource scaler 'Microsoft.Web/sites@2023-12-01' = {
  name: 'agentrunner-scaler-01'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOTNETCORE|10.0'
      ftpsState: 'Disabled'
      alwaysOn: true
      appSettings: [
        { name: 'GH_PAT', value: ghPat }
        { name: 'GH_ORG', value: 'PlainConceptsPlatform' }
        { name: 'WEBHOOK_SECRET', value: webhookSecret }
        { name: 'VM_TOKEN', value: vmToken }
        { name: 'AZ_SUBSCRIPTION', value: subscription().subscriptionId }
        { name: 'AZ_RG', value: resourceGroup().name }
        { name: 'AZ_VMSS', value: vmss.name }
        { name: 'RUNNER_LABEL', value: 'agents-arc' }
        { name: 'RUNNER_GROUP_ID', value: '6' }
      ]
    }
  }
}

// Virtual Machine Contributor for the scaler's identity: scale the VMSS, delete
// instances. Deploying this resource needs Owner or User Access Administrator on
// the RG; anyone else must ask IT for this one assignment (see README).
resource scalerVmContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'agentrunner-scaler-01', 'vm-contributor')
  scope: resourceGroup()
  properties: {
    principalId: scaler.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '9980e02c-c2be-4d73-94e8-173b1dc7cf3c')
  }
}

output vmssIdentityPrincipalId string = vmss.identity.principalId
output agentMemoryUrl string = 'https://${agentMemory.properties.defaultHostName}'
output scalerUrl string = 'https://${scaler.properties.defaultHostName}'
output scalerPrincipalId string = scaler.identity.principalId
