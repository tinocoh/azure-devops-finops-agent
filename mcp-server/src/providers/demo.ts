import type {
  CapacityFact,
  CloudCostFact,
  MetricProvider,
  Period,
  PipelineRunFact,
  ProjectRef,
  PullRequestFact,
  Scope,
  SnapshotFact,
  TeamRef,
  TestResultFact,
  WorkItemFact,
} from '../types.js';

/**
 * Deterministic demo provider.
 *
 * Generates a plausible engineering organisation from a seed. The same seed always produces the
 * same organisation, which matters for two reasons: a demo can be rehearsed, and the KPI tests
 * can assert on exact numbers.
 *
 * The generated data is shaped to tell a story rather than to be uniformly random — one project
 * is healthy, one is under cost pressure, and one has a pipeline waste problem. That gives the
 * agent something worth reasoning about during a demonstration.
 */

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }
  between(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.between(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

interface ProjectProfile {
  name: string;
  /** Narrative shape used to bias the generated data. */
  archetype: 'healthy' | 'cost-pressure' | 'pipeline-waste' | 'delivery-risk';
  teams: string[];
  repositories: string[];
}

export const DEMO_PROJECTS: ProjectProfile[] = [
  {
    name: 'Contoso Payments',
    archetype: 'healthy',
    teams: ['Payments Core', 'Payments Experience'],
    repositories: ['payments-api', 'payments-web'],
  },
  {
    name: 'Contoso Retail Platform',
    archetype: 'cost-pressure',
    teams: ['Catalogue', 'Checkout', 'Fulfilment'],
    repositories: ['retail-catalogue', 'retail-checkout', 'retail-fulfilment'],
  },
  {
    name: 'Contoso Data Platform',
    archetype: 'pipeline-waste',
    teams: ['Ingestion', 'Analytics Services'],
    repositories: ['data-ingestion', 'data-analytics'],
  },
  {
    name: 'Contoso Mobile',
    archetype: 'delivery-risk',
    teams: ['Mobile Apps'],
    repositories: ['mobile-ios', 'mobile-android'],
  },
];

const WORK_ITEM_TYPES = ['User Story', 'Bug', 'Task', 'Feature'] as const;

interface ArchetypeBias {
  buildFailureRate: number;
  deployFailureRate: number;
  leadTimeDays: [number, number];
  flowEfficiency: number;
  reviewLatencyHours: [number, number];
  flakyRate: number;
  estimateInflation: number;
  cloudCostMultiplier: number;
  tagCoverage: number;
  unplannedRate: number;
}

const BIAS: Record<ProjectProfile['archetype'], ArchetypeBias> = {
  healthy: {
    buildFailureRate: 0.06,
    deployFailureRate: 0.03,
    leadTimeDays: [1, 6],
    flowEfficiency: 0.45,
    reviewLatencyHours: [0.5, 5],
    flakyRate: 0.004,
    estimateInflation: 1.05,
    cloudCostMultiplier: 1.0,
    tagCoverage: 0.98,
    unplannedRate: 0.12,
  },
  'cost-pressure': {
    buildFailureRate: 0.12,
    deployFailureRate: 0.08,
    leadTimeDays: [3, 18],
    flowEfficiency: 0.22,
    reviewLatencyHours: [4, 30],
    flakyRate: 0.015,
    estimateInflation: 1.45,
    cloudCostMultiplier: 2.6,
    tagCoverage: 0.71,
    unplannedRate: 0.28,
  },
  'pipeline-waste': {
    buildFailureRate: 0.34,
    deployFailureRate: 0.11,
    leadTimeDays: [2, 12],
    flowEfficiency: 0.3,
    reviewLatencyHours: [2, 20],
    flakyRate: 0.062,
    estimateInflation: 1.2,
    cloudCostMultiplier: 1.4,
    tagCoverage: 0.93,
    unplannedRate: 0.18,
  },
  'delivery-risk': {
    buildFailureRate: 0.18,
    deployFailureRate: 0.19,
    leadTimeDays: [6, 40],
    flowEfficiency: 0.14,
    reviewLatencyHours: [8, 60],
    flakyRate: 0.028,
    estimateInflation: 1.8,
    cloudCostMultiplier: 0.8,
    tagCoverage: 0.86,
    unplannedRate: 0.42,
  },
};

function hashSeed(...parts: (string | number | undefined)[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    const s = String(part ?? '');
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function profileFor(scope: Scope): ProjectProfile {
  return DEMO_PROJECTS.find((p) => p.name === scope.project) ?? DEMO_PROJECTS[0]!;
}

function iterationsIn(period: Period): { name: string; start: Date; end: Date }[] {
  const start = new Date(period.from);
  const end = new Date(period.to);
  const out: { name: string; start: Date; end: Date }[] = [];
  const cursor = new Date(start);
  let index = 1;
  while (cursor < end) {
    const iterEnd = new Date(cursor.getTime() + 14 * 86_400_000);
    out.push({
      name: `Sprint ${index}`,
      start: new Date(cursor),
      end: iterEnd > end ? end : iterEnd,
    });
    cursor.setTime(iterEnd.getTime());
    index += 1;
  }
  return out.length > 0 ? out : [{ name: 'Sprint 1', start, end }];
}

function scaleForScope(scope: Scope): number {
  if (scope.aggregation === 'organization') return 4;
  if (scope.aggregation === 'project') return 2;
  return 1;
}

export class DemoProvider implements MetricProvider {
  readonly kind = 'demo' as const;
  readonly description =
    'Deterministic seeded demo data. Four Contoso projects with distinct engineering ' +
    'health profiles. No network calls and no customer data.';

  constructor(private readonly seed = 20260814) {}

  async listProjects(): Promise<ProjectRef[]> {
    return DEMO_PROJECTS.map((p, i) => ({ id: `demo-project-${i + 1}`, name: p.name }));
  }

  async listTeams(_organization: string, project: string): Promise<TeamRef[]> {
    const profile = DEMO_PROJECTS.find((p) => p.name === project);
    return (profile?.teams ?? []).map((name, i) => ({ id: `demo-team-${i + 1}`, name, project }));
  }

  async workItems(scope: Scope, period: Period): Promise<WorkItemFact[]> {
    const profile = profileFor(scope);
    const bias = BIAS[profile.archetype];
    const rng = new Rng(hashSeed(this.seed, 'wi', scope.project, scope.team, period.from));
    const iterations = iterationsIn(period);
    const perIteration = Math.round(this.scaledCount(scope, 26));
    const items: WorkItemFact[] = [];
    let id = 1000;

    for (const iteration of iterations) {
      for (let i = 0; i < perIteration; i += 1) {
        const type = rng.pick(WORK_ITEM_TYPES);
        const created = new Date(
          iteration.start.getTime() - rng.between(0, 20) * 86_400_000,
        );
        const isDone = rng.chance(0.82);
        const leadTime = rng.between(bias.leadTimeDays[0], bias.leadTimeDays[1]);
        const cycleTime = leadTime * bias.flowEfficiency * rng.between(0.75, 1.25);
        const closed = isDone
          ? new Date(created.getTime() + leadTime * 86_400_000)
          : null;

        const estimate = rng.chance(0.75) ? Math.round(rng.between(2, 24)) : null;
        const actual =
          estimate !== null && isDone
            ? Math.round(estimate * bias.estimateInflation * rng.between(0.7, 1.35) * 10) / 10
            : null;

        const isBug = type === 'Bug';
        const isIncident = isBug && rng.chance(0.22);

        items.push({
          id: id++,
          type,
          state: isDone ? 'Closed' : rng.chance(0.5) ? 'Active' : 'New',
          stateCategory: isDone ? 'Completed' : rng.chance(0.5) ? 'InProgress' : 'Proposed',
          createdDate: created.toISOString(),
          activatedDate: new Date(created.getTime() + rng.between(0, 3) * 86_400_000).toISOString(),
          closedDate: closed?.toISOString() ?? null,
          leadTimeDays: isDone ? Math.round(leadTime * 100) / 100 : null,
          cycleTimeDays: isDone ? Math.round(cycleTime * 100) / 100 : null,
          storyPoints: type === 'Task' ? null : rng.pick([1, 2, 3, 5, 5, 8, 8, 13]),
          originalEstimate: estimate,
          completedWork: actual,
          iteration: iteration.name,
          tags: rng.chance(0.68) ? ['billable'] : [],
          contributorKey: `c_${rng.int(1, Math.max(3, Math.round(this.scaledCount(scope, 7))))}`,
          isProductionIncident: isIncident,
          addedAfterIterationStart: rng.chance(bias.unplannedRate),
          reopenCount: rng.chance(0.09) ? 1 : 0,
          reassignCount: rng.chance(0.3) ? rng.int(1, 3) : 0,
          committedAtIterationStart: rng.chance(0.8),
        });
      }
    }
    return items;
  }

  async workItemSnapshots(scope: Scope, period: Period): Promise<SnapshotFact[]> {
    const rng = new Rng(hashSeed(this.seed, 'snap', scope.project, period.from));
    const iterations = iterationsIn(period);
    const out: SnapshotFact[] = [];
    const teamSize = Math.round(this.scaledCount(scope, 7));

    for (const iteration of iterations) {
      const totalPoints = Math.round(rng.between(30, 60) * scaleForScope(scope));
      const days = Math.max(
        1,
        Math.round((iteration.end.getTime() - iteration.start.getTime()) / 86_400_000),
      );
      for (let d = 0; d <= days; d += 1) {
        const progress = d / days;
        // Deliberately non-linear: most burn-down happens late, which is realistic and gives
        // the agent something to comment on.
        const burned = totalPoints * Math.pow(progress, 1.7) * rng.between(0.9, 1.05);
        out.push({
          date: new Date(iteration.start.getTime() + d * 86_400_000).toISOString(),
          iteration: iteration.name,
          inProgressCount: Math.max(0, Math.round(teamSize * rng.between(1.1, 2.4))),
          remainingStoryPoints: Math.max(0, Math.round(totalPoints - burned)),
          totalStoryPoints: totalPoints,
        });
      }
    }
    return out;
  }

  async pipelineRuns(scope: Scope, period: Period): Promise<PipelineRunFact[]> {
    const profile = profileFor(scope);
    const bias = BIAS[profile.archetype];
    const rng = new Rng(hashSeed(this.seed, 'runs', scope.project, scope.team, period.from));
    const days = Math.max(1, (new Date(period.to).getTime() - new Date(period.from).getTime()) / 86_400_000);
    const runsPerDay = this.scaledCount(scope, 9);
    const total = Math.round(days * runsPerDay);
    const out: PipelineRunFact[] = [];

    for (let i = 0; i < total; i += 1) {
      const completed = new Date(
        new Date(period.from).getTime() + rng.next() * (days * 86_400_000),
      );
      const isProduction = rng.chance(0.16);
      const failureRate = isProduction ? bias.deployFailureRate : bias.buildFailureRate;
      const succeeded = !rng.chance(failureRate);
      const selfHosted = rng.chance(0.35);
      const baseDuration = isProduction ? rng.between(300, 1400) : rng.between(120, 900);

      out.push({
        id: 50_000 + i,
        pipelineName: isProduction
          ? `${rng.pick(profile.repositories)}-release`
          : `${rng.pick(profile.repositories)}-ci`,
        stageName: isProduction ? 'Production' : 'Build',
        environment: isProduction ? 'prod' : rng.pick(['dev', 'test']),
        completedDate: completed.toISOString(),
        succeeded,
        // Failed runs usually fail fast, which is why waste percentage is lower than
        // failure percentage — the agent should be able to explain that.
        runDurationSeconds: Math.round(succeeded ? baseDuration : baseDuration * rng.between(0.3, 0.8)),
        queueDurationSeconds: Math.round(
          selfHosted ? rng.between(5, 900) * (bias.buildFailureRate > 0.2 ? 2.2 : 1) : rng.between(2, 60),
        ),
        agentType: selfHosted ? 'self-hosted' : 'microsoft-hosted',
        poolName: selfHosted ? 'linux-selfhosted' : 'Azure Pipelines',
        isProduction,
        isIncidentTriggered: isProduction && rng.chance(bias.deployFailureRate * 1.4),
        firstCommitDate: new Date(
          completed.getTime() - rng.between(1, 96) * 3_600_000,
        ).toISOString(),
      });
    }
    return out;
  }

  async pullRequests(scope: Scope, period: Period): Promise<PullRequestFact[]> {
    const profile = profileFor(scope);
    const bias = BIAS[profile.archetype];
    const rng = new Rng(hashSeed(this.seed, 'pr', scope.project, scope.team, period.from));
    const days = Math.max(1, (new Date(period.to).getTime() - new Date(period.from).getTime()) / 86_400_000);
    const total = Math.round(days * this.scaledCount(scope, 3.2));
    const out: PullRequestFact[] = [];

    for (let i = 0; i < total; i += 1) {
      const created = new Date(new Date(period.from).getTime() + rng.next() * (days * 86_400_000));
      const reviewLatency = rng.between(bias.reviewLatencyHours[0], bias.reviewLatencyHours[1]);
      const merged = rng.chance(0.88);
      const cycle = reviewLatency + rng.between(1, 48);

      out.push({
        id: 9000 + i,
        repository: rng.pick(profile.repositories),
        createdDate: created.toISOString(),
        closedDate: new Date(created.getTime() + cycle * 3_600_000).toISOString(),
        firstReviewDate: rng.chance(0.93)
          ? new Date(created.getTime() + reviewLatency * 3_600_000).toISOString()
          : null,
        linesAdded: Math.round(rng.between(10, 900) * (bias.flowEfficiency < 0.25 ? 1.8 : 1)),
        linesDeleted: Math.round(rng.between(2, 350)),
        isRevert: rng.chance(bias.deployFailureRate * 0.3),
        merged,
      });
    }
    return out;
  }

  async testResults(scope: Scope, period: Period): Promise<TestResultFact[]> {
    const profile = profileFor(scope);
    const bias = BIAS[profile.archetype];
    const rng = new Rng(hashSeed(this.seed, 'test', scope.project, period.from));
    const days = Math.max(1, Math.round((new Date(period.to).getTime() - new Date(period.from).getTime()) / 86_400_000));
    const out: TestResultFact[] = [];
    const baseTotal = Math.round(this.scaledCount(scope, 1800));

    for (let d = 0; d < days; d += 1) {
      const total = Math.round(baseTotal * rng.between(0.9, 1.1));
      const flaky = Math.round(total * bias.flakyRate * rng.between(0.7, 1.4));
      const failed = Math.round(total * bias.buildFailureRate * 0.06 * rng.between(0.5, 1.5)) + flaky;
      out.push({
        date: new Date(new Date(period.from).getTime() + d * 86_400_000).toISOString(),
        totalCount: total,
        passedCount: total - failed,
        failedCount: failed,
        flakyCount: flaky,
        coveragePercent: Math.round(rng.between(52, 88) * 10) / 10,
      });
    }
    return out;
  }

  async capacity(scope: Scope, period: Period): Promise<CapacityFact[]> {
    const rng = new Rng(hashSeed(this.seed, 'cap', scope.project, scope.team, period.from));
    const teamSize = Math.round(this.scaledCount(scope, 7));
    return iterationsIn(period).map((iteration) => {
      const workingDays = 10;
      const hoursPerDay = 6;
      const planned = teamSize * workingDays * hoursPerDay;
      return {
        iteration: iteration.name,
        teamSize,
        plannedCapacityHours: Math.round(planned * rng.between(0.85, 1.0)),
        availableHours: planned,
      };
    });
  }

  async cloudCosts(scope: Scope, period: Period): Promise<CloudCostFact[]> {
    const profile = profileFor(scope);
    const bias = BIAS[profile.archetype];
    const rng = new Rng(hashSeed(this.seed, 'cost', scope.project, period.from));
    const days = Math.max(1, Math.round((new Date(period.to).getTime() - new Date(period.from).getTime()) / 86_400_000));
    const services = [
      'Azure App Service',
      'Azure Kubernetes Service',
      'Azure SQL Database',
      'Azure Storage',
      'Azure Monitor',
      'Azure DevOps Pipelines',
      'Virtual Machines',
    ];
    const environments = ['prod', 'prod', 'dev', 'test', 'staging'];
    const out: CloudCostFact[] = [];

    for (let d = 0; d < days; d += 1) {
      const date = new Date(new Date(period.from).getTime() + d * 86_400_000);
      for (const service of services) {
        for (const environment of environments) {
          const isNonProd = environment !== 'prod';
          const baseDaily = rng.between(40, 340) * bias.cloudCostMultiplier * (isNonProd ? 0.45 : 1);
          const tagged = rng.chance(bias.tagCoverage);

          out.push({
            date: date.toISOString(),
            resourceId: `/subscriptions/demo/resourceGroups/${profile.name
              .toLowerCase()
              .replace(/\s+/g, '-')}-${environment}/providers/${service.replace(/\s+/g, '')}`,
            serviceName: service,
            cost: Math.round(baseDaily * 100) / 100,
            currency: 'USD',
            tags: tagged
              ? {
                  'ado-project': profile.name,
                  'ado-organization': scope.organization,
                  environment,
                  'cost-center': `CC-${1000 + DEMO_PROJECTS.indexOf(profile)}`,
                }
              : { environment },
            environment,
            utilizationPercent: isNonProd
              ? Math.round(rng.between(1, 45) * 10) / 10
              : Math.round(rng.between(35, 88) * 10) / 10,
            // A non-production resource left running around the clock spends roughly
            // 73% of the week outside a 45-hour working window.
            offHoursCostShare: isNonProd ? Math.round(rng.between(0.55, 0.78) * 100) / 100 : 0.12,
          });
        }
      }
    }
    return out;
  }

  private scaledCount(scope: Scope, base: number): number {
    return base * scaleForScope(scope);
  }
}
