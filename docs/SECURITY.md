# Security

## Design principles

1. **No secrets.** Not in the repository, not in settings files, not in Key Vault. Workload
   identity federation and managed identity throughout. `post-deploy.ps1` fails the run if a
   value that looks like a secret appears in a settings file.
2. **User-delegated by default.** Interactive queries run on-behalf-of the caller. Azure
   DevOps project security continues to apply.
3. **Read-only by construction.** No role granted to any identity here permits a write.
4. **Fail closed.** Governance guards, row caps and missing reference data all cause a refusal
   or an explicit "unavailable", never a silent approximation.

## Identity model

Two paths, deliberately separate.

### Interactive — on-behalf-of

```
User in Teams
  → Copilot Studio (Authenticate manually, Entra ID v2, federated credential)
  → User.AccessToken
  → MCP server (OAuth 2.0 bearer)
  → OBO exchange with a signed client assertion
  → Azure DevOps Analytics / Azure Cost Management as the user
```

The user's own permissions apply end to end. A user who cannot see a project in the Azure
DevOps portal cannot see it through the agent. No shared service account exists to over-grant.

The token exchange is in [`auth/tokens.ts`](../mcp-server/src/auth/tokens.ts). It uses
`jwt-bearer` with a **client assertion read from the federated token file** — there is no
`client_secret` parameter anywhere in the code path.

### Unattended — workload identity

Scheduled aggregation and the dashboard's service-identity refresh use the container app's
user-assigned managed identity. A user-assigned identity is used rather than system-assigned
so that role assignments survive a redeploy.

### Demo

`NoNetworkTokenProvider` throws on any token request. If demo mode ever attempts a network
call, it fails loudly — that is a bug, and it is designed to be a noisy one.

## Authorisation

| Identity | Role | Scope | Why |
| --- | --- | --- | --- |
| Managed identity | Cost Management Reader | Resource group | Read cost, never change budgets |
| Managed identity | Monitoring Reader | Resource group | Utilisation joins for idle-resource detection |
| Managed identity | Storage Blob Data Reader | Storage account | Read reference data |
| Managed identity | Key Vault Secrets User | Key Vault | Read commercially sensitive reference data |
| User (OBO) | Azure DevOps `Analytics (read)` | Per user | Their own project visibility |

**No write role is granted to anything.** The agent cannot modify a work item, a pipeline, a
budget or an Azure resource. It can generate a remediation script for a human to review, and
it says clearly that the script is unreviewed and unexecuted.

## Data handling

### What is stored

| Data | Where | Retention |
| --- | --- | --- |
| Reference data (rates, budgets, revenue) | Key Vault / Storage, private endpoint | Operator-managed |
| KPI results | Not persisted — computed per request | None |
| Telemetry (metrics, dependencies, exceptions) | Application Insights | 90 days default |
| Conversation transcripts | Dataverse, Copilot Studio | 28 days (platform) |

### What is deliberately not stored

- **No conversation text in Application Insights.** `logConversationDetails` is set to false
  by `post-deploy.ps1`. These conversations quote team performance data and commercial
  figures; shipping the transcript into a telemetry store would be an unnecessary exposure.
- **No person identifiers.** The live provider does not populate `contributorKey` from
  `AssignedTo`. The engine has no per-person KPI and therefore no reason to hold one.
- **No KPI result cache.** Results are computed per request. A cached scorecard is a stale
  scorecard with no visible expiry, and a lingering copy of sensitive data.

### Sensitivity

The **team** and **profitability** domains carry commercially and employment-sensitive data.
The agent must not be shared organisation-wide; `agent.yaml` sets `sharing: securityGroup`
and `allowAnonymousAccess: false`, and `verify-agent.ps1` prompts for confirmation of both.

## Network

With `privateNetworking: true` (default in production):

- Container app ingress is internal only; no public endpoint.
- Copilot Studio reaches it over **Power Platform VNet subnet delegation**.
- Key Vault and Storage are behind private endpoints with `defaultAction: Deny`.
- Log Analytics ingestion is private.

CORS on the REST API is restricted to the configured dashboard origin. Direct Line uses
enhanced authentication with an explicit trusted-origin list.

## Input handling

- **Period expressions** are parsed by an allow-list of forms in
  [`util/period.ts`](../mcp-server/src/util/period.ts). An uninterpretable expression is
  rejected with guidance rather than defaulted — a KPI whose window silently shifts is not
  comparable over time.
- **OData string values** are escaped before interpolation into `$filter`.
- **KPI ids** are matched against the catalog; an unknown id is rejected, not passed through.
- **Chat rendering** in the dashboard escapes HTML before applying a minimal bold/code/newline
  transform. No raw HTML is injected, and `v-html` receives only that escaped output.

## Prompt injection

The agent reads work item titles, tags and pipeline names — all attacker-influenceable by
anyone who can create a work item.

Mitigations:

1. **Tools return computed aggregates, not raw text.** No work item title reaches the model
   verbatim through the KPI tools.
2. **General knowledge is disabled.** The agent cannot answer from anything other than tool
   output.
3. **Governance is server-side.** Even a fully-successful prompt injection cannot obtain
   person-level metrics, because the refusal happens in the engine before any calculation.
4. **The agent is read-only.** There is no destructive action to induce.

## Supply chain

- Dependabot on all package ecosystems.
- CodeQL on TypeScript.
- `npm audit` in CI, failing on high severity.
- Container image pinned by digest in production deployments.
- No `postinstall` scripts in the dependency set.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](../SECURITY.md) in the repository root.

## Deployment checklist

- [ ] `privateNetworking: true` in production
- [ ] Manual authentication configured with a federated credential, no client secret
- [ ] Anonymous access disabled on the agent
- [ ] Agent shared with a security group, not the organisation
- [ ] Direct Line enhanced authentication on, trusted origins restricted
- [ ] `logConversationDetails` false
- [ ] DLP policy applied to the Power Platform environment
- [ ] Purview auditing enabled
- [ ] Budget alert on the Copilot Credits meter
- [ ] `verify-agent.ps1` passes
