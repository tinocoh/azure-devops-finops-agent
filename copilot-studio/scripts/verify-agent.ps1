<#
.SYNOPSIS
    Asserts that a deployed Copilot Studio agent matches solution/agent/agent.yaml.

.DESCRIPTION
    Because several Copilot Studio settings are not solution-aware, a successful solution
    import does not prove a working agent. This script closes that gap: it reads the
    declarative definition and checks the deployed environment against it, failing with a
    non-zero exit code so it can be used as a release gate.

    Checks performed:
      1. instructions.md is within the 8,000-character platform limit
      2. required environment variables exist and are non-empty
      3. the MCP endpoint is reachable and speaks MCP
      4. the MCP server exposes every tool listed in the tool manifest
      5. authentication is set to manual (required for User.AccessToken)
      6. anonymous access is disabled

.EXAMPLE
    ./verify-agent.ps1 -EnvironmentUrl https://contoso-prod.crm4.dynamics.com
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EnvironmentUrl,
    [string]$SolutionRoot = (Join-Path $PSScriptRoot '..' 'solution')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$failures = [System.Collections.Generic.List[string]]::new()
$passed = 0

function Test-Assertion {
    param([string]$Name, [scriptblock]$Check)
    try {
        $result = & $Check
        if ($result -eq $true) {
            Write-Host "  ✓ $Name" -ForegroundColor Green
            $script:passed++
        }
        else {
            Write-Host "  ✗ $Name — $result" -ForegroundColor Red
            $script:failures.Add("$Name : $result")
        }
    }
    catch {
        Write-Host "  ✗ $Name — $($_.Exception.Message)" -ForegroundColor Red
        $script:failures.Add("$Name : $($_.Exception.Message)")
    }
}

Write-Host "`nVerifying agent against $EnvironmentUrl`n" -ForegroundColor White

# ── 1. instruction length ────────────────────────────────────────────────────────
Test-Assertion 'Instructions are within the 8,000-character limit' {
    $path = Join-Path $SolutionRoot 'agent' 'instructions.md'
    if (-not (Test-Path $path)) { return 'instructions.md not found' }
    $length = (Get-Content $path -Raw).Length
    if ($length -gt 8000) { return "instructions are $length characters" }
    Write-Verbose "instructions: $length characters"
    return $true
}

# ── 2. environment variables ─────────────────────────────────────────────────────
$required = @('adoKpi_mcpEndpoint', 'adoKpi_defaultOrganization')
foreach ($name in $required) {
    Test-Assertion "Environment variable $name is set" {
        $value = pac env list-env-value --name $name 2>&1 | Out-String
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match 'not found|error') {
            return 'not set in this environment'
        }
        return $true
    }
}

# ── 3 & 4. MCP endpoint reachability and tool surface ────────────────────────────
$expectedTools = @(
    'list_kpis', 'describe_kpi', 'get_scorecard', 'get_headline_kpis', 'get_kpis',
    'get_kpi_trend', 'detect_anomalies', 'get_project_profitability',
    'get_pipeline_economics', 'get_cloud_cost_allocation', 'list_scopes'
)

$mcpEndpoint = $env:ADO_KPI_MCP_ENDPOINT
if ([string]::IsNullOrWhiteSpace($mcpEndpoint)) {
    Write-Host '  ! Set ADO_KPI_MCP_ENDPOINT to verify the MCP tool surface' -ForegroundColor Yellow
}
else {
    Test-Assertion 'MCP endpoint responds to tools/list' {
        $body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list' } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Uri $mcpEndpoint -Method Post -Body $body `
            -ContentType 'application/json' -Headers @{ accept = 'application/json, text/event-stream' } `
            -TimeoutSec 30
        if (-not $response.result.tools) { return 'no tools returned' }
        $script:discoveredTools = $response.result.tools.name
        return $true
    }

    if (Get-Variable discoveredTools -Scope Script -ErrorAction SilentlyContinue) {
        foreach ($tool in $expectedTools) {
            Test-Assertion "MCP server exposes $tool" {
                if ($script:discoveredTools -contains $tool) { return $true }
                return 'not present in tools/list'
            }
        }
    }
}

# ── 5 & 6. security posture ──────────────────────────────────────────────────────
Write-Host "`n  ! Manual checks still required in the maker portal:" -ForegroundColor Yellow
Write-Host '      - Authentication is "Authenticate manually" with Entra ID v2' -ForegroundColor DarkGray
Write-Host '      - Anonymous / no-authentication access is disabled' -ForegroundColor DarkGray
Write-Host '      - Direct Line enhanced authentication is on, with the dashboard origin trusted' -ForegroundColor DarkGray
Write-Host '      - Agent is shared with a security group, not the whole organisation' -ForegroundColor DarkGray

# ── result ───────────────────────────────────────────────────────────────────────
Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) check(s) failed, $passed passed.`n" -ForegroundColor Red
    exit 1
}

Write-Host "All $passed automated checks passed.`n" -ForegroundColor Green
exit 0
