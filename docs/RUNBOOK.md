# Runbook

Ordered roughly by how often each thing actually happens.

## "A KPI shows as unavailable"

**This is usually correct behaviour, not a fault.** The engine refuses to estimate. Read the
`missingInputs` list — it names the exact key that is absent.

| Missing input | Fix |
| --- | --- |
| `rates.blendedLoadedRate` | Add it to `reference-data/rates.yaml`. Loaded cost, not salary. |
| `projects.budgetAtCompletion` | Add the project to `reference-data/projects.yaml` with `key` matching the Azure DevOps project name exactly. |
| `projects.contractRevenue` | Required for gross margin only. |
| `productionSelector` | Set it in `conventions.yaml`. Without it, all four DORA metrics are uncomputable — Azure DevOps has no built-in concept of "production". |
| `WorkItems.OriginalEstimate` | The team does not track hours. Use say-do ratio instead of estimation accuracy. |
| `AzureCostManagement` | `AZURE_COST_SUBSCRIPTIONS` is unset, or the managed identity lacks Cost Management Reader. |
| `tags.environment` | Resources are untagged. Apply the tagging contract; see `cloudfinops` in the catalog. |
| `rates.selfHostedAgentCount` | Add it, or accept that agent pool utilisation stays unavailable. |

Check what is loaded:

```powershell
Invoke-RestMethod https://<host>/api/health | ConvertTo-Json -Depth 4
```

## "The numbers look wrong"

Work through these in order. In practice it is nearly always the first two.

**1. Period mismatch.** Compare the period the agent used against the period the other report
used. A "last quarter" that means the trailing 90 days is not the same as calendar Q2.

**2. Scope mismatch.** Organisation-wide versus a single project versus a single team. The
dashboard shows the active scope in the filter bar; the agent is instructed to state it.

**3. Production selector.** If DORA figures look implausible, check whether your production
pipelines actually match `productionSelector`. A regex that matches nothing yields a
deployment frequency of zero; one that matches every CI build yields a wildly inflated one.

**4. Tag coverage.** Any allocated cloud cost below 95% coverage is a lower bound. The figure
is reported alongside the cost.

**5. Sample size.** A KPI marked low confidence has fewer than 10 observations. It is
indicative, not a measurement.

**6. Catalog revision.** Compare `catalogVersion` on the two results. A formula revision means
the figures are not comparable by design.

## "The agent will not answer a question about a person"

Working as designed. See [RESPONSIBLE-METRICS.md](RESPONSIBLE-METRICS.md). There is no
configuration flag, and the refusal is enforced in the engine as well as the agent — so it
cannot be bypassed by rephrasing, by calling the API directly, or by using the dashboard.

## "The agent cannot reach the MCP server"

```powershell
# 1. is the server alive?
Invoke-RestMethod https://<host>/api/health

# 2. does it speak MCP?
$body = @{ jsonrpc='2.0'; id=1; method='tools/list' } | ConvertTo-Json
Invoke-RestMethod https://<host>/mcp -Method Post -Body $body `
  -ContentType 'application/json' -Headers @{ accept='application/json, text/event-stream' }

# 3. does the agent's environment variable point at the right place?
pac env list-env-value --name adoKpi_mcpEndpoint
```

Common causes:

- **Private networking without Power Platform VNet subnet delegation.** The server is internal
  and Copilot Studio cannot reach it. Confirm the delegated subnet.
- **Endpoint missing the `/mcp` path.** A bare host will not work.
- **SSE transport configured.** Copilot Studio requires **Streamable HTTP**; SSE was removed.
- **OAuth misconfiguration.** Check the scope matches the Entra app's exposed API.

## "Everything is slow"

| Cause | Check | Fix |
| --- | --- | --- |
| Cold start | `minReplicas` | Set to 2 in prod |
| Wide period on a large organisation | Requested window | Narrow the scope or period |
| Trend request | Trends compute the KPI N times | Reduce buckets; request trends only for headline KPIs |
| Azure DevOps throttling | 429s in App Insights | Reduce concurrency; widen the schedule |
| Full scorecard when headline would do | Tool selected | Steer users to `get_headline_kpis` |

## `TruncationError` in the logs

```
Query exceeded the 20000-row safety cap.
```

Deliberate. The provider refuses to return a truncated aggregate, because a KPI computed on
partial data looks correct and is not.

Options, in order of preference:

1. Narrow the scope (project or team rather than organisation).
2. Narrow the period.
3. Push the aggregation into OData `$apply` for that calculator.
4. Raise `MAX_ROWS` — only with a corresponding memory increase, and only as a stopgap.

## "Copilot Credit consumption is higher than expected"

1. Check Copilot Studio analytics for session and message volume.
2. Look at which tools dominate. `get_scorecard` is the expensive one.
3. Promote the **dashboard** for routine metric checks — it consumes zero credits.
4. Narrow agent sharing; the user population is the main driver.
5. Consider prepaid packs if steady-state volume is now predictable.

## "Solution imported but the agent does not work"

Expected. Solutions do not carry authentication, channels, Application Insights or sharing.

```powershell
./copilot-studio/scripts/post-deploy.ps1 -EnvironmentUrl <url> -AgentSchemaName <name> -Settings ./settings/<env>.json
./copilot-studio/scripts/verify-agent.ps1 -EnvironmentUrl <url>
```

Then confirm manually in the maker portal: manual authentication, Direct Line trusted origins,
sharing scope. See [ALM.md](ALM.md).

## "The demo will not start"

```powershell
cd mcp-server
$env:DATA_MODE='demo'
$env:REFERENCE_DATA_DIR='../reference-data'
$env:DASHBOARD_DIR='../dashboard/dist'
node dist/index.js
```

- *"KPI catalog not found"* — set `KPI_CATALOG_DIR` to the catalog directory.
- *"The demo provider must not make network calls"* — `DATA_MODE` is not `demo`. This error is
  deliberate and loud.
- Dashboard 404 — run `npm run build` in `dashboard/` first.

## Health checks worth alerting on

| Signal | Threshold | Meaning |
| --- | --- | --- |
| `/api/health` non-200 | any | Server down |
| Data completeness | < 60% | Reference data or conventions have drifted |
| Tag coverage | < 80% | Cost allocation is unreliable |
| p95 scorecard latency | > 15 s | Scope too broad, or throttling |
| `TruncationError` rate | > 0 | Someone is querying beyond the safe window |
| Copilot Credits | > 80% of budget | Financial |

## Escalation

| Problem | Owner |
| --- | --- |
| KPI unavailable, server errors, DORA implausible | Platform engineering |
| Cost attributed to the wrong project | Cloud platform team |
| Budget, rate or revenue wrong | Finance partner |
| Agent not responding in Teams | Power Platform administrator |
| Credit consumption | FinOps practitioner |
