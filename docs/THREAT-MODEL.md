# Threat model

STRIDE, scoped to what this system actually does: read engineering and financial data, compute
figures, and present them conversationally.

## Assets

| Asset | Sensitivity | Why it matters |
| --- | --- | --- |
| Rate card and project budgets | **High** — commercial | Blended labour rates and margins are competitively sensitive |
| Project profitability figures | **High** — commercial | CPI, EAC and margin per project |
| Team performance KPIs | **High** — employment | Misuse creates legal and human harm |
| Azure cost allocation | Medium | Cloud spend by project |
| Delivery metrics | Medium | Lead time, failure rate, throughput |
| The user's access token | **High** — credential | Grants Azure DevOps and ARM access as that user |

## Trust boundaries

```
[user] ── Entra ID ──► [Copilot Studio (Microsoft SaaS)]
                              │ OAuth 2.0, user token forwarded
                              ▼
                       [MCP server (our compute, VNet)]
                              │ OBO exchange
                              ▼
             [Azure DevOps]  [Azure Cost Management]  [reference data]
```

Three boundaries: user→Copilot Studio, Copilot Studio→MCP server, MCP server→data sources.

## STRIDE

### Spoofing

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Impersonate a user to read another team's figures | Entra ID authentication; OBO means the token is bound to the real user | Low |
| Rogue client calls the MCP server directly | OAuth 2.0 required; no anonymous access; private ingress in production | Low |
| Rogue MCP server registered in Copilot Studio | Endpoint comes from a solution-managed environment variable; DLP restricts connectors; changes are audited in Purview | Low — depends on Power Platform admin hygiene |
| Spoofed agent published in the tenant | Agent 365 agent inventory with Entra-registered agent identity | Low |

### Tampering

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Alter a KPI formula to flatter a project | Catalog is in Git, requires PR review and a revision bump; CI regenerates the published catalog and fails on drift | Low |
| Alter reference data to inflate margin | Key Vault / Storage behind private endpoint, RBAC-controlled, versioned in Git | Medium — an operator with write access can do this; audit logging is the control |
| Modify results in transit | TLS 1.2+ everywhere; private networking in production | Low |
| Poison source data by crafting work items | Work items are attacker-influenceable, but tools return aggregates and low-confidence results are flagged | Medium — a determined insider can skew an aggregate |

### Repudiation

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Deny having requested sensitive figures | Purview audit of agent interactions; Application Insights request telemetry with user id | Low |
| Deny changing reference data | Git history; Azure activity log; Key Vault audit | Low |
| Dispute a historical figure | Every scorecard carries `catalogVersion`, so a stored result traces to the exact formula revision | Low |

### Information disclosure

**The primary risk category for this system.**

| Threat | Mitigation | Residual |
| --- | --- | --- |
| A user reads a project they cannot see in Azure DevOps | OBO — the user's own Azure DevOps permissions apply | Low |
| Margin data leaks organisation-wide | Agent shared with a security group; anonymous access disabled; verified by `verify-agent.ps1` | Medium — depends on correct sharing configuration |
| Transcripts containing commercial figures land in telemetry | `logConversationDetails` false; enforced by `post-deploy.ps1` | Low |
| Rate card exposed via a KPI response | Only derived figures are returned; the rate itself is never echoed | Low |
| Employment-sensitive individual data disclosed | No person-level KPI exists; `contributorKey` is not populated from `AssignedTo`; engine refuses below team level | **Low by construction** |
| Sensitive figures forwarded outside the tenant | Power Platform DLP; Purview sensitivity labels | Medium — organisational control |

### Denial of service

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Expensive query exhausts the server | Hard row cap with loud failure; server-side aggregation; container app autoscale | Low |
| Copilot Credit exhaustion (financial DoS) | Budget alert on the PAYG meter; `get_headline_kpis` offered as the cheap path; agent shared with a limited group | Medium — monitor in month one |
| Azure DevOps API throttling | Aggregation pushed into OData; results not re-fetched within a request | Low |
| Trend request amplification (one call → N computations) | Bucket count capped at 24; trend requested only for headline KPIs by default | Low |

### Elevation of privilege

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Agent used to modify work items, budgets or Azure resources | **No write role is granted to any identity.** Read-only by construction | Low |
| Prompt injection obtains person-level metrics | Governance enforced server-side, before any calculation — a successful injection still gets refused | **Low by construction** |
| Prompt injection extracts the rate card | The rate card is not in the model context; only derived figures cross the boundary | Low |
| Token replay against Azure DevOps | Short-lived tokens, refreshed with skew; no token persisted to disk | Low |
| Lateral movement from a compromised container | User-assigned identity with three reader roles and nothing else; private networking | Low |

## Prompt injection, specifically

The agent processes attacker-influenceable text: work item titles, tags, pipeline names,
branch names. Anyone who can create a work item can attempt injection.

Why the blast radius is small here:

1. **Tools return computed aggregates.** A work item title does not reach the model verbatim
   through any KPI tool.
2. **General knowledge is disabled.** The agent cannot answer outside tool output.
3. **The critical control is server-side.** Person-level refusal happens in `guards.ts` before
   any calculation. The model cannot be persuaded to bypass code it does not execute.
4. **Read-only.** There is no destructive action to induce.

The realistic residual is *nuisance* — an injected string appearing in a name field within an
error message. Accepted.

## Assumptions

- Microsoft Entra ID and the Power Platform control plane are trusted.
- Power Platform administrators are trusted and competent; DLP is configured.
- Reference data is maintained by an authorised finance partner.
- The Azure DevOps organisation's own project security is correctly configured — OBO inherits
  it faithfully, including its mistakes.

## Highest-value controls

If you implement only four things:

1. **Manual authentication with on-behalf-of.** Without it, everyone sees everything.
2. **Security-group sharing, not organisation-wide.** The profitability and team domains are
   not for general consumption.
3. **The server-side governance guard.** It is the only individual-metrics control that
   survives a persistent user.
4. **A budget alert on Copilot Credits.** The most likely production incident here is a bill,
   not a breach.

## Review cadence

Re-review on: a new data source, a new KPI domain, a change to the identity model, a Copilot
Studio platform change affecting auth or networking, or annually.
