<#
.SYNOPSIS
    Applies the Copilot Studio settings that solutions do not carry.

.DESCRIPTION
    Power Platform solutions are not a complete representation of a Copilot Studio agent.
    The following are excluded and must be re-applied after every environment promotion:

      - Application Insights connection string
      - Manual authentication settings (Entra ID app registration, federated credential)
      - Direct Line and web channel security
      - Sharing permissions

    This gap is the single largest weakness in Copilot Studio ALM (see ADR-0001). Scripting
    it here means the settings are still reviewable, diffable and repeatable even though
    they cannot travel inside the solution artefact.

    The script is idempotent: running it twice produces the same end state.

.PARAMETER EnvironmentUrl
    Target Dataverse environment, e.g. https://contoso-prod.crm4.dynamics.com

.PARAMETER AgentSchemaName
    Schema name of the Copilot Studio agent (bot) record.

.PARAMETER Settings
    Path to the environment settings file. See ./settings/prod.example.json.

.EXAMPLE
    ./post-deploy.ps1 -EnvironmentUrl https://contoso-prod.crm4.dynamics.com `
                      -AgentSchemaName cr123_adoFinOpsDeliveryIntelligence `
                      -Settings ./settings/prod.json
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$EnvironmentUrl,
    [Parameter(Mandatory)][string]$AgentSchemaName,
    [Parameter(Mandatory)][string]$Settings
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string]$Message) Write-Host "  → $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  ✓ $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

# ── preflight ────────────────────────────────────────────────────────────────────
if (-not (Get-Command pac -ErrorAction SilentlyContinue)) {
    throw "Power Platform CLI (pac) not found. Install with: dotnet tool install --global Microsoft.PowerApps.CLI.Tool"
}

if (-not (Test-Path $Settings)) {
    throw "Settings file not found: $Settings"
}

$config = Get-Content $Settings -Raw | ConvertFrom-Json

foreach ($required in @('mcpEndpoint', 'defaultOrganization', 'entraClientId', 'tenantId', 'dashboardOrigin')) {
    if (-not $config.PSObject.Properties.Name.Contains($required) -or [string]::IsNullOrWhiteSpace($config.$required)) {
        throw "Settings file is missing required key '$required'."
    }
}

# A secret in a settings file would defeat the federated-credential design.
foreach ($property in $config.PSObject.Properties) {
    if ($property.Name -match 'secret|password|pat|key' -and -not [string]::IsNullOrWhiteSpace($property.Value)) {
        throw "Settings file contains what looks like a secret ('$($property.Name)'). This deployment uses workload identity federation; no secret should ever be stored here."
    }
}

Write-Host "`nPost-deployment configuration" -ForegroundColor White
Write-Host "  environment  $EnvironmentUrl"
Write-Host "  agent        $AgentSchemaName`n"

# ── 1. authenticate ──────────────────────────────────────────────────────────────
Write-Step 'Selecting Power Platform environment'
if ($PSCmdlet.ShouldProcess($EnvironmentUrl, 'pac org select')) {
    pac org select --environment $EnvironmentUrl | Out-Null
    Write-Ok 'Environment selected'
}

# ── 2. environment variables (solution-aware, but values are per-environment) ────
Write-Step 'Setting environment variable values'
$variables = @{
    'adoKpi_mcpEndpoint'         = $config.mcpEndpoint
    'adoKpi_defaultOrganization' = $config.defaultOrganization
    'adoKpi_defaultPeriod'       = if ($config.PSObject.Properties.Name -contains 'defaultPeriod') { $config.defaultPeriod } else { 'last 90 days' }
    'adoKpi_dashboardUrl'        = $config.dashboardOrigin
}

foreach ($entry in $variables.GetEnumerator()) {
    if ($PSCmdlet.ShouldProcess($entry.Key, 'set environment variable')) {
        pac env write-env-value --name $entry.Key --value $entry.Value 2>&1 | Out-Null
        Write-Ok "$($entry.Key) = $($entry.Value)"
    }
}

# ── 3. Application Insights (NOT solution-aware) ─────────────────────────────────
Write-Step 'Configuring Application Insights'
if ([string]::IsNullOrWhiteSpace($config.appInsightsConnectionString)) {
    Write-Warn 'No Application Insights connection string supplied — telemetry will not be captured.'
}
elseif ($PSCmdlet.ShouldProcess($AgentSchemaName, 'set Application Insights connection string')) {
    # Conversation transcript text is intentionally NOT logged: these conversations quote
    # team-level performance data and, for the profitability domain, commercial figures.
    $body = @{
        applicationinsightsconnectionstring = $config.appInsightsConnectionString
        logconversationdetails              = $false
    } | ConvertTo-Json -Compress

    pac data update --entity bot --schema-name $AgentSchemaName --data $body 2>&1 | Out-Null
    Write-Ok 'Application Insights configured (transcript logging disabled)'
}

# ── 4. Direct Line trusted origins (NOT solution-aware) ──────────────────────────
Write-Step 'Configuring Direct Line channel security'
if ($PSCmdlet.ShouldProcess($config.dashboardOrigin, 'add trusted origin')) {
    Write-Warn 'Direct Line enhanced authentication and trusted origins must be confirmed in the maker portal:'
    Write-Host "      Settings → Security → Web channel security" -ForegroundColor DarkGray
    Write-Host "      Enable enhanced authentication, add origin: $($config.dashboardOrigin)" -ForegroundColor DarkGray
    Write-Host "      This is not exposed by pac CLI at time of writing." -ForegroundColor DarkGray
}

# ── 5. authentication (NOT solution-aware) ───────────────────────────────────────
Write-Step 'Verifying manual authentication configuration'
Write-Warn 'Manual authentication must be confirmed in the maker portal:'
Write-Host "      Settings → Security → Authentication → Authenticate manually" -ForegroundColor DarkGray
Write-Host "      Provider:      Microsoft Entra ID v2 with federated credentials" -ForegroundColor DarkGray
Write-Host "      Client ID:     $($config.entraClientId)" -ForegroundColor DarkGray
Write-Host "      Tenant:        $($config.tenantId)" -ForegroundColor DarkGray
Write-Host "      Scopes:        499b84ac-1321-427f-aa17-267ca6975798/user_impersonation" -ForegroundColor DarkGray
Write-Host "                     https://management.azure.com/user_impersonation" -ForegroundColor DarkGray

# ── 6. sharing ───────────────────────────────────────────────────────────────────
Write-Step 'Verifying sharing scope'
if ([string]::IsNullOrWhiteSpace($config.securityGroupId)) {
    Write-Warn 'No security group configured. The agent must NOT be shared with the whole organisation: the team and profitability domains are commercially and employment sensitive.'
}
else {
    Write-Ok "Share with security group $($config.securityGroupId) (apply in maker portal → Share)"
}

# ── 7. verification ──────────────────────────────────────────────────────────────
Write-Host "`nRun ./verify-agent.ps1 to assert the deployed agent matches agent.yaml.`n" -ForegroundColor White
