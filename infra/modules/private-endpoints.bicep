// Private endpoints for the data-plane resources.
//
// Split into a module so the whole private-networking posture can be toggled by a single
// boolean in main.bicep, rather than by scattering `if (privateNetworking)` across every
// resource.

param location string
param tags object
param subnetId string
param keyVaultId string
param storageAccountId string

var keyVaultName = last(split(keyVaultId, '/'))
var storageName = last(split(storageAccountId, '/'))

resource keyVaultPe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${keyVaultName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv-connection'
        properties: {
          privateLinkServiceId: keyVaultId
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource blobPe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${storageName}-blob'
  location: location
  tags: tags
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob-connection'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['blob']
        }
      }
    ]
  }
}

output keyVaultPrivateEndpointId string = keyVaultPe.id
output blobPrivateEndpointId string = blobPe.id
