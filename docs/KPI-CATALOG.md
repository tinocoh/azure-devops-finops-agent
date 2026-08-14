# KPI catalog

> **Generated from [`kpi-engine/catalog/`](../kpi-engine/catalog/). Do not edit by hand.**
> Run `node kpi-engine/src/generate-docs.mjs` after changing a definition.

62 KPIs across 8 domains. Every KPI is versioned: changing a formula requires a `revision` bump, because trend data is only comparable within a revision.

## Data feasibility

| Level | Meaning |
| --- | --- |
| `native` | available directly from Azure DevOps |
| `derived` | computable from Azure DevOps once a naming or tagging convention is configured |
| `external` | requires data Azure DevOps does not hold — finance, HR or Azure cost |

A KPI marked `external` is not a defect. Azure DevOps does not hold budgets, labour rates or contract revenue, and the engine will report the KPI as unavailable — naming the missing input — rather than estimating it.

## Summary

| Domain | KPIs | Audience |
| --- | --- | --- |
| [Delivery Performance](#delivery-performance) | 5 | engineering-lead, delivery-manager, cto |
| [Flow Metrics](#flow-metrics) | 6 | scrum-master, delivery-manager, engineering-lead |
| [Agile Execution](#agile-execution) | 8 | scrum-master, product-owner, delivery-manager |
| [Code & Review Health](#code-review-health) | 9 | engineering-lead, tech-lead |
| [Pipeline FinOps](#pipeline-finops) | 7 | platform-engineer, finops-practitioner, engineering-lead |
| [Team Performance & Capacity](#team-performance-capacity) | 7 | delivery-manager, engineering-lead, resource-manager |
| [Project Profitability](#project-profitability) | 14 | delivery-manager, portfolio-manager, finance-partner, cfo |
| [Cloud FinOps Linkage](#cloud-finops-linkage) | 6 | finops-practitioner, platform-engineer, cto |

---

## Delivery Performance

The four DORA metrics plus deployment rework rate. These describe how fast and how safely change reaches production. They are team-level metrics and must never be attributed to individuals.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Deployment Frequency** | `DF = successful production deployments ÷ days in period` | deployments/day | derived | >= 1 per day |
| **Change Lead Time** | `CLT = median(production deploy timestamp − first commit timestamp of the change)` | hours | derived | < 1 hour |
| **Change Failure Rate** | `CFR = failed production deployments ÷ total production deployments × 100` | percent | derived | 0–5% |
| **Failed Deployment Recovery Time** | `MTTR = median(restore timestamp − incident detection timestamp)` | hours | derived | < 1 hour |
| **Deployment Rework Rate** | `DRR = incident-triggered deployments ÷ total production deployments × 100` | percent | derived | < 5% |

<details>
<summary>Interpretation and caveats</summary>

#### Deployment Frequency

`delivery.deployment_frequency` · revision 1 · higher is better

High frequency with a low change failure rate indicates small, safe batches. High frequency with a rising change failure rate indicates the team is shipping faster than it can verify.

**Caveats**

- Counts deployments, not value. Pair with flow distribution before drawing conclusions.

**Read alongside:** `delivery.change_failure_rate`

#### Change Lead Time

`delivery.change_lead_time` · revision 1 · lower is better

Reported as a median, never a mean — lead-time distributions are heavily right-skewed and a mean is dominated by a handful of stalled changes.

**Caveats**

- Requires commit-to-deployment traceability. Squash merges without linked work items break it.

#### Change Failure Rate

`delivery.change_failure_rate` · revision 1 · lower is better

A deployment counts as failed if it required a hotfix, rollback or patch — not merely if the pipeline reported a red run. Pipeline failure is a proxy; configure `failureSelector` to refine it where incident data is available.

**Read alongside:** `delivery.deployment_frequency`

#### Failed Deployment Recovery Time

`delivery.mttr` · revision 1 · lower is better

**Caveats**

- Only as good as the incident-tagging convention. If incidents live in ServiceNow or PagerDuty rather than Azure Boards, this KPI must be marked unavailable, not estimated.

#### Deployment Rework Rate

`delivery.deployment_rework_rate` · revision 1 · lower is better

Added to the DORA set in the 2024 report as a stability counterweight to change failure rate. Measures unplanned work created by deployments rather than deployments that failed outright.

</details>

---

## Flow Metrics

How work moves through the system. Flow metrics are the most directly available domain in Azure DevOps because Analytics pre-computes LeadTimeDays and CycleTimeDays.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Flow Velocity** | `Throughput = completed work items ÷ iteration` | items/iteration | native | stable rolling 3-iteration average |
| **Flow Time** | `Flow time = median(LeadTimeDays) — creation to done` | days | native | user story < 3 days |
| **Cycle Time** | `Cycle time = median(CycleTimeDays) — in-progress to done` | days | native | — |
| **Flow Efficiency** | `Flow efficiency = active time ÷ total elapsed time × 100` | percent | derived | > 40% |
| **Flow Load (WIP)** | `WIP = items in progress at a point in time` | items | native | <= 1.5 × team size |
| **Flow Distribution** | `Distribution = share of completed work by item type` | percent | native | feature ~60%, defect ~20%, debt ~20% — set per portfolio |

<details>
<summary>Interpretation and caveats</summary>

#### Flow Velocity

`flow.velocity` · revision 1 · higher is better

Judge stability, not magnitude. A rising trend is only meaningful if item size is stable; always read alongside flow distribution.

**Caveats**

- Never compare velocity between teams. Item sizing is team-local by definition.

#### Flow Time

`flow.flow_time` · revision 1 · lower is better

Report P50 and P85 together. P85 is what a stakeholder actually experiences when asking "when will this be done"; P50 flatters the team.

#### Flow Efficiency

`flow.flow_efficiency` · revision 1 · higher is better

The single most under-used metric here. Low flow efficiency means work is waiting, not that people are slow — the fix is queue and hand-off design, never pressure on individuals.

#### Flow Load (WIP)

`flow.flow_load` · revision 1 · target band

By Little's Law, cycle time = WIP ÷ throughput. Reducing WIP is the fastest lever on cycle time and requires no productivity change whatsoever.

#### Flow Distribution

`flow.flow_distribution` · revision 1 · target band

The value-versus-maintenance balance. A portfolio with 5% technical debt investment is borrowing against future flow time.

</details>

---

## Agile Execution

Sprint-level predictability, quality and estimation health.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Sprint Velocity (Story Points)** | `sum(StoryPoints where StateCategory = 'Completed') per iteration` | points/iteration | native | stable rolling 3-sprint average, coefficient of variation < 0.2 |
| **Sprint Burndown** | `remaining_points_by_day vs ideal_linear_burn` | points remaining | native | — |
| **Commitment / Say-Do Ratio** | `(points_completed / points_committed_at_sprint_start) * 100` | percent | derived | 80–100% |
| **Escaped Defects** | `(production_origin_bugs / total_bugs) * 100` | percent | derived | — |
| **Defect Density** | `count(bugs) / count(completed_stories)` | bugs/story | native | — |
| **Rework Rate** | `(reopened_items / completed_items) * 100` | percent | derived | — |
| **Backlog Aging** | `count(open_items where age_days > 90) / count(open_items) * 100` | percent | native | — |
| **Estimation Accuracy** | `abs(OriginalEstimate - CompletedWork) / OriginalEstimate * 100` | percent deviation | native | within ±20% |

<details>
<summary>Interpretation and caveats</summary>

#### Sprint Velocity (Story Points)

`agile.velocity_points` · revision 1 · higher is better

**Caveats**

- Cross-team comparison of story points is meaningless and is blocked by the agent.

#### Sprint Burndown

`agile.sprint_burndown` · revision 1 · lower is better

A flat line until the final two days signals batch-at-the-end delivery and hidden risk.

#### Commitment / Say-Do Ratio

`agile.say_do_ratio` · revision 1 · target band

Consistently above 100% is as much a problem as below 80% — it means the team is sandbagging commitments and the forecast is not usable for planning.

#### Rework Rate

`agile.rework_rate` · revision 1 · lower is better

Usually a definition-of-done problem, not a coding problem.

#### Backlog Aging

`agile.backlog_aging` · revision 1 · lower is better

Aged backlog is an inventory cost — it is refined, re-estimated and re-read repeatedly without ever being delivered.

#### Estimation Accuracy

`agile.estimation_accuracy` · revision 1 · lower is better

**Caveats**

- Only computable where teams track hours. Points-only teams should use say-do ratio instead.

</details>

---

## Code & Review Health

Engineering hygiene at the pull-request and build level. Every metric here is team- or repository-scoped. Author-level aggregation is deliberately unsupported — see docs/RESPONSIBLE-METRICS.md.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Pull Request Cycle Time** | `percentile_50(pr_closed_date - pr_created_date)` | hours | derived | — |
| **Time to First Review** | `percentile_50(first_review_comment_date - pr_created_date)` | hours | derived | — |
| **Pull Request Size** | `percentile_50(lines_added + lines_deleted)` | lines | derived | — |
| **Revert Rate** | `(revert_commits / total_commits) * 100` | percent | derived | — |
| **Build Success Rate** | `SucceededCount / (SucceededCount + FailedCount) * 100` | percent | native | — |
| **Build Duration** | `percentile_50(RunDurationSeconds) / 60` | minutes | native | — |
| **Test Pass Rate** | `(PassedCount / TotalCount) * 100` | percent | native | — |
| **Flaky Test Rate** | `(flaky_tests / total_tests) * 100` | percent | native | — |
| **Code Coverage** | `(covered_lines / total_lines) * 100` | percent | native | — |

<details>
<summary>Interpretation and caveats</summary>

#### Time to First Review

`code.review_latency` · revision 1 · lower is better

The highest-leverage metric in this domain. Review latency is pure queue time and is usually a scheduling problem, not a capacity problem.

#### Pull Request Size

`code.pr_size` · revision 1 · lower is better

Review effectiveness collapses above roughly 400 lines. Large PRs correlate with both longer review latency and higher change failure rate.

#### Build Success Rate

`code.build_success_rate` · revision 1 · higher is better

A success rate near 100% on the default branch is healthy; near 100% everywhere may mean CI is not running enough checks.

#### Build Duration

`code.build_duration` · revision 1 · lower is better

Directly drives both developer feedback loop quality and pipeline cost — the only KPI that is simultaneously a DevEx metric and a FinOps metric.

#### Flaky Test Rate

`code.flaky_test_rate` · revision 1 · lower is better

Flaky tests are a compound cost — they burn pipeline minutes on reruns and erode trust in the whole suite.

**Read alongside:** `pipeline.failed_run_waste`

#### Code Coverage

`code.code_coverage` · revision 1 · higher is better

**Caveats**

- A target rather than a goal. Coverage is trivially gameable and should never be a performance objective.

</details>

---

## Pipeline FinOps

The cost of running the delivery machine itself. This is the domain where engineering behaviour converts most directly into a monthly invoice.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Pipeline Minutes Consumed** | `sum(RunDurationSeconds) / 60 grouped by agent_type` | minutes/month | native | within purchased parallel job capacity |
| **Queue Wait Time** | `percentile_50(QueueDurationSeconds)` | seconds | native | — |
| **Failed-Run Waste** | `sum(RunDurationSeconds where result = 'failed') / sum(RunDurationSeconds) * 100` | percent | native | — |
| **Agent Pool Utilisation** | `(busy_agent_seconds / (pool_size * period_seconds)) * 100` | percent | native | 60–80% |
| **Cost per Pipeline Run** | `total_pipeline_cost / count(pipeline_runs)` | currency/run | external | — |
| **Cost per Successful Build** | `total_pipeline_cost / count(successful_runs)` | currency/build | external | — |
| **Artifact Storage Cost** | `max(0, total_gb - free_tier_gb) * rate_per_gb` | currency/month | derived | 2 GB included at no cost |

<details>
<summary>Interpretation and caveats</summary>

#### Pipeline Minutes Consumed

`pipeline.minutes_consumed` · revision 1 · lower is better

Split Microsoft-hosted from self-hosted; only Microsoft-hosted minutes carry a per-job cost.

#### Queue Wait Time

`pipeline.queue_wait_time` · revision 1 · lower is better

The classic FinOps trade-off made visible. Buying another parallel job costs money; queue time costs engineering hours. Quantify both before deciding.

**Read alongside:** `pipeline.agent_pool_utilization`

#### Failed-Run Waste

`pipeline.failed_run_waste` · revision 1 · lower is better

Compute minutes spent on runs that produced no deployable artefact. Also reported in currency via pipeline.cost_per_run. Usually the single largest quick win in this domain.

**Read alongside:** `code.flaky_test_rate`

#### Agent Pool Utilisation

`pipeline.agent_pool_utilization` · revision 1 · target band

Below 40% on self-hosted agents means idle infrastructure being paid for. Above 85% means queue time is about to become the constraint.

#### Cost per Pipeline Run

`pipeline.cost_per_run` · revision 1 · lower is better

Requires a rate card. The agent reports this as unavailable rather than guessing when rates are not configured.

#### Cost per Successful Build

`pipeline.cost_per_successful_build` · revision 1 · lower is better

The honest version of cost per run. A pipeline with a 60% success rate costs 1.67× its nominal per-run price to obtain one usable build.

#### Artifact Storage Cost

`pipeline.artifact_storage_cost` · revision 1 · lower is better

Almost always solved by a retention policy rather than by a purchase.

</details>

---

## Team Performance & Capacity

Capacity, focus and sustainability at team level. These metrics answer "is this team set up to succeed" — never "is this person performing".

> **Governance: team-level-only.** Every KPI in this domain declares a minimum aggregation level that the engine enforces in code. Person-level computation is refused, not merely discouraged.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Capacity vs Actual** | `sum(CompletedWork) / sum(planned_capacity_hours) * 100` | percent | native | >= 80% alignment |
| **Utilisation Rate** | `sum(CompletedWork) / sum(available_hours) * 100` | percent | native | 70–80% team average |
| **Billable Ratio** | `billable_hours / total_hours * 100` | percent | derived | 70–80% for professional services |
| **Focus Factor** | `velocity / (team_size * available_hours_per_person)` | ratio | derived | 0.6–0.8 |
| **Unplanned Work Percentage** | `items_added_after_sprint_start / total_sprint_items * 100` | percent | derived | — |
| **Context Switching** | `count(work_item_reassignments) / count(work_items)` | reassignments/item | derived | — |
| **Knowledge Concentration (Bus Factor)** | `count(components where top_contributor_share > 0.8)` | components at risk | external | >= 2 substantive contributors per component |

<details>
<summary>Interpretation and caveats</summary>

#### Utilisation Rate

`team.utilization_rate` · revision 1 · target band

Deliberately banded, not maximised. Sustained utilisation above 85% removes all slack and empirically increases lead time — queueing theory, not opinion. Treat a high reading as a risk signal, not an achievement.

**Caveats**

- Must never be presented per person. The agent blocks per-person breakdown of this KPI.

**Minimum aggregation:** `team`

#### Focus Factor

`team.focus_factor` · revision 1 · target band

Below 0.6 usually means interruption load, not low effort.

**Minimum aggregation:** `team`

#### Unplanned Work Percentage

`team.unplanned_work` · revision 1 · lower is better

The primary explanation for a poor say-do ratio. Diagnose this before challenging a team on commitment.

**Read alongside:** `agile.say_do_ratio`

**Minimum aggregation:** `team`

#### Context Switching

`team.context_switching` · revision 1 · lower is better

**Caveats**

- Team-level only. Reassignment counts per person are a surveillance metric and are blocked.

**Minimum aggregation:** `team`

#### Knowledge Concentration (Bus Factor)

`team.knowledge_concentration` · revision 1 · lower is better

Reported as a risk register of components, never as a ranking of people. The output names code paths, not authors.

**Minimum aggregation:** `repository`

</details>

---

## Project Profitability

Earned Value Management mapped onto Agile delivery. Story points are the physical-progress proxy; money comes from the rate card and the contract.

> **Requires reference data:** `rates.yaml`, `projects.yaml`. Without it, these KPIs report as unavailable.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Cost of Delivery (Actual Cost)** | `sum(hours * blended_loaded_rate) + direct_costs` | currency | external | — |
| **Earned Value** | `BAC * (story_points_completed / story_points_in_scope)` | currency | external | — |
| **Cost Variance** | `earned_value - actual_cost` | currency | external | — |
| **Schedule Variance** | `earned_value - planned_value` | currency | external | — |
| **Cost Performance Index** | `earned_value / actual_cost` | ratio | external | >= 1.0 |
| **Schedule Performance Index** | `earned_value / planned_value` | ratio | external | — |
| **Estimate at Completion** | `BAC / CPI` | currency | external | — |
| **Estimate to Complete** | `estimate_at_completion - actual_cost` | currency | external | — |
| **Budget Burn Rate** | `actual_cost / BAC * 100` | percent | external | — |
| **Gross Margin** | `(revenue - actual_cost) / revenue * 100` | percent | external | > 40% |
| **Cost per Story Point** | `actual_cost / story_points_completed` | currency/point | external | — |
| **Cost per Feature** | `actual_cost / count(completed_features)` | currency/feature | external | — |
| **Effort Variance** | `(CompletedWork - OriginalEstimate) / OriginalEstimate * 100` | percent | native | — |
| **Rate Realisation** | `actual_billed_rate / standard_rate * 100` | percent | external | — |

<details>
<summary>Interpretation and caveats</summary>

#### Cost of Delivery (Actual Cost)

`profitability.actual_cost` · revision 1 · lower is better

Loaded rate must include employer costs and overhead, not salary alone.

#### Earned Value

`profitability.earned_value` · revision 1 · higher is better

**Caveats**

- Valid only if scope is reasonably stable. Under heavy scope change EV must be rebaselined, and the agent flags any project whose scope moved more than 15% in the period.

#### Cost Variance

`profitability.cost_variance` · revision 1 · higher is better

Negative means the project has spent more than the value it has delivered.

#### Schedule Variance

`profitability.schedule_variance` · revision 1 · higher is better

Expressed in currency by EVM convention, but it is a schedule signal.

#### Cost Performance Index

`profitability.cpi` · revision 1 · higher is better

Cost efficiency of delivered work. Empirically stable after roughly 20% completion, which makes it the most reliable early predictor of final cost.

#### Schedule Performance Index

`profitability.spi` · revision 1 · higher is better

**Caveats**

- SPI converges to 1.0 at project end regardless of lateness. Stop trusting it in the final 10%.

#### Estimate at Completion

`profitability.eac` · revision 1 · lower is better

The default formula assumes current cost efficiency persists. The engine also emits the optimistic variant (AC + BAC − EV) and the pessimistic variant (AC + (BAC − EV) / (CPI × SPI)) so a range is presented rather than a single false-precision number.

#### Budget Burn Rate

`profitability.burn_rate` · revision 1 · target band

Only meaningful next to percent complete. 60% of budget consumed at 30% earned value is the canonical early warning of overrun.

**Read alongside:** `profitability.earned_value`

#### Cost per Story Point

`profitability.cost_per_story_point` · revision 1 · lower is better

**Caveats**

- Comparable only within one team over time. Cross-team comparison is blocked by the engine because story points are not a standard unit.

#### Effort Variance

`profitability.effort_variance` · revision 1 · lower is better

The one profitability-adjacent KPI computable from Azure DevOps alone.

#### Rate Realisation

`profitability.rate_realization` · revision 1 · higher is better

Measures discounting and write-offs — margin erosion that never appears in delivery metrics.

</details>

---

## Cloud FinOps Linkage

Cost allocation from Azure Cost Management back to the delivery unit that owns it. Requires a tagging contract between the platform team and the delivery teams.

| KPI | Formula | Unit | Feasibility | Benchmark |
| --- | --- | --- | --- | --- |
| **Cost Allocation Tag Coverage** | `cost_of_tagged_resources / total_cost * 100` | percent | external | — |
| **Cloud Cost per Azure DevOps Project** | `sum(cost where tag['ado-project'] = project)` | currency/month | external | — |
| **Non-Production Off-Hours Waste** | `nonprod_cost_outside_working_hours / nonprod_cost_total * 100` | percent | external | — |
| **Idle Development Resource Cost** | `sum(cost of nonprod resources where utilization < idle_threshold)` | currency/month | external | — |
| **Cloud Cost per Deployment** | `cloud_infrastructure_cost / count(production_deployments)` | currency/deployment | external | — |
| **Cloud Cost per Engineer** | `total_nonprod_cloud_cost / count(active_contributors)` | currency/engineer/month | external | — |

<details>
<summary>Interpretation and caveats</summary>

#### Cost Allocation Tag Coverage

`cloudfinops.tag_coverage` · revision 1 · higher is better

The gateway KPI for this entire domain. Every allocated figure below is qualified by this percentage, and the agent states it explicitly in any answer involving allocated cost.

#### Cloud Cost per Azure DevOps Project

`cloudfinops.cost_per_project` · revision 1 · lower is better

The showback figure. Becomes chargeback only when tag coverage is above 95%.

#### Non-Production Off-Hours Waste

`cloudfinops.nonprod_waste` · revision 1 · lower is better

Non-production environments running 168 hours a week to serve a 45-hour working week carry roughly 73% idle time. Auto-shutdown schedules are the standard remedy and the agent quantifies the saving before recommending one.

#### Idle Development Resource Cost

`cloudfinops.idle_resource_cost` · revision 1 · lower is better

Read-only detection. Remediation scripts are generated for human review and are never executed by the agent.

#### Cloud Cost per Deployment

`cloudfinops.cost_per_deployment` · revision 1 · lower is better

A unit-economics metric. It should fall as deployment frequency rises against fixed infrastructure — if it does not, the platform is not amortising.

**Read alongside:** `delivery.deployment_frequency`

#### Cloud Cost per Engineer

`cloudfinops.cost_per_engineer` · revision 1 · lower is better

A capacity-planning unit metric for platform teams. Reported at organisation and team level only; per-person cost attribution is blocked by the engine.

</details>

---

## Sources

| Framework | Applies to |
| --- | --- |
| DORA / Accelerate State of DevOps | Delivery Performance |
| Flow Framework, SAFe flow metrics | Flow Metrics |
| Azure DevOps Analytics entity reference | Native KPI availability |
| PMI earned value management | Project Profitability |
| FinOps Foundation Framework, FOCUS specification | Cloud FinOps Linkage |
| SPACE and DevEx frameworks | The reason no single throughput number is presented alone |

