# Cost model

A FinOps product should be able to account for its own cost. This is how.

> Prices below are illustrative list rates for planning. **Verify against current Azure and
> Power Platform pricing for your region and agreement before committing to a budget.**

## Where the money goes

```
Copilot Credits (Copilot Studio)   ← the variable, volume-driven cost
Azure Container Apps (MCP server)  ← small, predictable
Log Analytics + App Insights       ← small, grows with retention
Key Vault + Storage                ← negligible
Dataverse (transcripts, solution)  ← included or small
```

## Copilot Credits — the one that matters

Copilot Studio bills in Copilot Credits, at roughly **$0.01 per credit** on pay-as-you-go,
with prepaid packs available at a commitment discount.

Credit consumption per interaction varies with complexity. A simple retrieval turn is cheap; a
multi-tool analytical turn — the normal shape of a question here — costs materially more,
because it involves generative orchestration, one or more tool calls, and a composed answer.

**Anyone quoting a single credits-per-question figure is guessing.** What you can do is bound
the range and measure the reality.

Illustrative monthly cost, assuming 10–50 credits for a typical analytical question:

| Questions / month | Low (10 credits) | High (50 credits) |
| --- | --- | --- |
| 500 (pilot, ~25 users) | $50 | $250 |
| 2,000 (one department) | $200 | $1,000 |
| 10,000 (organisation-wide) | $1,000 | $5,000 |
| 50,000 (heavy adoption) | $5,000 | $25,000 |

### What this design does to reduce it

- **`get_headline_kpis` exists as a cheaper path than `get_scorecard`.** Eight KPIs instead of
  62, and the agent is instructed to prefer it when brevity is wanted.
- **Server-side aggregation.** Responses are kilobytes. The model never reads a paged result
  set, which would multiply token consumption.
- **Eleven tools, not thirty.** Fewer choices means less orchestration overhead per turn and
  better selection accuracy.
- **The dashboard is free.** Tile browsing, filtering and drill-down go straight to the REST
  API and consume **zero credits**. Only conversation costs money. For routine "what are the
  numbers" usage, the dashboard is both cheaper and better.

That last point is worth stating plainly: an organisation that puts the dashboard in front of
people and reserves the agent for genuine questions will spend a fraction of one that routes
everything through chat.

### Before rolling out

1. Run Microsoft's [agent usage estimator](https://microsoft.github.io/copilot-studio-estimator/)
   against your expected volume.
2. Add the recommended buffer to the result.
3. Set a **budget alert on the pay-as-you-go meter** in the Azure portal.
4. **Review actual consumption after the first full month.** Every estimate is wrong until
   then.

## Azure infrastructure

Illustrative monthly list cost, one environment.

| Resource | Configuration | Dev | Prod |
| --- | --- | --- | --- |
| Container Apps | 1 vCPU / 2 GiB, consumption | ~$0 (scale to zero) | ~$70 (2 replicas warm) |
| Log Analytics | ~2 GB/month ingest, 90-day retention | ~$6 | ~$15 |
| Application Insights | Workspace-based | included above | included above |
| Key Vault | Standard, few operations | ~$1 | ~$1 |
| Storage | ZRS in prod, minimal data | ~$1 | ~$3 |
| Private endpoints | 2 endpoints | — | ~$15 |
| **Total** | | **~$8** | **~$105** |

`minReplicas` defaults to 0 in dev and 2 in prod. The prod setting exists because a cold start
on the first question of the working day is a poor experience for a leadership audience — it
costs roughly $70/month to avoid, which is usually the right trade.

The Bicep template deploys a **budget with forecast and actual alerts** at $100 (dev) and
$500 (prod).

## Azure DevOps

Not a cost of this product, but the thing it measures — and the KPIs are only meaningful if
you know how it bills:

| Item | How it bills |
| --- | --- |
| Basic user licence | Per user/month; first five users free |
| Microsoft-hosted parallel jobs | Per parallel job/month; one free tier available |
| Self-hosted parallel jobs | Cheaper per job; you pay for the agent infrastructure |
| Azure Artifacts | Per GB/month above 2 GB free |
| Test Plans | Per user/month |

Configure these in [`reference-data/rates.yaml`](../reference-data/rates.yaml) so
`pipeline.cost_per_run` and `pipeline.cost_per_successful_build` can be expressed in currency.
Without them, those KPIs report as unavailable rather than guessing a rate.

## Total cost of ownership

Illustrative, one production environment, one department at ~2,000 questions/month:

| Component | Monthly |
| --- | --- |
| Copilot Credits | $200 – $1,000 |
| Azure infrastructure | ~$105 |
| Power Platform environment | existing licence |
| **Total** | **~$305 – $1,105** |

The variance is entirely in conversation volume. Infrastructure is a rounding error by
comparison — which is itself an argument for the hybrid architecture, since the expensive
layer is the one that is genuinely hard to build and the cheap layer is the one that is easy.

## Cost controls to put in place

- [ ] Budget alert on the Copilot Credits PAYG meter
- [ ] Azure budget alert (deployed by the Bicep template)
- [ ] Agent shared with a security group, which bounds the user population
- [ ] Dashboard promoted as the default surface for routine metric checks
- [ ] `minReplicas: 0` in non-production
- [ ] Log Analytics retention reviewed — 90 days is the default here, not a requirement
- [ ] Actual consumption reviewed after month one against the estimate

## Comparison with the custom alternative

For context, since this is the trade ADR-0001 was decided on. At 10,000 analytical questions
per month:

| | Hybrid (this) | Pure custom code |
| --- | --- | --- |
| Orchestration | $1,000 – $5,000 (credits) | ~$300 (model tokens at typical rates) |
| Compute | ~$105 | ~$180 (adds bot hosting, token cache) |
| Identity and governance | included | build and maintain it yourself |
| Teams distribution | included | build and maintain it yourself |
| **Cash cost** | **higher** | lower |
| **Total cost including engineering time** | **lower** | higher |

The custom option is cheaper in cash and more expensive in everything else. At very high
volume that balance can flip, which is exactly why ADR-0001 records a 3× threshold as the
condition for re-evaluating the orchestration layer.
