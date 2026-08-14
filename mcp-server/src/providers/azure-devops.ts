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
import type { Conventions } from '../kpi/reference.js';
import type { TokenProvider } from '../auth/tokens.js';

/**
 * Live Azure DevOps provider.
 *
 * All aggregation that can be pushed into Analytics OData is pushed there via `$apply`, because
 * the alternative — paging millions of work item rows into this process — is exactly the failure
 * mode that made a pure low-code implementation unworkable (see ADR-0001).
 *
 * Where an aggregate cannot express the KPI (percentiles, for instance, which OData cannot
 * compute), the provider requests only the projected columns it needs and pages with a hard cap.
 */

export interface LiveProviderOptions {
  organization: string;
  tokens: TokenProvider;
  conventions?: Conventions;
  /** Analytics OData version. v2.0 is the stable endpoint; v4.0-preview adds pipeline snapshots. */
  analyticsVersion?: 'v2.0' | 'v3.0-preview' | 'v4.0-preview';
  /** Hard cap on rows pulled for any single non-aggregated query. */
  maxRows?: number;
  /** Azure subscription IDs to query for cost. Empty disables cloud FinOps KPIs. */
  costSubscriptionIds?: string[];
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_ROWS = 20_000;
const PAGE_SIZE = 1_000;

export class AzureDevOpsProvider implements MetricProvider {
  readonly kind = 'live' as const;
  readonly description = 'Live Azure DevOps Analytics OData, Azure DevOps REST and Azure Cost Management.';

  private readonly org: string;
  private readonly tokens: TokenProvider;
  private readonly conventions: Conventions;
  private readonly version: string;
  private readonly maxRows: number;
  private readonly costSubscriptions: string[];
  private readonly http: typeof fetch;

  constructor(options: LiveProviderOptions) {
    this.org = options.organization;
    this.tokens = options.tokens;
    this.conventions = options.conventions ?? {};
    this.version = options.analyticsVersion ?? 'v2.0';
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.costSubscriptions = options.costSubscriptionIds ?? [];
    this.http = options.fetchImpl ?? fetch;
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────────

  private analyticsUrl(scope: Scope, entity: string, query: string): string {
    const projectSegment = scope.project ? `/${encodeURIComponent(scope.project)}` : '';
    return `https://analytics.dev.azure.com/${this.org}${projectSegment}/_odata/${this.version}/${entity}?${query}`;
  }

  private async getJson<T>(url: string, resource: 'devops' | 'azure'): Promise<T> {
    const token = await this.tokens.getToken(resource);
    const response = await this.http(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(response.status, url, body.slice(0, 500));
    }
    return (await response.json()) as T;
  }

  /** Follows @odata.nextLink up to the configured row cap. */
  private async getAll<T>(url: string): Promise<T[]> {
    const rows: T[] = [];
    let next: string | undefined = url;
    while (next && rows.length < this.maxRows) {
      const page: { value: T[]; '@odata.nextLink'?: string } = await this.getJson(next, 'devops');
      rows.push(...page.value);
      next = page['@odata.nextLink'];
    }
    if (rows.length >= this.maxRows) {
      // Truncation is surfaced rather than silently tolerated: a KPI computed on a truncated
      // set is worse than no KPI at all.
      throw new TruncationError(url, this.maxRows);
    }
    return rows;
  }

  private odataDate(iso: string): string {
    return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private scopeFilter(scope: Scope, teamField = 'Teams/any(t: t/TeamName eq %s)'): string {
    if (!scope.team) return '';
    return ` and ${teamField.replace('%s', `'${escapeOData(scope.team)}'`)}`;
  }

  // ── discovery ────────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRef[]> {
    const url = `https://dev.azure.com/${this.org}/_apis/projects?api-version=7.1&$top=200`;
    const result = await this.getJson<{ value: { id: string; name: string }[] }>(url, 'devops');
    return result.value.map((p) => ({ id: p.id, name: p.name }));
  }

  async listTeams(_organization: string, project: string): Promise<TeamRef[]> {
    const url = `https://dev.azure.com/${this.org}/_apis/projects/${encodeURIComponent(
      project,
    )}/teams?api-version=7.1`;
    const result = await this.getJson<{ value: { id: string; name: string }[] }>(url, 'devops');
    return result.value.map((t) => ({ id: t.id, name: t.name, project }));
  }

  // ── facts ────────────────────────────────────────────────────────────────────

  async workItems(scope: Scope, period: Period): Promise<WorkItemFact[]> {
    const filter =
      `CreatedDate ge ${this.odataDate(period.from)} and CreatedDate lt ${this.odataDate(period.to)}` +
      this.scopeFilter(scope);

    const select = [
      'WorkItemId',
      'WorkItemType',
      'State',
      'StateCategory',
      'CreatedDate',
      'ActivatedDate',
      'ClosedDate',
      'LeadTimeDays',
      'CycleTimeDays',
      'StoryPoints',
      'OriginalEstimate',
      'CompletedWork',
      'TagNames',
      'Priority',
    ].join(',');

    const url = this.analyticsUrl(
      scope,
      'WorkItems',
      `$filter=${encodeURIComponent(filter)}&$select=${select}` +
        `&$expand=${encodeURIComponent('Iteration($select=IterationName)')}&$top=${PAGE_SIZE}`,
    );

    const rows = await this.getAll<AnalyticsWorkItem>(url);
    const incident = this.conventions.incidentSelector;

    return rows.map((r) => {
      const tags = (r.TagNames ?? '').split(';').map((t) => t.trim()).filter(Boolean);
      return {
        id: r.WorkItemId,
        type: r.WorkItemType,
        state: r.State,
        stateCategory: (r.StateCategory ?? 'Proposed') as WorkItemFact['stateCategory'],
        createdDate: r.CreatedDate,
        activatedDate: r.ActivatedDate ?? null,
        closedDate: r.ClosedDate ?? null,
        leadTimeDays: r.LeadTimeDays ?? null,
        cycleTimeDays: r.CycleTimeDays ?? null,
        storyPoints: r.StoryPoints ?? null,
        originalEstimate: r.OriginalEstimate ?? null,
        completedWork: r.CompletedWork ?? null,
        iteration: r.Iteration?.IterationName ?? null,
        tags,
        // Deliberately not populated from AssignedTo. The engine has no per-person KPIs and
        // therefore has no reason to hold a person identifier.
        contributorKey: null,
        isProductionIncident: matchesIncident(r, tags, incident),
        addedAfterIterationStart: false,
        reopenCount: 0,
        reassignCount: 0,
        committedAtIterationStart: false,
      } satisfies WorkItemFact;
    });
  }

  async workItemSnapshots(scope: Scope, period: Period): Promise<SnapshotFact[]> {
    // Aggregated server-side: one row per day rather than one row per item per day.
    const filter =
      `DateValue ge ${this.odataDate(period.from)} and DateValue lt ${this.odataDate(period.to)}` +
      ` and StateCategory eq 'InProgress'`;

    const apply =
      `filter(${filter})/groupby((DateValue),` +
      `aggregate($count as InProgressCount, StoryPoints with sum as RemainingPoints))`;

    const url = this.analyticsUrl(scope, 'WorkItemSnapshot', `$apply=${encodeURIComponent(apply)}`);

    try {
      const result = await this.getJson<{ value: AnalyticsSnapshot[] }>(url, 'devops');
      return result.value.map((r) => ({
        date: r.DateValue,
        iteration: null,
        inProgressCount: r.InProgressCount ?? 0,
        remainingStoryPoints: r.RemainingPoints ?? 0,
        totalStoryPoints: 0,
      }));
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return [];
      throw error;
    }
  }

  async pipelineRuns(scope: Scope, period: Period): Promise<PipelineRunFact[]> {
    const filter =
      `CompletedDate ge ${this.odataDate(period.from)} and CompletedDate lt ${this.odataDate(period.to)}`;

    const url = this.analyticsUrl(
      scope,
      'PipelineRuns',
      `$filter=${encodeURIComponent(filter)}` +
        `&$select=RunId,RunDurationSeconds,QueueDurationSeconds,CompletedDate,SucceededCount,FailedCount` +
        `&$expand=${encodeURIComponent('Pipeline($select=PipelineName)')}&$top=${PAGE_SIZE}`,
    );

    const rows = await this.getAll<AnalyticsPipelineRun>(url);
    const selector = this.conventions.productionSelector;

    return rows.map((r) => {
      const pipelineName = r.Pipeline?.PipelineName ?? '';
      return {
        id: r.RunId,
        pipelineName,
        stageName: null,
        environment: null,
        completedDate: r.CompletedDate,
        succeeded: (r.SucceededCount ?? 0) > 0 && (r.FailedCount ?? 0) === 0,
        runDurationSeconds: r.RunDurationSeconds ?? 0,
        queueDurationSeconds: r.QueueDurationSeconds ?? 0,
        // Analytics does not expose the agent type; assume Microsoft-hosted unless the
        // operator maps pools explicitly in reference data.
        agentType: 'microsoft-hosted',
        poolName: null,
        isProduction: isProductionRun(pipelineName, null, null, [], selector),
        isIncidentTriggered: false,
        firstCommitDate: null,
      } satisfies PipelineRunFact;
    });
  }

  async pullRequests(scope: Scope, period: Period): Promise<PullRequestFact[]> {
    if (!scope.project) return [];
    const from = new Date(period.from).toISOString();
    const to = new Date(period.to).toISOString();
    const url =
      `https://dev.azure.com/${this.org}/${encodeURIComponent(scope.project)}/_apis/git/pullrequests` +
      `?api-version=7.1&searchCriteria.status=completed` +
      `&searchCriteria.minTime=${encodeURIComponent(from)}&searchCriteria.maxTime=${encodeURIComponent(to)}` +
      `&searchCriteria.queryTimeRangeType=closed&$top=${PAGE_SIZE}`;

    const result = await this.getJson<{ value: RestPullRequest[] }>(url, 'devops');
    return result.value.map((pr) => ({
      id: pr.pullRequestId,
      repository: pr.repository?.name ?? 'unknown',
      createdDate: pr.creationDate,
      closedDate: pr.closedDate ?? null,
      // First-review timing requires a per-PR threads call; enable the enrichment step
      // explicitly because it is O(n) additional requests.
      firstReviewDate: null,
      linesAdded: 0,
      linesDeleted: 0,
      isRevert: /^revert\b/i.test(pr.title ?? ''),
      merged: pr.status === 'completed',
    }));
  }

  async testResults(scope: Scope, period: Period): Promise<TestResultFact[]> {
    const filter =
      `Date/Date ge ${this.odataDate(period.from)} and Date/Date lt ${this.odataDate(period.to)}`;
    const apply =
      `filter(${filter})/groupby((Date/Date),` +
      `aggregate(ResultCount with sum as Total, ResultPassCount with sum as Passed, ` +
      `ResultFailCount with sum as Failed))`;

    const url = this.analyticsUrl(scope, 'TestResultsDaily', `$apply=${encodeURIComponent(apply)}`);

    try {
      const result = await this.getJson<{ value: AnalyticsTestDaily[] }>(url, 'devops');
      return result.value.map((r) => ({
        date: r.Date?.Date ?? period.from,
        totalCount: r.Total ?? 0,
        passedCount: r.Passed ?? 0,
        failedCount: r.Failed ?? 0,
        flakyCount: 0,
        coveragePercent: null,
      }));
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return [];
      throw error;
    }
  }

  async capacity(scope: Scope, period: Period): Promise<CapacityFact[]> {
    if (!scope.project || !scope.team) return [];
    const iterationsUrl =
      `https://dev.azure.com/${this.org}/${encodeURIComponent(scope.project)}/${encodeURIComponent(
        scope.team,
      )}/_apis/work/teamsettings/iterations?api-version=7.1`;

    const iterations = await this.getJson<{ value: RestIteration[] }>(iterationsUrl, 'devops');
    const inRange = iterations.value.filter((it) => {
      const start = it.attributes?.startDate;
      return start && start >= period.from && start < period.to;
    });

    const facts: CapacityFact[] = [];
    for (const iteration of inRange) {
      const capacityUrl =
        `https://dev.azure.com/${this.org}/${encodeURIComponent(scope.project)}/${encodeURIComponent(
          scope.team,
        )}/_apis/work/teamsettings/iterations/${iteration.id}/capacities?api-version=7.1`;

      try {
        const capacities = await this.getJson<{ value: RestCapacity[] }>(capacityUrl, 'devops');
        const workingDays = 10;
        const perDay = capacities.value.reduce(
          (total, member) =>
            total + (member.activities ?? []).reduce((a, act) => a + (act.capacityPerDay ?? 0), 0),
          0,
        );
        facts.push({
          iteration: iteration.name,
          teamSize: capacities.value.length,
          plannedCapacityHours: perDay * workingDays,
          availableHours: perDay * workingDays,
        });
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 404)) throw error;
      }
    }
    return facts;
  }

  async cloudCosts(scope: Scope, period: Period): Promise<CloudCostFact[]> {
    if (this.costSubscriptions.length === 0) return [];

    const tagKey = this.conventions.projectTagKey ?? 'ado-project';
    const results: CloudCostFact[] = [];

    for (const subscriptionId of this.costSubscriptions) {
      const url =
        `https://management.azure.com/subscriptions/${subscriptionId}` +
        `/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;

      const body = {
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: { from: period.from, to: period.to },
        dataset: {
          granularity: 'Daily',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ServiceName' },
            { type: 'TagKey', name: tagKey },
            { type: 'TagKey', name: 'environment' },
          ],
        },
      };

      const token = await this.tokens.getToken('azure');
      const response = await this.http(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ProviderError(response.status, url, text.slice(0, 500));
      }

      const payload = (await response.json()) as CostQueryResponse;
      const columns = payload.properties.columns.map((c) => c.name);
      const idx = (name: string) => columns.indexOf(name);

      for (const row of payload.properties.rows) {
        const projectTag = String(row[idx(tagKey)] ?? '');
        const environment = String(row[idx('environment')] ?? '') || null;
        results.push({
          date: String(row[idx('UsageDate')] ?? period.from),
          resourceId: `${subscriptionId}`,
          serviceName: String(row[idx('ServiceName')] ?? 'unknown'),
          cost: Number(row[idx('Cost')] ?? 0),
          currency: String(row[idx('Currency')] ?? 'USD'),
          tags: projectTag ? { [tagKey]: projectTag, environment: environment ?? '' } : {},
          environment,
          utilizationPercent: null,
          offHoursCostShare: null,
        });
      }
    }

    if (scope.project) {
      return results.filter((r) => !r.tags[tagKey] || r.tags[tagKey] === scope.project);
    }
    return results;
  }
}

// ── errors ───────────────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Azure DevOps request failed with HTTP ${status}. ${body}`);
    this.name = 'ProviderError';
  }
}

export class TruncationError extends Error {
  constructor(
    readonly url: string,
    readonly cap: number,
  ) {
    super(
      `Query exceeded the ${cap}-row safety cap. Narrow the period or the scope, or push the ` +
        'aggregation into OData with $apply. A KPI computed on truncated data would be wrong.',
    );
    this.name = 'TruncationError';
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

export function isProductionRun(
  pipelineName: string,
  stageName: string | null,
  environmentName: string | null,
  tags: string[],
  selector?: Conventions['productionSelector'],
): boolean {
  if (!selector) return false;
  if (selector.tag && tags.includes(selector.tag)) return true;
  if (selector.pipelineNamePattern && new RegExp(selector.pipelineNamePattern, 'i').test(pipelineName)) {
    return true;
  }
  if (selector.stageNamePattern && stageName && new RegExp(selector.stageNamePattern, 'i').test(stageName)) {
    return true;
  }
  if (
    selector.environmentNamePattern &&
    environmentName &&
    new RegExp(selector.environmentNamePattern, 'i').test(environmentName)
  ) {
    return true;
  }
  return false;
}

function matchesIncident(
  row: AnalyticsWorkItem,
  tags: string[],
  selector?: Conventions['incidentSelector'],
): boolean {
  if (!selector) return false;
  if (selector.workItemType && row.WorkItemType !== selector.workItemType) return false;
  if (selector.tag && !tags.includes(selector.tag)) return false;
  if (selector.priorityAtOrBelow !== undefined && (row.Priority ?? 99) > selector.priorityAtOrBelow) {
    return false;
  }
  return true;
}

// ── wire shapes ──────────────────────────────────────────────────────────────────

interface AnalyticsWorkItem {
  WorkItemId: number;
  WorkItemType: string;
  State: string;
  StateCategory?: string;
  CreatedDate: string;
  ActivatedDate?: string;
  ClosedDate?: string;
  LeadTimeDays?: number;
  CycleTimeDays?: number;
  StoryPoints?: number;
  OriginalEstimate?: number;
  CompletedWork?: number;
  TagNames?: string;
  Priority?: number;
  Iteration?: { IterationName?: string };
}

interface AnalyticsSnapshot {
  DateValue: string;
  InProgressCount?: number;
  RemainingPoints?: number;
}

interface AnalyticsPipelineRun {
  RunId: number;
  RunDurationSeconds?: number;
  QueueDurationSeconds?: number;
  CompletedDate: string;
  SucceededCount?: number;
  FailedCount?: number;
  Pipeline?: { PipelineName?: string };
}

interface AnalyticsTestDaily {
  Date?: { Date?: string };
  Total?: number;
  Passed?: number;
  Failed?: number;
}

interface RestPullRequest {
  pullRequestId: number;
  title?: string;
  status: string;
  creationDate: string;
  closedDate?: string;
  repository?: { name?: string };
}

interface RestIteration {
  id: string;
  name: string;
  attributes?: { startDate?: string; finishDate?: string };
}

interface RestCapacity {
  activities?: { capacityPerDay?: number }[];
}

interface CostQueryResponse {
  properties: {
    columns: { name: string; type: string }[];
    rows: (string | number)[][];
  };
}
