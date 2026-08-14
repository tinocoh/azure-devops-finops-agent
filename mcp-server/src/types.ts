/**
 * Core domain types for the Azure DevOps KPI engine.
 *
 * The engine is deliberately source-agnostic: a `MetricProvider` supplies raw facts and the
 * KPI layer turns them into scored, interpreted results. That separation is what allows the
 * same formulas to run against a live Azure DevOps organisation and against seeded demo data.
 */

export type Direction = 'higher_is_better' | 'lower_is_better' | 'target_band';
export type Feasibility = 'native' | 'derived' | 'external';
export type Aggregation = 'organization' | 'project' | 'team' | 'repository' | 'person';
export type Status = 'good' | 'warn' | 'bad' | 'unknown' | 'unavailable';

export interface KpiSource {
  system: string;
  entity?: string;
  fields?: string[];
  filter?: string;
  notes?: string;
  api_version?: string;
  field?: string;
}

export interface KpiThresholds {
  good?: number;
  warn?: number;
  bad?: number;
}

export interface KpiDefinition {
  id: string;
  revision: number;
  name: string;
  short_name?: string;
  domain: string;
  domainName: string;
  formula: string;
  formula_display?: string;
  unit: string;
  direction: Direction;
  feasibility: Feasibility;
  sources: KpiSource[];
  benchmarks?: Record<string, string>;
  thresholds?: KpiThresholds;
  threshold_basis?: string;
  percentiles?: number[];
  interpretation?: string;
  caveats?: string[];
  pairs_with?: string[];
  /** Lowest aggregation level at which this KPI may be computed. Enforced by the guard layer. */
  min_aggregation?: Aggregation;
  sensitivity?: 'normal' | 'high';
}

export interface KpiDomain {
  id: string;
  name: string;
  order: number;
  description: string;
  audience: string[];
  governance?: string;
  requires_reference_data?: string[];
  requires?: string[];
  tagging_contract?: unknown;
  definitions?: Record<string, string>;
}

export interface Catalog {
  domains: KpiDomain[];
  kpis: KpiDefinition[];
}

/** A scope identifies what a KPI is computed over. */
export interface Scope {
  organization: string;
  project?: string;
  team?: string;
  repository?: string;
  aggregation: Aggregation;
}

export interface Period {
  /** Inclusive ISO date. */
  from: string;
  /** Exclusive ISO date. */
  to: string;
  label?: string;
}

export interface KpiValue {
  kpiId: string;
  revision: number;
  name: string;
  domain: string;
  value: number | null;
  unit: string;
  direction: Direction;
  status: Status;
  /** Percentile breakdown for distribution KPIs. */
  percentiles?: Record<string, number>;
  /** Prior-period value, when a comparison was requested. */
  previousValue?: number | null;
  /** Signed change vs previous period, in the KPI's own unit. */
  delta?: number | null;
  /** Change expressed as a percentage of the previous value. */
  deltaPercent?: number | null;
  /** True when a change is an improvement, accounting for direction. */
  improving?: boolean | null;
  trend?: TrendPoint[];
  /** Why the value is null, when it is. */
  unavailableReason?: string;
  /** Inputs the KPI needed but did not receive. */
  missingInputs?: string[];
  benchmark?: string;
  interpretation?: string;
  sampleSize?: number;
  confidence?: 'high' | 'medium' | 'low';
}

export interface TrendPoint {
  period: string;
  value: number | null;
}

export interface Scorecard {
  scope: Scope;
  period: Period;
  generatedAt: string;
  catalogVersion: string;
  domains: ScorecardDomain[];
  headline: KpiValue[];
  overallScore: number | null;
  dataQuality: DataQuality;
}

export interface ScorecardDomain {
  id: string;
  name: string;
  score: number | null;
  kpis: KpiValue[];
}

export interface DataQuality {
  /** Share of requested KPIs that produced a value. */
  completeness: number;
  tagCoverage?: number | null;
  referenceDataLoaded: string[];
  referenceDataMissing: string[];
  warnings: string[];
}

/**
 * Raw facts a provider must be able to supply. Anything the engine needs that is not here is,
 * by definition, reference data supplied by the operator rather than by Azure DevOps.
 */
export interface MetricProvider {
  readonly kind: 'live' | 'demo';
  readonly description: string;

  listProjects(organization: string): Promise<ProjectRef[]>;
  listTeams(organization: string, project: string): Promise<TeamRef[]>;

  workItems(scope: Scope, period: Period): Promise<WorkItemFact[]>;
  workItemSnapshots(scope: Scope, period: Period): Promise<SnapshotFact[]>;
  pipelineRuns(scope: Scope, period: Period): Promise<PipelineRunFact[]>;
  pullRequests(scope: Scope, period: Period): Promise<PullRequestFact[]>;
  testResults(scope: Scope, period: Period): Promise<TestResultFact[]>;
  capacity(scope: Scope, period: Period): Promise<CapacityFact[]>;
  cloudCosts(scope: Scope, period: Period): Promise<CloudCostFact[]>;
}

export interface ProjectRef { id: string; name: string; }
export interface TeamRef { id: string; name: string; project: string; }

export interface WorkItemFact {
  id: number;
  type: string;
  state: string;
  stateCategory: 'Proposed' | 'InProgress' | 'Completed' | 'Resolved' | 'Removed';
  createdDate: string;
  activatedDate?: string | null;
  closedDate?: string | null;
  leadTimeDays?: number | null;
  cycleTimeDays?: number | null;
  storyPoints?: number | null;
  originalEstimate?: number | null;
  completedWork?: number | null;
  iteration?: string | null;
  tags: string[];
  /** Opaque, non-identifying contributor key. Never a display name or e-mail. */
  contributorKey?: string | null;
  isProductionIncident?: boolean;
  addedAfterIterationStart?: boolean;
  reopenCount?: number;
  reassignCount?: number;
  committedAtIterationStart?: boolean;
}

export interface SnapshotFact {
  date: string;
  iteration: string | null;
  inProgressCount: number;
  remainingStoryPoints: number;
  totalStoryPoints: number;
}

export interface PipelineRunFact {
  id: number;
  pipelineName: string;
  stageName?: string | null;
  environment?: string | null;
  completedDate: string;
  succeeded: boolean;
  runDurationSeconds: number;
  queueDurationSeconds: number;
  agentType: 'microsoft-hosted' | 'self-hosted';
  poolName?: string | null;
  isProduction: boolean;
  isIncidentTriggered?: boolean;
  /** Timestamp of the earliest commit included in this run, when traceable. */
  firstCommitDate?: string | null;
}

export interface PullRequestFact {
  id: number;
  repository: string;
  createdDate: string;
  closedDate?: string | null;
  firstReviewDate?: string | null;
  linesAdded: number;
  linesDeleted: number;
  isRevert: boolean;
  merged: boolean;
}

export interface TestResultFact {
  date: string;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  coveragePercent?: number | null;
}

export interface CapacityFact {
  iteration: string;
  teamSize: number;
  plannedCapacityHours: number;
  availableHours: number;
}

export interface CloudCostFact {
  date: string;
  resourceId: string;
  serviceName: string;
  cost: number;
  currency: string;
  tags: Record<string, string>;
  environment?: string | null;
  /** Average utilisation over the period, where Azure Monitor data is available. */
  utilizationPercent?: number | null;
  /** Share of the cost incurred outside configured working hours. */
  offHoursCostShare?: number | null;
}
