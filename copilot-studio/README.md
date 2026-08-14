# Copilot Studio agent

This directory holds the reviewable source for the Copilot Studio half of the system.

Copilot Studio agents are authored in a browser and stored as Dataverse solution components,
which makes them awkward to review. The convention here is that **`solution/` is the intent
and the exported solution is the artefact** — a change to agent behaviour starts as a pull
request against these files, and `scripts/verify-agent.ps1` asserts that the deployed
environment matches.

## What lives where

| Path | Contents |
| --- | --- |
| `solution/agent/agent.yaml` | Declarative agent definition — harness, orchestration, model, channels, auth, telemetry, environment variables. |
| `solution/agent/instructions.md` | The agent instructions. **Hard limit 8,000 characters** — enforced in CI. |
| `solution/tools/` | MCP server registration and its operational limits. |
| `solution/topics/` | Only the topics that must be deterministic. Everything else is left to generative orchestration. |
| `adaptive-cards/` | Card payloads for Teams and M365 Copilot. |
| `scripts/` | Deployment, post-deployment and verification. |

## Why so few topics

Generative orchestration handles routing well, and every topic added is one more choice
competing for the orchestrator's attention — selection accuracy degrades noticeably past
roughly 30–40 total tools, topics and connected agents.

Three topics exist, each for a reason that generative routing cannot satisfy:

- **`individual-performance-refusal`** — safety critical. An instruction is advisory to the
  model and erodes under a persistent user; a matched topic takes deterministic control of
  the turn. This is the second of two independent controls, the first being the server-side
  block in the KPI engine.
- **`conversation-start`** — sets the default organisation and period. A user who does not
  know the default period will misread the first number they see.
- **`escalate-to-human`** — routes data-quality complaints to a named owner instead of an
  apology.

## Setting it up

### 1. Deploy the MCP server first

The agent is useless without it. See [`../infra/README.md`](../infra/README.md).
Note the resulting `/mcp` endpoint.

### 2. Register the Entra ID application

```powershell
az ad app create --display-name "ADO KPI Agent" --sign-in-audience AzureADMyOrg
```

Then, on the app registration:

- **Expose an API** with scope `KpiQuery.Read`.
- **API permissions**: `Azure DevOps → user_impersonation` and
  `Azure Service Management → user_impersonation`, both delegated.
- **Federated credentials** — add one for the MCP server's workload identity. Do **not**
  create a client secret; nothing in this repository stores one.

### 3. Create the agent

In Copilot Studio, create a new agent using the **standard harness** with **generative
orchestration** enabled, then configure it to match `agent.yaml`:

- Paste `instructions.md` into **Instructions**.
- **Settings → Generative AI**: disable general knowledge. Every answer must be a computed
  figure; a general-knowledge fallback lets the agent answer a metrics question from prose.
- **Settings → Security → Authentication**: *Authenticate manually*, Microsoft Entra ID v2
  with federated credentials, using the scopes above. This mode is required — it is the only
  one that yields `User.AccessToken`, which the MCP server exchanges on-behalf-of so that
  every query runs with the caller's own Azure DevOps permissions.
- **Tools → Add tool → Model Context Protocol**: point at the `/mcp` endpoint with OAuth 2.0.
  Copilot Studio discovers the eleven tools automatically.

### 4. Post-deployment configuration

```powershell
cd copilot-studio/scripts
Copy-Item settings/prod.example.json settings/prod.json   # then fill it in
./post-deploy.ps1 -EnvironmentUrl https://contoso-prod.crm4.dynamics.com `
                  -AgentSchemaName cr123_adoFinOpsDeliveryIntelligence `
                  -Settings ./settings/prod.json
```

## The ALM caveat you need to know about

Solutions do **not** carry:

- the Application Insights connection string,
- manual authentication settings,
- Direct Line and web channel security,
- sharing permissions.

Promoting a solution from test to production therefore does **not** produce a working agent
on its own. `post-deploy.ps1` re-applies what it can and prints explicit instructions for the
two things `pac` does not currently expose (Direct Line trusted origins and the manual auth
provider). Treat a promotion as incomplete until `verify-agent.ps1` passes.

This is a genuine limitation of the platform, not of this repository, and it is one of the
reasons ADR-0001 keeps the KPI logic in code where CI/CD is complete.

## Cost

Copilot Studio bills in Copilot Credits. A multi-tool analytical query — the normal shape of
a question here — consumes materially more than a simple Q&A turn.

Before rolling out beyond a pilot group:

1. Run the [agent usage estimator](https://microsoft.github.io/copilot-studio-estimator/)
   against your expected question volume.
2. Set a budget alert on the pay-as-you-go meter in the Azure portal.
3. Review actual consumption after the first full month against the estimate.

Two design decisions here exist mainly to control that cost: `get_headline_kpis` is offered
as a cheaper alternative to `get_scorecard`, and every tool aggregates server-side so a
response is kilobytes rather than a paged result set the model has to read.

## Testing

The [Copilot Studio Kit](https://github.com/microsoft/Power-CAT-Copilot-Studio-Kit) provides
conversation-level test scaffolding. It is community-maintained rather than a supported
Microsoft product, so assess its stability before making it a required CI gate.

At minimum, before any release, manually verify:

1. A scorecard question returns figures **with the period stated**.
2. A question about a named individual is **refused**, and refused again when pressed.
3. A profitability question in an environment with no reference data reports the **missing
   inputs by name** rather than returning zeros.
4. An unknown project name triggers `list_scopes` rather than a guess.
