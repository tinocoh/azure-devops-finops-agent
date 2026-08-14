// Azure DevOps FinOps & Delivery Intelligence — KPI server infrastructure.
//
// Deploys the analytical back end that Copilot Studio calls over MCP, and that the dashboard
// calls over REST. The Copilot Studio agent itself is not deployed here: it is a Power
// Platform resource, promoted through solutions (see copilot-studio/README.md).
//
// Security posture, by default:
//   - no secrets anywhere; workload identity federation and managed identity throughout
//   - no public ingress when privateNetworking is enabled
//   - customer-managed key optional but wired
//   - read-only RBAC on Azure DevOps and Cost Management — the agent cannot change anything

targetScope = 'resourceGroup'

@description('Base name for all resources. Keep short; used as a prefix.')
@minLength(3)
@maxLength(12)
param name string

@description('Deployment environment.')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region.')
param location string = resourceGroup().location

@description('Azure DevOps organisation the agent reports on.')
param adoOrganization string

@description('Subscriptions whose Azure cost is attributed to Azure DevOps projects. Empty disables the cloud FinOps domain.')
param costSubscriptionIds array = []

@description('Deploy with private endpoints and no public ingress. Strongly recommended for prod.')
param privateNetworking bool = (environment == 'prod')

@description('Existing virtual network resource id. Required when privateNetworking is true.')
param vnetResourceId string = ''

@description('Subnet name for private endpoints, within the supplied VNet.')
param privateEndpointSubnetName string = 'snet-private-endpoints'

@description('Subnet name delegated to Power Platform, so Copilot Studio can reach the MCP server privately.')
param powerPlatformSubnetName string = 'snet-power-platform'

@description('Container image for the KPI server.')
param containerImage string = 'ghcr.io/tinocodemos/ado-kpi-mcp-server:latest'

@description('Optional Key Vault key id for customer-managed encryption.')
param customerManagedKeyId string = ''

@description('Log retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 90

@description('Minimum replicas. Set above zero in prod to avoid cold starts on the first question of the day.')
@minValue(0)
param minReplicas int = (environment == 'prod') ? 2 : 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 10

param tags object = {}

// ── naming ───────────────────────────────────────────────────────────────────────
var suffix = uniqueString(resourceGroup().id, name, environment)
var shortSuffix = substring(suffix, 0, 6)

var names = {
  identity: 'id-${name}-${environment}'
  logAnalytics: 'log-${name}-${environment}'
  appInsights: 'appi-${name}-${environment}'
  keyVault: 'kv-${name}${shortSuffix}'
  containerEnv: 'cae-${name}-${environment}'
  containerApp: 'ca-${name}-mcp-${environment}'
  storage: 'st${name}${shortSuffix}'
}

var commonTags = union(tags, {
  application: 'ado-finops-delivery-intelligence'
  component: 'kpi-mcp-server'
  environment: environment
  'azd-env-name': environment
  managedBy: 'bicep'
})

// ── identity ─────────────────────────────────────────────────────────────────────
// A user-assigned identity is used rather than system-assigned so that the Azure DevOps
// and Cost Management role assignments survive a redeploy of the container app.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.identity
  location: location
  tags: commonTags
}

// ── observability ────────────────────────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logAnalytics
  location: location
  tags: commonTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
    publicNetworkAccessForIngestion: privateNetworking ? 'Disabled' : 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: names.appInsights
  location: location
  tags: commonTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
    // Query strings can carry project and team names; disabling IP masking would be a
    // needless personal-data exposure for a metrics service.
    DisableIpMasking: false
    publicNetworkAccessForIngestion: privateNetworking ? 'Disabled' : 'Enabled'
  }
}

// ── key vault ────────────────────────────────────────────────────────────────────
// Holds no application secrets by design. It exists for the customer-managed key and for
// operator-supplied reference data that is commercially sensitive (rate cards).
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.keyVault
  location: location
  tags: commonTags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: privateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// ── storage (reference data + KPI snapshots) ─────────────────────────────────────
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: names.storage
  location: location
  tags: commonTags
  sku: { name: environment == 'prod' ? 'Standard_ZRS' : 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // managed identity only
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: privateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
    encryption: {
      requireInfrastructureEncryption: true
      keySource: empty(customerManagedKeyId) ? 'Microsoft.Storage' : 'Microsoft.Keyvault'
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource referenceDataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'reference-data'
  properties: { publicAccess: 'None' }
}

// ── container app environment ────────────────────────────────────────────────────
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: names.containerEnv
  location: location
  tags: commonTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: privateNetworking ? {
      internal: true
      infrastructureSubnetId: '${vnetResourceId}/subnets/${powerPlatformSubnetName}'
    } : null
    zoneRedundant: environment == 'prod'
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ── the KPI server ───────────────────────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: names.containerApp
  location: location
  tags: union(commonTags, { 'azd-service-name': 'mcp-server' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: !privateNetworking
        targetPort: 8787
        transport: 'http'
        allowInsecure: false
        // Streamable HTTP holds the response open; sticky sessions keep an MCP session
        // pinned to the replica that owns it.
        stickySessions: { affinity: 'sticky' }
        corsPolicy: {
          allowedOrigins: [dashboardOrigin]
          allowedMethods: ['GET', 'POST', 'OPTIONS']
          allowedHeaders: ['content-type', 'authorization', 'mcp-session-id']
          allowCredentials: false
        }
      }
      // No secrets block. Authentication is federated; there is nothing to store.
    }
    template: {
      containers: [
        {
          name: 'kpi-server'
          image: containerImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'DATA_MODE', value: 'live' }
            { name: 'MCP_TRANSPORT', value: 'http' }
            { name: 'PORT', value: '8787' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'ADO_ORGANIZATION', value: adoOrganization }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'AZURE_TENANT_ID', value: subscription().tenantId }
            { name: 'AZURE_COST_SUBSCRIPTIONS', value: join(costSubscriptionIds, ',') }
            { name: 'ALLOWED_ORIGINS', value: dashboardOrigin }
            { name: 'REFERENCE_DATA_DIR', value: '/app/reference-data' }
            { name: 'MAX_ROWS', value: '20000' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'NODE_ENV', value: 'production' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 8787 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 8787 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

@description('Origin permitted to call the REST API. Set to the dashboard host.')
param dashboardOrigin string = 'https://localhost:5173'

// ── RBAC ─────────────────────────────────────────────────────────────────────────
// Read-only by design. The agent is not capable of changing a budget, a work item or a
// resource, because it is never granted a role that would allow it.

var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3' // Cost Management Reader
var monitoringReaderRoleId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'     // Monitoring Reader
var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'       // Storage Blob Data Reader
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'  // Key Vault Secrets User

resource costReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, identity.id, costManagementReaderRoleId)
  scope: resourceGroup()
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
  }
}

resource monitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, monitoringReaderRoleId)
  scope: resourceGroup()
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringReaderRoleId)
  }
}

resource blobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, blobDataReaderRoleId)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

// ── private endpoints ────────────────────────────────────────────────────────────
module privateEndpoints 'modules/private-endpoints.bicep' = if (privateNetworking) {
  name: 'private-endpoints'
  params: {
    location: location
    tags: commonTags
    subnetId: '${vnetResourceId}/subnets/${privateEndpointSubnetName}'
    keyVaultId: keyVault.id
    storageAccountId: storage.id
  }
}

// ── budget guardrail ─────────────────────────────────────────────────────────────
// A FinOps product that does not budget its own consumption would be difficult to defend.

@description('Budget start date. Must be the first of a month. Defaults to the current month.')
param budgetStartDate string = '${substring(utcNow('yyyy-MM-dd'), 0, 8)}01'

@description('Email addresses notified when the budget threshold is reached. Role-based contacts alone do not satisfy the API contract.')
param budgetContactEmails array = []

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'budget-${name}-${environment}'
  properties: {
    category: 'Cost'
    amount: environment == 'prod' ? 500 : 100
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      forecastExceeded: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        contactEmails: budgetContactEmails
        contactRoles: ['Owner', 'Contributor']
        thresholdType: 'Forecasted'
      }
      actualExceeded: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        contactEmails: budgetContactEmails
        contactRoles: ['Owner']
        thresholdType: 'Actual'
      }
    }
  }
}

// ── outputs ──────────────────────────────────────────────────────────────────────
output mcpEndpoint string = privateNetworking
  ? 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp (private)'
  : 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp'
output restEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/api'
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output keyVaultName string = keyVault.name
output storageAccountName string = storage.name
output nextSteps string = 'Grant the managed identity Azure DevOps Analytics (read) access, then run copilot-studio/scripts/post-deploy.ps1.'
