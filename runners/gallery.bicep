// Azure Compute Gallery + image definition for pre-baked runner images.
//
//   az deployment group create -g agentrunner-pro-rg-01 -f gallery.bicep \
//     -p location="westeurope"
//
// The gallery is created once. Images are published by Packer (build-image.pkr.hcl)
// into the definition "agents-arc-runner". main.bicep references the latest version
// from this gallery; pin a specific version by passing galleryImageVersion.

@description('Azure region for the gallery (must match the VMSS region)')
param location string = resourceGroup().location

@description('Gallery image definition name')
param imageDefinitionName string = 'agents-arc-runner'

// ---------- Compute Gallery ----------
resource gallery 'Microsoft.Compute/galleries@2023-11-01' = {
  name: 'agentrunner-gallery-01'
  location: location
  properties: {
    description: 'Pre-baked runner images for the agents-arc VMSS fleet'
  }
}

resource imageDefinition 'Microsoft.Compute/galleries/images@2023-03-01' = {
  name: imageDefinitionName
  location: location
  parent: gallery
  properties: {
    osState: 'Generalized'
    osType: 'Linux'
    hyperVGeneration: 'V2'
    features: [{ name: 'SecurityType', value: 'TrustedLaunchSupported' }]
    identifier: { publisher: 'plainconcepts', offer: 'agents-arc', sku: 'runner' }
  }
}

output galleryName string = gallery.name
output galleryResource string = gallery.id
output imageDefinitionName string = imageDefinition.name
output imageDefinitionId string = imageDefinition.id
