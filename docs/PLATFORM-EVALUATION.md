# Platform evaluation — Copilot Studio, custom code, or hybrid

The evidence behind [ADR-0001](adr/ADR-0001-agent-platform.md). Read the ADR for the decision;
read this for the workings.

Platform facts below reflect Microsoft Copilot Studio and Power Platform as documented in
mid-2026. This is a fast-moving product surface — **re-verify before relying on any specific
limit**, and treat a stale figure here as a bug.

## The question

An existing Azure FinOps Agent is built as custom code: .NET orchestrator, TypeScript MCP
server, Bicep infrastructure, GitHub Actions, self-hosted Vue UI.

For this second agent, the proposal was: *Copilot Studio is better and simpler than that.*

Three options were assessed.

| | Option A | Option B | Option C |
| --- | --- | --- | --- |
| | Pure Copilot Studio | Pure custom code | **Hybrid** |
| Orchestration | Copilot Studio | Foundry / Semantic Kernel | Copilot Studio |
| Analytics | Power Automate + connectors | Custom code | Custom MCP server |
| UI | Adaptive Cards | Custom web app | Custom web app + Adaptive Cards |
| Identity | Entra ID, built in | Hand-rolled | Entra ID, built in |
| Governance | Platform | Hand-rolled | Platform |

## Dimension-by-dimension

### Time to value

Copilot Studio wins clearly. Generative orchestration, knowledge sources, tool registration
and channel publishing are configuration. A demonstrable agent takes days rather than weeks,
and the Teams and M365 Copilot channels arrive free with SSO.

**A → strong. B → weak. C → strong for the conversational layer.**

### Identity and access

Copilot Studio's *Authenticate manually* mode with Microsoft Entra ID v2 yields
`User.AccessToken`, which can be exchanged on-behalf-of for downstream resources. This is
genuinely better than the custom equivalent, because it means:

- no shared service account,
- no secret to rotate in application code,
- **Azure DevOps project security continues to apply per user** — a user who cannot see a
  project in the portal cannot see it through the agent.

The default *Authenticate with Microsoft* mode does **not** provide `User.AccessToken`, only
`User.ID` and `User.DisplayName`. Manual mode is therefore not optional for this design.

**A → strong. B → possible but hand-built. C → strong.**

### Governance and administration

Power Platform DLP policies, Purview audit and sensitivity labels, Agent 365 agent inventory
with Entra-registered agent identities, customer-managed keys, VNet subnet delegation, IP
firewall, data residency. All platform features rather than things to build.

Reproducing this in custom code is months of work that adds no user-facing value.

**A → strong. B → weak. C → strong.**

### Visualisation

The decisive constraint.

Copilot Studio renders Adaptive Card primitives: text, images, tables, buttons, dropdowns,
carousels. There is **no native chart rendering**. An interactive KPI dashboard is not
achievable inside the chat surface.

The workarounds and their honest assessment:

| Approach | Verdict |
| --- | --- |
| Pre-render a chart to PNG in an Azure Function, return the URL in an Adaptive Card | Works, but static — no hover, no drill-down, and now you are hosting a rendering service anyway |
| Adaptive Card tables and FactSets | Fine for tabular KPIs, not a dashboard |
| Power BI report in a Teams tab, agent as a side conversation | Good, but two surfaces and a Power BI or Fabric capacity cost |
| Custom canvas web app over Direct Line | **Full control.** Chosen. |

Note also that an agent using *Authenticate with Microsoft* cannot be embedded in a Power BI
report via iframe — worth knowing before designing around that combination.

**A → fails the requirement. B → strong. C → strong.**

### Data aggregation at volume

The second decisive constraint.

Azure DevOps Analytics history for a real organisation is large, and every headline KPI here
is an aggregate — often a percentile, which OData cannot compute at all.

Two platform limits bite:

- **Connector payload ceiling: 5 MB.** A paged work-item result set exceeds this quickly.
- **Synchronous action timeout.** A complex `$apply` aggregation across a wide window can
  exceed the window available to a tool call.

Both are avoidable only by aggregating somewhere other than the agent. Once you accept that,
you are running compute you own, and the question becomes where it lives — which is what
option C answers.

The MCP server pushes aggregation into OData `$apply` where OData can express it, and pages
with a hard cap where it cannot. On hitting the cap it **fails loudly** rather than returning
a truncated aggregate, because a KPI computed on truncated data is worse than no KPI.

**A → fails at realistic volume. B → strong. C → strong.**

### Offline demonstration

The third decisive constraint.

Copilot Studio is pure SaaS. There is no emulator, no container image, no offline mode. The
Bot Framework Emulator does not apply — different runtime. `pac` always calls cloud endpoints.
Direct Line requires reaching Microsoft's endpoint.

For a laptop demo on a client site with no guest Wi-Fi, the only options are locally-run code
or a pre-recorded transcript player. This repository chooses the former: the dashboard and MCP
server run locally against seeded data, and the conversation panel is explicit that it is an
offline responder rather than the agent.

**A → impossible. B → possible. C → possible for the dashboard, not for the agent.**

### Cost

Copilot Studio bills in Copilot Credits, at $0.01 per credit on pay-as-you-go, with prepaid
packs available. Credit consumption per interaction varies with complexity: tool calls,
knowledge lookups and generative steps all contribute.

A multi-tool analytical query — the normal shape of a question here — plausibly consumes an
order of magnitude more than a simple Q&A turn. At high volume this can exceed the cost of
self-hosted orchestration against a model endpoint. At pilot volume it is negligible and the
platform value dominates.

**Cost is workload-shaped, not platform-shaped.** Anyone quoting a general answer here is
guessing. Use Microsoft's agent usage estimator against your own expected volume, add the
recommended buffer, set a budget alert, and review actual consumption after the first month.

Two design decisions in this repository exist to control it: `get_headline_kpis` as a cheaper
alternative to `get_scorecard`, and server-side aggregation so responses are kilobytes.

**Inconclusive without workload data. Not a reason to choose A or B on its own.**

### ALM and source control

Solution-aware, and therefore promotable: agent definition, topics, tool configuration, agent
flows, environment variables, connection references.

**Not** solution-aware, and therefore requiring post-deployment configuration every time:

- Application Insights settings
- Manual authentication settings
- Direct Line and web channel security
- Sharing permissions
- Deployed channels

This is a real gap. A successful solution import does not produce a working agent. It is
mitigated here by [`post-deploy.ps1`](../copilot-studio/scripts/post-deploy.ps1) and
[`verify-agent.ps1`](../copilot-studio/scripts/verify-agent.ps1), which make the manual steps
at least scripted, reviewable and assertable — but it is mitigation, not a fix.

By contrast, the MCP server and dashboard are 100% declarative in Git with a complete CI/CD
pipeline. That asymmetry is the main reason the KPI formulas live in code.

**A → partial. B → strong. C → partial for the agent, strong for the engine.**

### Testability

Copilot Studio provides a test panel; the community-maintained Copilot Studio Kit adds
conversation-level scaffolding. Neither is comparable to unit testing a formula.

The KPI formulas are the intellectual property of this product. They need to be diffable in a
pull request and regression-tested on every commit. In this repository, 33 tests enforce —
among other things — that the catalog and the calculators cannot drift apart, that governance
guards actually block, and that percentages stay within range.

That is not achievable if the formulas live in a low-code designer.

**A → weak. B → strong. C → strong for the engine.**

## Scoring

| Dimension | A: Copilot Studio | B: Custom | C: Hybrid |
| --- | --- | --- | --- |
| Time to value | ●●● | ● | ●●● |
| Identity | ●●● | ●● | ●●● |
| Governance | ●●● | ● | ●●● |
| Visualisation | ○ | ●●● | ●●● |
| Aggregation at volume | ○ | ●●● | ●●● |
| Offline demo | ○ | ●●● | ●● |
| ALM completeness | ●● | ●●● | ●● |
| Testability | ● | ●●● | ●●● |
| Distribution (Teams, M365) | ●●● | ● | ●●● |
| Operational surface | ●●● | ● | ●● |

Option A fails three requirements outright. Option B rebuilds identity, governance and
distribution for no functional gain — which is exactly the part of the original assumption
that is correct. **Option C is chosen.**

## What would change the answer

- Native interactive chart rendering **and** server-side aggregation without payload or
  timeout limits in Copilot Studio → option A becomes viable, and the dashboard becomes
  optional rather than required.
- Offline demonstration dropped as a requirement **and** Teams becomes the only surface →
  option A becomes viable.
- Measured Copilot Credit consumption exceeding self-hosted orchestration by more than 3× at
  steady-state volume → re-evaluate the orchestration layer specifically, not the whole
  architecture.

## Verify these claims yourself

Every platform limit cited here is published by Microsoft. The relevant references:

- Copilot Studio: harnesses, generative orchestration, tools, MCP extension
- Copilot Studio: quotas and limits
- Copilot Studio: billing and licensing, agent usage estimator
- Copilot Studio: end-user authentication configuration
- Copilot Studio: ALM guidance and solution-awareness
- Power Platform: pipelines, Build Tools, Dataverse Git integration
- Azure DevOps: Analytics OData entity references and API versioning
