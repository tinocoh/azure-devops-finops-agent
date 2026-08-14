import type {
  CapacityFact,
  CloudCostFact,
  KpiDefinition,
  Period,
  PipelineRunFact,
  PullRequestFact,
  Scope,
  SnapshotFact,
  TestResultFact,
  WorkItemFact,
} from '../types.js';
import type { ReferenceData } from './reference.js';
import {
  coefficientOfVariation,
  daysBetween,
  hoursBetween,
  mean,
  percentile,
  round,
  safeDivide,
  sum,
} from './stats.js';

export interface CalculatorContext {
  scope: Scope;
  period: Period;
  workItems: WorkItemFact[];
  snapshots: SnapshotFact[];
  pipelineRuns: PipelineRunFact[];
  pullRequests: PullRequestFact[];
  testResults: TestResultFact[];
  capacity: CapacityFact[];
  cloudCosts: CloudCostFact[];
  reference: ReferenceData;
}

export interface CalculatorResult {
  value: number | null;
  sampleSize?: number;
  percentiles?: Record<string, number>;
  /** Named inputs the calculator required but could not obtain. */
  missingInputs?: string[];
  /** Free-text explanation when the value is null. */
  unavailableReason?: string;
}

export type Calculator = (ctx: CalculatorContext) => CalculatorResult;

// ── helpers ────────────────────────────────────────────────────────────────────

const completed = (ctx: CalculatorContext) =>
  ctx.workItems.filter((w) => w.stateCategory === 'Completed');

const iterationCount = (ctx: CalculatorContext): number => {
  const iterations = new Set(ctx.workItems.map((w) => w.iteration).filter(Boolean));
  return Math.max(1, iterations.size);
};

const periodDays = (ctx: CalculatorContext): number =>
  Math.max(1, daysBetween(ctx.period.from, ctx.period.to));

const productionRuns = (ctx: CalculatorContext) => ctx.pipelineRuns.filter((r) => r.isProduction);

const distribution = (values: number[], ps: number[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const p of ps) {
    const v = percentile(values, p);
    if (v !== null) out[`p${p}`] = round(v, 2)!;
  }
  return out;
};

const missing = (reason: string, inputs: string[]): CalculatorResult => ({
  value: null,
  unavailableReason: reason,
  missingInputs: inputs,
});

// ── domain 1: delivery (DORA) ──────────────────────────────────────────────────

const deploymentFrequency: Calculator = (ctx) => {
  const runs = productionRuns(ctx).filter((r) => r.succeeded);
  if (ctx.pipelineRuns.length === 0) {
    return missing('No pipeline run data in the selected period.', ['PipelineRuns']);
  }
  if (productionRuns(ctx).length === 0) {
    return missing(
      'No pipeline runs matched the production selector. Configure `productionSelector` in ' +
        'reference data so the engine knows which pipelines, stages or environments are production.',
      ['productionSelector'],
    );
  }
  return { value: round(runs.length / periodDays(ctx), 3), sampleSize: runs.length };
};

const changeLeadTime: Calculator = (ctx) => {
  const traced = productionRuns(ctx).filter((r) => r.succeeded && r.firstCommitDate);
  if (traced.length === 0) {
    return missing(
      'No production deployments carry commit traceability in this period. Change lead time ' +
        'requires commit-to-deployment linkage.',
      ['PipelineRuns.firstCommitDate'],
    );
  }
  const hours = traced.map((r) => hoursBetween(r.firstCommitDate!, r.completedDate));
  return {
    value: round(percentile(hours, 50), 2),
    sampleSize: traced.length,
    percentiles: distribution(hours, [50, 85, 95]),
  };
};

const changeFailureRate: Calculator = (ctx) => {
  const runs = productionRuns(ctx);
  if (runs.length === 0) {
    return missing('No production deployments in the selected period.', ['PipelineRuns']);
  }
  const failed = runs.filter((r) => !r.succeeded).length;
  return { value: round(safeDivide(failed * 100, runs.length), 2), sampleSize: runs.length };
};

const mttr: Calculator = (ctx) => {
  const incidents = ctx.workItems.filter(
    (w) => w.isProductionIncident && w.activatedDate && w.closedDate,
  );
  if (incidents.length === 0) {
    return missing(
      'No production incidents were identified in this period. Incidents are detected from ' +
        'work items flagged by the incident selector; if incidents are tracked outside Azure ' +
        'Boards this KPI cannot be computed here.',
      ['WorkItems.isProductionIncident'],
    );
  }
  const hours = incidents.map((w) => hoursBetween(w.activatedDate!, w.closedDate!));
  return {
    value: round(percentile(hours, 50), 2),
    sampleSize: incidents.length,
    percentiles: distribution(hours, [50, 85, 95]),
  };
};

const deploymentReworkRate: Calculator = (ctx) => {
  const runs = productionRuns(ctx);
  if (runs.length === 0) return missing('No production deployments in the period.', ['PipelineRuns']);
  const rework = runs.filter((r) => r.isIncidentTriggered).length;
  return { value: round(safeDivide(rework * 100, runs.length), 2), sampleSize: runs.length };
};

// ── domain 2: flow ─────────────────────────────────────────────────────────────

const flowVelocity: Calculator = (ctx) => {
  const done = completed(ctx);
  return { value: round(done.length / iterationCount(ctx), 2), sampleSize: done.length };
};

const flowTime: Calculator = (ctx) => {
  const values = completed(ctx)
    .map((w) => w.leadTimeDays)
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return missing('No completed work items with lead time.', ['WorkItems.LeadTimeDays']);
  return {
    value: round(percentile(values, 50), 2),
    sampleSize: values.length,
    percentiles: distribution(values, [50, 85, 95]),
  };
};

const cycleTime: Calculator = (ctx) => {
  const values = completed(ctx)
    .map((w) => w.cycleTimeDays)
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return missing('No completed work items with cycle time.', ['WorkItems.CycleTimeDays']);
  return {
    value: round(percentile(values, 50), 2),
    sampleSize: values.length,
    percentiles: distribution(values, [50, 85, 95]),
  };
};

const flowEfficiency: Calculator = (ctx) => {
  const items = completed(ctx).filter(
    (w) => typeof w.cycleTimeDays === 'number' && typeof w.leadTimeDays === 'number' && w.leadTimeDays! > 0,
  );
  if (items.length === 0) return missing('No items with both lead and cycle time.', ['WorkItems']);
  const active = sum(items.map((w) => w.cycleTimeDays!));
  const elapsed = sum(items.map((w) => w.leadTimeDays!));
  return { value: round(safeDivide(active * 100, elapsed), 2), sampleSize: items.length };
};

const flowLoad: Calculator = (ctx) => {
  if (ctx.snapshots.length === 0) {
    const wip = ctx.workItems.filter((w) => w.stateCategory === 'InProgress').length;
    return { value: wip, sampleSize: wip };
  }
  const values = ctx.snapshots.map((s) => s.inProgressCount);
  return { value: round(mean(values), 1), sampleSize: ctx.snapshots.length };
};

const flowDistribution: Calculator = (ctx) => {
  const done = completed(ctx);
  if (done.length === 0) return missing('No completed work items in the period.', ['WorkItems']);
  const features = done.filter((w) => /feature|user story|product backlog item/i.test(w.type)).length;
  return { value: round(safeDivide(features * 100, done.length), 2), sampleSize: done.length };
};

// ── domain 3: agile ────────────────────────────────────────────────────────────

const velocityPoints: Calculator = (ctx) => {
  const done = completed(ctx).filter((w) => typeof w.storyPoints === 'number');
  if (done.length === 0) return missing('No completed items carry story points.', ['WorkItems.StoryPoints']);
  const byIteration = new Map<string, number>();
  for (const w of done) {
    const key = w.iteration ?? 'unassigned';
    byIteration.set(key, (byIteration.get(key) ?? 0) + w.storyPoints!);
  }
  const perIteration = [...byIteration.values()];
  return {
    value: round(mean(perIteration), 2),
    sampleSize: done.length,
    percentiles: {
      iterations: byIteration.size,
      stability: round(coefficientOfVariation(perIteration) ?? 0, 3)!,
    },
  };
};

const sprintBurndown: Calculator = (ctx) => {
  if (ctx.snapshots.length === 0) return missing('No work item snapshots available.', ['WorkItemSnapshot']);
  const latest = [...ctx.snapshots].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
  return { value: round(latest.remainingStoryPoints, 1), sampleSize: ctx.snapshots.length };
};

const sayDoRatio: Calculator = (ctx) => {
  const committed = ctx.workItems.filter((w) => w.committedAtIterationStart);
  if (committed.length === 0) {
    return missing(
      'No sprint-start commitment baseline could be established from work item revisions.',
      ['WorkItemRevisions'],
    );
  }
  const committedPoints = sum(committed.map((w) => w.storyPoints ?? 0));
  const deliveredPoints = sum(
    committed.filter((w) => w.stateCategory === 'Completed').map((w) => w.storyPoints ?? 0),
  );
  return {
    value: round(safeDivide(deliveredPoints * 100, committedPoints), 2),
    sampleSize: committed.length,
  };
};

const escapedDefects: Calculator = (ctx) => {
  const bugs = ctx.workItems.filter((w) => /bug|defect/i.test(w.type));
  if (bugs.length === 0) return missing('No defects recorded in the period.', ['WorkItems']);
  const escaped = bugs.filter((w) => w.isProductionIncident || w.tags.includes('escaped')).length;
  return { value: round(safeDivide(escaped * 100, bugs.length), 2), sampleSize: bugs.length };
};

const defectDensity: Calculator = (ctx) => {
  const bugs = ctx.workItems.filter((w) => /bug|defect/i.test(w.type)).length;
  const stories = completed(ctx).filter((w) => /story|backlog item|feature/i.test(w.type)).length;
  if (stories === 0) return missing('No completed stories to normalise against.', ['WorkItems']);
  return { value: round(safeDivide(bugs, stories), 3), sampleSize: stories };
};

const reworkRate: Calculator = (ctx) => {
  const done = completed(ctx);
  if (done.length === 0) return missing('No completed work items in the period.', ['WorkItems']);
  const reopened = done.filter((w) => (w.reopenCount ?? 0) > 0).length;
  return { value: round(safeDivide(reopened * 100, done.length), 2), sampleSize: done.length };
};

const backlogAging: Calculator = (ctx) => {
  const open = ctx.workItems.filter(
    (w) => w.stateCategory === 'Proposed' || w.stateCategory === 'InProgress',
  );
  if (open.length === 0) return missing('No open work items in scope.', ['WorkItems']);
  const now = new Date(ctx.period.to).getTime();
  const aged = open.filter((w) => (now - new Date(w.createdDate).getTime()) / 86_400_000 > 90).length;
  return { value: round(safeDivide(aged * 100, open.length), 2), sampleSize: open.length };
};

const estimationAccuracy: Calculator = (ctx) => {
  const items = completed(ctx).filter(
    (w) => typeof w.originalEstimate === 'number' && w.originalEstimate! > 0 && typeof w.completedWork === 'number',
  );
  if (items.length === 0) {
    return missing('No completed items carry both an original estimate and completed work.', [
      'WorkItems.OriginalEstimate',
      'WorkItems.CompletedWork',
    ]);
  }
  const deviations = items.map(
    (w) => (Math.abs(w.completedWork! - w.originalEstimate!) / w.originalEstimate!) * 100,
  );
  return {
    value: round(percentile(deviations, 50), 2),
    sampleSize: items.length,
    percentiles: distribution(deviations, [50, 85]),
  };
};

// ── domain 4: code and review ──────────────────────────────────────────────────

const prCycleTime: Calculator = (ctx) => {
  const closed = ctx.pullRequests.filter((p) => p.closedDate);
  if (closed.length === 0) return missing('No closed pull requests in the period.', ['PullRequests']);
  const hours = closed.map((p) => hoursBetween(p.createdDate, p.closedDate!));
  return {
    value: round(percentile(hours, 50), 2),
    sampleSize: closed.length,
    percentiles: distribution(hours, [50, 85]),
  };
};

const reviewLatency: Calculator = (ctx) => {
  const reviewed = ctx.pullRequests.filter((p) => p.firstReviewDate);
  if (reviewed.length === 0) {
    return missing('No pull requests received a review in this period.', ['PullRequestThreads']);
  }
  const hours = reviewed.map((p) => hoursBetween(p.createdDate, p.firstReviewDate!));
  return {
    value: round(percentile(hours, 50), 2),
    sampleSize: reviewed.length,
    percentiles: distribution(hours, [50, 85]),
  };
};

const prSize: Calculator = (ctx) => {
  if (ctx.pullRequests.length === 0) return missing('No pull requests in the period.', ['PullRequests']);
  const sizes = ctx.pullRequests.map((p) => p.linesAdded + p.linesDeleted);
  return {
    value: round(percentile(sizes, 50), 0),
    sampleSize: sizes.length,
    percentiles: distribution(sizes, [50, 85, 95]),
  };
};

const revertRate: Calculator = (ctx) => {
  const merged = ctx.pullRequests.filter((p) => p.merged);
  if (merged.length === 0) return missing('No merged pull requests in the period.', ['PullRequests']);
  const reverts = merged.filter((p) => p.isRevert).length;
  return { value: round(safeDivide(reverts * 100, merged.length), 2), sampleSize: merged.length };
};

const buildSuccessRate: Calculator = (ctx) => {
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const succeeded = ctx.pipelineRuns.filter((r) => r.succeeded).length;
  return {
    value: round(safeDivide(succeeded * 100, ctx.pipelineRuns.length), 2),
    sampleSize: ctx.pipelineRuns.length,
  };
};

const buildDuration: Calculator = (ctx) => {
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const minutes = ctx.pipelineRuns.map((r) => r.runDurationSeconds / 60);
  return {
    value: round(percentile(minutes, 50), 2),
    sampleSize: minutes.length,
    percentiles: distribution(minutes, [50, 85, 95]),
  };
};

const testPassRate: Calculator = (ctx) => {
  const total = sum(ctx.testResults.map((t) => t.totalCount));
  if (total === 0) return missing('No test results published in the period.', ['TestResultsDaily']);
  const passed = sum(ctx.testResults.map((t) => t.passedCount));
  return { value: round(safeDivide(passed * 100, total), 2), sampleSize: total };
};

const flakyTestRate: Calculator = (ctx) => {
  const total = sum(ctx.testResults.map((t) => t.totalCount));
  if (total === 0) return missing('No test results published in the period.', ['TestResultsDaily']);
  const flaky = sum(ctx.testResults.map((t) => t.flakyCount));
  return { value: round(safeDivide(flaky * 100, total), 3), sampleSize: total };
};

const codeCoverage: Calculator = (ctx) => {
  const values = ctx.testResults
    .map((t) => t.coveragePercent)
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) {
    return missing(
      'No code coverage was published. Add a coverage publishing task to the pipeline.',
      ['CodeCoverage'],
    );
  }
  return { value: round(mean(values), 2), sampleSize: values.length };
};

// ── domain 5: pipeline FinOps ──────────────────────────────────────────────────

const minutesConsumed: Calculator = (ctx) => {
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const hosted = ctx.pipelineRuns.filter((r) => r.agentType === 'microsoft-hosted');
  const total = sum(ctx.pipelineRuns.map((r) => r.runDurationSeconds)) / 60;
  return {
    value: round(total, 1),
    sampleSize: ctx.pipelineRuns.length,
    percentiles: {
      microsoftHostedMinutes: round(sum(hosted.map((r) => r.runDurationSeconds)) / 60, 1)!,
      selfHostedMinutes: round(
        sum(
          ctx.pipelineRuns.filter((r) => r.agentType === 'self-hosted').map((r) => r.runDurationSeconds),
        ) / 60,
        1,
      )!,
    },
  };
};

const queueWaitTime: Calculator = (ctx) => {
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const values = ctx.pipelineRuns.map((r) => r.queueDurationSeconds);
  return {
    value: round(percentile(values, 50), 1),
    sampleSize: values.length,
    percentiles: distribution(values, [50, 85, 95]),
  };
};

const failedRunWaste: Calculator = (ctx) => {
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const totalSeconds = sum(ctx.pipelineRuns.map((r) => r.runDurationSeconds));
  const wastedSeconds = sum(
    ctx.pipelineRuns.filter((r) => !r.succeeded).map((r) => r.runDurationSeconds),
  );
  return {
    value: round(safeDivide(wastedSeconds * 100, totalSeconds), 2),
    sampleSize: ctx.pipelineRuns.length,
    percentiles: { wastedMinutes: round(wastedSeconds / 60, 1)! },
  };
};

const agentPoolUtilization: Calculator = (ctx) => {
  const selfHosted = ctx.pipelineRuns.filter((r) => r.agentType === 'self-hosted');
  const poolSize = ctx.reference.rates?.selfHostedAgentCount;
  if (!poolSize) {
    return missing(
      'Self-hosted agent pool size is not configured. Set `selfHostedAgentCount` in reference ' +
        'data, or read it from the TaskAgentPoolSizeSnapshots preview entity.',
      ['rates.selfHostedAgentCount'],
    );
  }
  const busySeconds = sum(selfHosted.map((r) => r.runDurationSeconds));
  const capacitySeconds = poolSize * periodDays(ctx) * 86_400;
  return {
    value: round(safeDivide(busySeconds * 100, capacitySeconds), 2),
    sampleSize: selfHosted.length,
  };
};

const costPerRun: Calculator = (ctx) => {
  const rates = ctx.reference.rates;
  if (!rates?.parallelJobMonthlyCost) {
    return missing(
      'No pipeline rate card configured. Set `parallelJobMonthlyCost` in reference data to ' +
        'express pipeline consumption in currency.',
      ['rates.parallelJobMonthlyCost'],
    );
  }
  if (ctx.pipelineRuns.length === 0) return missing('No pipeline runs in the period.', ['PipelineRuns']);
  const months = periodDays(ctx) / 30.44;
  const parallelJobs = rates.parallelJobCount ?? 1;
  const infraCost = sum(
    ctx.cloudCosts.filter((c) => /pipeline|agent|devops/i.test(c.serviceName)).map((c) => c.cost),
  );
  const total = rates.parallelJobMonthlyCost * parallelJobs * months + infraCost;
  return {
    value: round(safeDivide(total, ctx.pipelineRuns.length), 4),
    sampleSize: ctx.pipelineRuns.length,
    percentiles: { totalPipelineCost: round(total, 2)! },
  };
};

const costPerSuccessfulBuild: Calculator = (ctx) => {
  const perRun = costPerRun(ctx);
  if (perRun.value === null) return perRun;
  const succeeded = ctx.pipelineRuns.filter((r) => r.succeeded).length;
  if (succeeded === 0) return missing('No successful builds in the period.', ['PipelineRuns']);
  const total = perRun.percentiles?.totalPipelineCost ?? 0;
  return { value: round(safeDivide(total, succeeded), 4), sampleSize: succeeded };
};

const artifactStorageCost: Calculator = (ctx) => {
  const rates = ctx.reference.rates;
  if (rates?.artifactStorageGb == null || rates?.artifactStorageRatePerGb == null) {
    return missing(
      'Artifact storage consumption is not exposed by a stable Azure DevOps REST endpoint. ' +
        'Supply `artifactStorageGb` and `artifactStorageRatePerGb` in reference data.',
      ['rates.artifactStorageGb', 'rates.artifactStorageRatePerGb'],
    );
  }
  const free = rates.artifactStorageFreeGb ?? 2;
  const billable = Math.max(0, rates.artifactStorageGb - free);
  return { value: round(billable * rates.artifactStorageRatePerGb, 2), sampleSize: 1 };
};

// ── domain 6: team ─────────────────────────────────────────────────────────────

const capacityVsActual: Calculator = (ctx) => {
  const planned = sum(ctx.capacity.map((c: CapacityFact) => c.plannedCapacityHours));
  if (planned === 0) return missing('No sprint capacity configured for this team.', ['Capacity']);
  const actual = sum(completed(ctx).map((w) => w.completedWork ?? 0));
  return { value: round(safeDivide(actual * 100, planned), 2), sampleSize: ctx.capacity.length };
};

const utilizationRate: Calculator = (ctx) => {
  const available = sum(ctx.capacity.map((c: CapacityFact) => c.availableHours));
  if (available === 0) return missing('No available-hours capacity data for this team.', ['Capacity']);
  const actual = sum(ctx.workItems.map((w) => w.completedWork ?? 0));
  return { value: round(safeDivide(actual * 100, available), 2), sampleSize: ctx.capacity.length };
};

const billableRatio: Calculator = (ctx) => {
  const totalHours = sum(ctx.workItems.map((w) => w.completedWork ?? 0));
  if (totalHours === 0) return missing('No effort recorded on work items.', ['WorkItems.CompletedWork']);
  const billableTag = ctx.reference.conventions?.billableTag ?? 'billable';
  const billableHours = sum(
    ctx.workItems.filter((w) => w.tags.includes(billableTag)).map((w) => w.completedWork ?? 0),
  );
  if (billableHours === 0) {
    return missing(
      `No work items carry the "${billableTag}" tag. Billable ratio needs a tagging convention.`,
      ['conventions.billableTag'],
    );
  }
  return { value: round(safeDivide(billableHours * 100, totalHours), 2), sampleSize: ctx.workItems.length };
};

const focusFactor: Calculator = (ctx) => {
  const available = sum(ctx.capacity.map((c: CapacityFact) => c.availableHours));
  if (available === 0) return missing('No capacity data for this team.', ['Capacity']);
  const points = sum(completed(ctx).map((w) => w.storyPoints ?? 0));
  const hoursPerPoint = ctx.reference.conventions?.hoursPerStoryPoint;
  if (!hoursPerPoint) {
    return missing(
      'Focus factor converts story points to hours and needs `hoursPerStoryPoint` in reference data.',
      ['conventions.hoursPerStoryPoint'],
    );
  }
  return { value: round(safeDivide(points * hoursPerPoint, available), 3), sampleSize: ctx.capacity.length };
};

const unplannedWork: Calculator = (ctx) => {
  if (ctx.workItems.length === 0) return missing('No work items in scope.', ['WorkItems']);
  const unplanned = ctx.workItems.filter((w) => w.addedAfterIterationStart).length;
  return { value: round(safeDivide(unplanned * 100, ctx.workItems.length), 2), sampleSize: ctx.workItems.length };
};

const contextSwitching: Calculator = (ctx) => {
  if (ctx.workItems.length === 0) return missing('No work items in scope.', ['WorkItems']);
  const reassignments = sum(ctx.workItems.map((w) => w.reassignCount ?? 0));
  return {
    value: round(safeDivide(reassignments, ctx.workItems.length), 3),
    sampleSize: ctx.workItems.length,
  };
};

const knowledgeConcentration: Calculator = (ctx) => {
  const byRepo = new Map<string, Map<string, number>>();
  for (const w of ctx.workItems) {
    if (!w.contributorKey) continue;
    const repo = ctx.scope.repository ?? 'all';
    const inner = byRepo.get(repo) ?? new Map<string, number>();
    inner.set(w.contributorKey, (inner.get(w.contributorKey) ?? 0) + 1);
    byRepo.set(repo, inner);
  }
  if (byRepo.size === 0) {
    return missing(
      'Knowledge concentration needs path-level commit attribution, which has no native ' +
        'Analytics entity. Enable the Git commit collector to compute it.',
      ['GitCommits'],
    );
  }
  let atRisk = 0;
  for (const contributors of byRepo.values()) {
    const total = sum([...contributors.values()]);
    const top = Math.max(...contributors.values());
    if (total > 0 && top / total > 0.8) atRisk += 1;
  }
  return { value: atRisk, sampleSize: byRepo.size };
};

// ── domain 7: profitability (EVM) ──────────────────────────────────────────────

interface Evm {
  bac: number;
  ac: number;
  ev: number;
  pv: number;
  cpi: number | null;
  spi: number | null;
}

export function computeEvm(ctx: CalculatorContext): Evm | { missing: string[] } {
  const project = ctx.reference.project;
  const rates = ctx.reference.rates;
  const gaps: string[] = [];
  if (!project?.budgetAtCompletion) gaps.push('projects.budgetAtCompletion');
  if (!rates?.blendedLoadedRate) gaps.push('rates.blendedLoadedRate');
  if (gaps.length > 0) return { missing: gaps };

  const bac = project!.budgetAtCompletion!;
  const hours = sum(ctx.workItems.map((w) => w.completedWork ?? 0));
  const ac = hours * rates!.blendedLoadedRate! + (project!.directCosts ?? 0);

  const pointsInScope = project!.storyPointsInScope ?? sum(ctx.workItems.map((w) => w.storyPoints ?? 0));
  const pointsDone = sum(completed(ctx).map((w) => w.storyPoints ?? 0));
  const ev = pointsInScope > 0 ? bac * (pointsDone / pointsInScope) : 0;

  const plannedPercent =
    project!.plannedPercentComplete ??
    Math.min(1, Math.max(0, elapsedFraction(ctx, project!.startDate, project!.endDate)));
  const pv = bac * plannedPercent;

  return { bac, ac, ev, pv, cpi: safeDivide(ev, ac), spi: safeDivide(ev, pv) };
}

function elapsedFraction(ctx: CalculatorContext, start?: string, end?: string): number {
  if (!start || !end) return 0;
  const total = daysBetween(start, end);
  if (total <= 0) return 1;
  return daysBetween(start, ctx.period.to) / total;
}

const evmCalculator =
  (pick: (e: Evm) => number | null, decimals = 2): Calculator =>
  (ctx) => {
    const evm = computeEvm(ctx);
    if ('missing' in evm) {
      return missing(
        'Project profitability requires financial reference data that Azure DevOps does not ' +
          `hold. Missing: ${evm.missing.join(', ')}.`,
        evm.missing,
      );
    }
    return { value: round(pick(evm), decimals), sampleSize: ctx.workItems.length };
  };

const grossMargin: Calculator = (ctx) => {
  const evm = computeEvm(ctx);
  const revenue = ctx.reference.project?.contractRevenue;
  if ('missing' in evm || !revenue) {
    const gaps = 'missing' in evm ? [...evm.missing] : [];
    if (!revenue) gaps.push('projects.contractRevenue');
    return missing(`Gross margin requires: ${gaps.join(', ')}.`, gaps);
  }
  return { value: round(safeDivide((revenue - evm.ac) * 100, revenue), 2), sampleSize: 1 };
};

const costPerStoryPoint: Calculator = (ctx) => {
  const evm = computeEvm(ctx);
  if ('missing' in evm) return missing(`Requires: ${evm.missing.join(', ')}.`, evm.missing);
  const points = sum(completed(ctx).map((w) => w.storyPoints ?? 0));
  if (points === 0) return missing('No story points completed in the period.', ['WorkItems.StoryPoints']);
  return { value: round(safeDivide(evm.ac, points), 2), sampleSize: points };
};

const costPerFeature: Calculator = (ctx) => {
  const evm = computeEvm(ctx);
  if ('missing' in evm) return missing(`Requires: ${evm.missing.join(', ')}.`, evm.missing);
  const features = completed(ctx).filter((w) => /feature/i.test(w.type)).length;
  if (features === 0) return missing('No features completed in the period.', ['WorkItems']);
  return { value: round(safeDivide(evm.ac, features), 2), sampleSize: features };
};

const effortVariance: Calculator = (ctx) => {
  const items = completed(ctx).filter(
    (w) => typeof w.originalEstimate === 'number' && w.originalEstimate! > 0 && typeof w.completedWork === 'number',
  );
  if (items.length === 0) {
    return missing('No completed items carry both estimate and actual effort.', [
      'WorkItems.OriginalEstimate',
      'WorkItems.CompletedWork',
    ]);
  }
  const estimated = sum(items.map((w) => w.originalEstimate!));
  const actual = sum(items.map((w) => w.completedWork!));
  return { value: round(safeDivide((actual - estimated) * 100, estimated), 2), sampleSize: items.length };
};

const rateRealization: Calculator = (ctx) => {
  const p = ctx.reference.project;
  if (!p?.actualBilledRate || !p?.standardRate) {
    return missing('Rate realisation requires `actualBilledRate` and `standardRate` in reference data.', [
      'projects.actualBilledRate',
      'projects.standardRate',
    ]);
  }
  return { value: round(safeDivide(p.actualBilledRate * 100, p.standardRate), 2), sampleSize: 1 };
};

// ── domain 8: cloud FinOps ─────────────────────────────────────────────────────

const tagCoverage: Calculator = (ctx) => {
  if (ctx.cloudCosts.length === 0) {
    return missing('No Azure cost records available for this scope.', ['AzureCostManagement']);
  }
  const key = ctx.reference.conventions?.projectTagKey ?? 'ado-project';
  const total = sum(ctx.cloudCosts.map((c) => c.cost));
  const tagged = sum(ctx.cloudCosts.filter((c) => Boolean(c.tags[key])).map((c) => c.cost));
  return { value: round(safeDivide(tagged * 100, total), 2), sampleSize: ctx.cloudCosts.length };
};

const costPerProject: Calculator = (ctx) => {
  if (ctx.cloudCosts.length === 0) {
    return missing('No Azure cost records available for this scope.', ['AzureCostManagement']);
  }
  const key = ctx.reference.conventions?.projectTagKey ?? 'ado-project';
  const target = ctx.scope.project;
  const relevant = target
    ? ctx.cloudCosts.filter((c) => c.tags[key] === target)
    : ctx.cloudCosts;
  const months = Math.max(1, periodDays(ctx) / 30.44);
  return {
    value: round(sum(relevant.map((c) => c.cost)) / months, 2),
    sampleSize: relevant.length,
  };
};

const nonprodWaste: Calculator = (ctx) => {
  const nonprod = ctx.cloudCosts.filter((c) =>
    ['dev', 'test', 'staging', 'sandbox'].includes((c.environment ?? '').toLowerCase()),
  );
  if (nonprod.length === 0) {
    return missing(
      'No resources are tagged as non-production. Apply the `environment` tag to enable this KPI.',
      ['tags.environment'],
    );
  }
  const total = sum(nonprod.map((c) => c.cost));
  const offHours = sum(nonprod.map((c) => c.cost * (c.offHoursCostShare ?? 0)));
  if (offHours === 0) {
    return missing(
      'Off-hours cost share is unavailable. It requires either hourly cost granularity or an ' +
        'Azure Monitor utilisation join.',
      ['AzureMonitor.utilization'],
    );
  }
  return { value: round(safeDivide(offHours * 100, total), 2), sampleSize: nonprod.length };
};

const idleResourceCost: Calculator = (ctx) => {
  const threshold = ctx.reference.conventions?.idleUtilizationThreshold ?? 5;
  const candidates = ctx.cloudCosts.filter(
    (c) =>
      typeof c.utilizationPercent === 'number' &&
      c.utilizationPercent < threshold &&
      ['dev', 'test', 'staging', 'sandbox'].includes((c.environment ?? '').toLowerCase()),
  );
  if (ctx.cloudCosts.length === 0) {
    return missing('No Azure cost records available for this scope.', ['AzureCostManagement']);
  }
  if (candidates.length === 0 && !ctx.cloudCosts.some((c) => typeof c.utilizationPercent === 'number')) {
    return missing('No utilisation data joined to cost records.', ['AzureMonitor.utilization']);
  }
  const months = Math.max(1, periodDays(ctx) / 30.44);
  return {
    value: round(sum(candidates.map((c) => c.cost)) / months, 2),
    sampleSize: candidates.length,
  };
};

const cloudCostPerDeployment: Calculator = (ctx) => {
  const deployments = productionRuns(ctx).filter((r) => r.succeeded).length;
  if (deployments === 0) return missing('No successful production deployments in the period.', ['PipelineRuns']);
  if (ctx.cloudCosts.length === 0) return missing('No Azure cost records available.', ['AzureCostManagement']);
  return {
    value: round(safeDivide(sum(ctx.cloudCosts.map((c) => c.cost)), deployments), 2),
    sampleSize: deployments,
  };
};

const cloudCostPerEngineer: Calculator = (ctx) => {
  const contributors = new Set(
    ctx.workItems.map((w) => w.contributorKey).filter((k): k is string => Boolean(k)),
  );
  if (contributors.size === 0) {
    return missing('No contributor activity in scope to normalise against.', ['WorkItems']);
  }
  const nonprod = ctx.cloudCosts.filter((c) =>
    ['dev', 'test', 'staging', 'sandbox'].includes((c.environment ?? '').toLowerCase()),
  );
  if (nonprod.length === 0) return missing('No non-production cost records available.', ['AzureCostManagement']);
  const months = Math.max(1, periodDays(ctx) / 30.44);
  return {
    value: round(sum(nonprod.map((c) => c.cost)) / months / contributors.size, 2),
    sampleSize: contributors.size,
  };
};

// ── registry ───────────────────────────────────────────────────────────────────

export const CALCULATORS: Record<string, Calculator> = {
  'delivery.deployment_frequency': deploymentFrequency,
  'delivery.change_lead_time': changeLeadTime,
  'delivery.change_failure_rate': changeFailureRate,
  'delivery.mttr': mttr,
  'delivery.deployment_rework_rate': deploymentReworkRate,

  'flow.velocity': flowVelocity,
  'flow.flow_time': flowTime,
  'flow.cycle_time': cycleTime,
  'flow.flow_efficiency': flowEfficiency,
  'flow.flow_load': flowLoad,
  'flow.flow_distribution': flowDistribution,

  'agile.velocity_points': velocityPoints,
  'agile.sprint_burndown': sprintBurndown,
  'agile.say_do_ratio': sayDoRatio,
  'agile.escaped_defects': escapedDefects,
  'agile.defect_density': defectDensity,
  'agile.rework_rate': reworkRate,
  'agile.backlog_aging': backlogAging,
  'agile.estimation_accuracy': estimationAccuracy,

  'code.pr_cycle_time': prCycleTime,
  'code.review_latency': reviewLatency,
  'code.pr_size': prSize,
  'code.revert_rate': revertRate,
  'code.build_success_rate': buildSuccessRate,
  'code.build_duration': buildDuration,
  'code.test_pass_rate': testPassRate,
  'code.flaky_test_rate': flakyTestRate,
  'code.code_coverage': codeCoverage,

  'pipeline.minutes_consumed': minutesConsumed,
  'pipeline.queue_wait_time': queueWaitTime,
  'pipeline.failed_run_waste': failedRunWaste,
  'pipeline.agent_pool_utilization': agentPoolUtilization,
  'pipeline.cost_per_run': costPerRun,
  'pipeline.cost_per_successful_build': costPerSuccessfulBuild,
  'pipeline.artifact_storage_cost': artifactStorageCost,

  'team.capacity_vs_actual': capacityVsActual,
  'team.utilization_rate': utilizationRate,
  'team.billable_ratio': billableRatio,
  'team.focus_factor': focusFactor,
  'team.unplanned_work': unplannedWork,
  'team.context_switching': contextSwitching,
  'team.knowledge_concentration': knowledgeConcentration,

  'profitability.actual_cost': evmCalculator((e) => e.ac),
  'profitability.earned_value': evmCalculator((e) => e.ev),
  'profitability.cost_variance': evmCalculator((e) => e.ev - e.ac),
  'profitability.schedule_variance': evmCalculator((e) => e.ev - e.pv),
  'profitability.cpi': evmCalculator((e) => e.cpi, 3),
  'profitability.spi': evmCalculator((e) => e.spi, 3),
  'profitability.eac': evmCalculator((e) => (e.cpi ? e.bac / e.cpi : null)),
  'profitability.etc': evmCalculator((e) => (e.cpi ? e.bac / e.cpi - e.ac : null)),
  'profitability.burn_rate': evmCalculator((e) => (e.bac ? (e.ac / e.bac) * 100 : null)),
  'profitability.gross_margin': grossMargin,
  'profitability.cost_per_story_point': costPerStoryPoint,
  'profitability.cost_per_feature': costPerFeature,
  'profitability.effort_variance': effortVariance,
  'profitability.rate_realization': rateRealization,

  'cloudfinops.tag_coverage': tagCoverage,
  'cloudfinops.cost_per_project': costPerProject,
  'cloudfinops.nonprod_waste': nonprodWaste,
  'cloudfinops.idle_resource_cost': idleResourceCost,
  'cloudfinops.cost_per_deployment': cloudCostPerDeployment,
  'cloudfinops.cost_per_engineer': cloudCostPerEngineer,
};

/** Every catalog KPI must have a calculator; verified by a test so the two cannot drift. */
export function hasCalculator(kpi: KpiDefinition): boolean {
  return kpi.id in CALCULATORS;
}
