import { HEADLINE_KPIS, catalogVersion, getKpi, loadCatalog } from '../catalog.js';
import type {
  DataQuality,
  KpiDefinition,
  KpiValue,
  MetricProvider,
  Period,
  Scope,
  Scorecard,
  ScorecardDomain,
  Status,
  TrendPoint,
} from '../types.js';
import { CALCULATORS, type CalculatorContext } from './calculators.js';
import { GovernanceError, isAggregationAllowed, minimumAggregation, guidanceFor } from './guards.js';
import { EMPTY_REFERENCE, type ReferenceData } from './reference.js';
import { modifiedZScores, round, safeDivide } from './stats.js';

export interface EngineOptions {
  provider: MetricProvider;
  reference?: ReferenceData;
}

export class KpiEngine {
  private readonly provider: MetricProvider;
  private readonly reference: ReferenceData;

  constructor(options: EngineOptions) {
    this.provider = options.provider;
    this.reference = options.reference ?? EMPTY_REFERENCE;
  }

  get providerKind(): 'live' | 'demo' {
    return this.provider.kind;
  }

  get providerDescription(): string {
    return this.provider.description;
  }

  get referenceData(): ReferenceData {
    return this.reference;
  }

  listProjects(organization: string) {
    return this.provider.listProjects(organization);
  }

  listTeams(organization: string, project: string) {
    return this.provider.listTeams(organization, project);
  }

  /** Loads every fact needed for a scope and period exactly once. */
  private async buildContext(scope: Scope, period: Period): Promise<CalculatorContext> {
    const [workItems, snapshots, pipelineRuns, pullRequests, testResults, capacity, cloudCosts] =
      await Promise.all([
        this.provider.workItems(scope, period),
        this.provider.workItemSnapshots(scope, period),
        this.provider.pipelineRuns(scope, period),
        this.provider.pullRequests(scope, period),
        this.provider.testResults(scope, period),
        this.provider.capacity(scope, period),
        this.provider.cloudCosts(scope, period),
      ]);

    return {
      scope,
      period,
      workItems,
      snapshots,
      pipelineRuns,
      pullRequests,
      testResults,
      capacity,
      cloudCosts,
      reference: this.reference,
    };
  }

  /** Computes a single KPI within an already-built context. */
  private computeInContext(kpi: KpiDefinition, ctx: CalculatorContext): KpiValue {
    const base: KpiValue = {
      kpiId: kpi.id,
      revision: kpi.revision,
      name: kpi.name,
      domain: kpi.domain,
      value: null,
      unit: kpi.unit,
      direction: kpi.direction,
      status: 'unknown',
      benchmark: kpi.benchmarks ? Object.values(kpi.benchmarks)[0] : undefined,
      interpretation: kpi.interpretation,
    };

    if (!isAggregationAllowed(kpi, ctx.scope)) {
      return {
        ...base,
        status: 'unavailable',
        unavailableReason:
          `Blocked by governance policy: this KPI cannot be computed at "${ctx.scope.aggregation}" ` +
          `level (minimum "${minimumAggregation(kpi)}"). ${guidanceFor(kpi.id)}`,
      };
    }

    const calculator = CALCULATORS[kpi.id];
    if (!calculator) {
      return { ...base, status: 'unavailable', unavailableReason: 'No calculator registered for this KPI.' };
    }

    let result;
    try {
      result = calculator(ctx);
    } catch (error) {
      return {
        ...base,
        status: 'unavailable',
        unavailableReason: `Calculation failed: ${(error as Error).message}`,
      };
    }

    if (result.value === null) {
      return {
        ...base,
        status: 'unavailable',
        unavailableReason: result.unavailableReason ?? 'Insufficient data.',
        missingInputs: result.missingInputs,
      };
    }

    return {
      ...base,
      value: result.value,
      status: scoreStatus(kpi, result.value),
      percentiles: result.percentiles,
      sampleSize: result.sampleSize,
      confidence: confidenceFor(result.sampleSize),
    };
  }

  /** Computes one KPI, throwing on a governance violation so a direct request gets a clear error. */
  async computeOne(kpiId: string, scope: Scope, period: Period): Promise<KpiValue> {
    const kpi = getKpi(kpiId);
    if (!kpi) throw new Error(`Unknown KPI: ${kpiId}`);
    if (!isAggregationAllowed(kpi, scope)) {
      throw new GovernanceError(kpi.id, scope.aggregation, minimumAggregation(kpi), guidanceFor(kpi.id));
    }
    const ctx = await this.buildContext(scope, period);
    return this.computeInContext(kpi, ctx);
  }

  /** Computes a set of KPIs against one context. Blocked KPIs are reported, not thrown. */
  async computeMany(kpiIds: string[], scope: Scope, period: Period): Promise<KpiValue[]> {
    const ctx = await this.buildContext(scope, period);
    return kpiIds
      .map((id) => getKpi(id))
      .filter((k): k is KpiDefinition => Boolean(k))
      .map((k) => this.computeInContext(k, ctx));
  }

  /** Computes a set of KPIs for two periods and attaches the comparison. */
  async compare(
    kpiIds: string[],
    scope: Scope,
    current: Period,
    previous: Period,
  ): Promise<KpiValue[]> {
    const [now, before] = await Promise.all([
      this.computeMany(kpiIds, scope, current),
      this.computeMany(kpiIds, scope, previous),
    ]);
    const byId = new Map(before.map((v) => [v.kpiId, v]));
    return now.map((value) => attachComparison(value, byId.get(value.kpiId)?.value ?? null));
  }

  /** Builds a time series by computing the KPI over consecutive sub-periods. */
  async trend(kpiId: string, scope: Scope, period: Period, buckets = 6): Promise<TrendPoint[]> {
    const slices = splitPeriod(period, buckets);
    const points: TrendPoint[] = [];
    for (const slice of slices) {
      const value = await this.computeOne(kpiId, scope, slice);
      points.push({ period: slice.label ?? slice.from, value: value.value });
    }
    return points;
  }

  /** The full executive scorecard: every domain, scored, with headline KPIs surfaced. */
  async scorecard(
    scope: Scope,
    period: Period,
    options: { previous?: Period; includeTrend?: boolean; trendBuckets?: number } = {},
  ): Promise<Scorecard> {
    const catalog = loadCatalog();
    const ctx = await this.buildContext(scope, period);

    let previousById = new Map<string, number | null>();
    if (options.previous) {
      const prevCtx = await this.buildContext(scope, options.previous);
      previousById = new Map(
        catalog.kpis.map((k) => [k.id, this.computeInContext(k, prevCtx).value]),
      );
    }

    const domains: ScorecardDomain[] = [];
    const allValues: KpiValue[] = [];

    for (const domain of catalog.domains) {
      const values = catalog.kpis
        .filter((k) => k.domain === domain.id)
        .map((k) => this.computeInContext(k, ctx))
        .map((v) => (options.previous ? attachComparison(v, previousById.get(v.kpiId) ?? null) : v));

      allValues.push(...values);
      domains.push({ id: domain.id, name: domain.name, score: domainScore(values), kpis: values });
    }

    if (options.includeTrend) {
      const buckets = options.trendBuckets ?? 6;
      for (const id of HEADLINE_KPIS) {
        const target = allValues.find((v) => v.kpiId === id);
        if (target && target.value !== null) {
          target.trend = await this.trend(id, scope, period, buckets);
        }
      }
    }

    const headline = HEADLINE_KPIS.map((id) => allValues.find((v) => v.kpiId === id)).filter(
      (v): v is KpiValue => Boolean(v),
    );

    return {
      scope,
      period,
      generatedAt: new Date().toISOString(),
      catalogVersion: catalogVersion(),
      domains,
      headline,
      overallScore: overallScore(domains),
      dataQuality: assessDataQuality(allValues, this.reference),
    };
  }

  /**
   * Flags KPIs whose latest bucket is a statistical outlier against their own recent history.
   * Uses a modified z-score so a single spike cannot mask itself.
   */
  async detectAnomalies(
    scope: Scope,
    period: Period,
    options: { kpiIds?: string[]; buckets?: number; threshold?: number } = {},
  ): Promise<Anomaly[]> {
    const ids = options.kpiIds ?? [...HEADLINE_KPIS];
    const buckets = options.buckets ?? 8;
    const threshold = options.threshold ?? 3.5;
    const anomalies: Anomaly[] = [];

    for (const id of ids) {
      const kpi = getKpi(id);
      if (!kpi) continue;
      const points = await this.trend(id, scope, period, buckets);
      const values = points.map((p) => p.value).filter((v): v is number => v !== null);
      if (values.length < 4) continue;

      const scores = modifiedZScores(values);
      const lastScore = scores.at(-1)!;
      if (Math.abs(lastScore) < threshold) continue;

      const latest = values.at(-1)!;
      const worsening =
        kpi.direction === 'higher_is_better' ? lastScore < 0 : kpi.direction === 'lower_is_better' ? lastScore > 0 : true;

      anomalies.push({
        kpiId: id,
        name: kpi.name,
        domain: kpi.domain,
        value: latest,
        unit: kpi.unit,
        zScore: round(lastScore, 2)!,
        direction: worsening ? 'deterioration' : 'improvement',
        period: points.at(-1)!.period,
        baseline: round(safeDivide(values.slice(0, -1).reduce((a, b) => a + b, 0), values.length - 1), 2),
      });
    }

    return anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  }
}

export interface Anomaly {
  kpiId: string;
  name: string;
  domain: string;
  value: number;
  unit: string;
  zScore: number;
  direction: 'deterioration' | 'improvement';
  period: string;
  baseline: number | null;
}

// ── scoring ────────────────────────────────────────────────────────────────────

/** Maps a raw value to good / warn / bad using the KPI's own thresholds and direction. */
export function scoreStatus(kpi: KpiDefinition, value: number): Status {
  const t = kpi.thresholds;
  if (!t || t.good === undefined) return 'unknown';

  if (kpi.direction === 'higher_is_better') {
    if (value >= t.good) return 'good';
    if (t.warn !== undefined && value >= t.warn) return 'warn';
    return 'bad';
  }

  if (kpi.direction === 'lower_is_better') {
    if (value <= t.good) return 'good';
    if (t.warn !== undefined && value <= t.warn) return 'warn';
    return 'bad';
  }

  // target_band: `good` is the centre of the band; deviation in either direction degrades.
  const centre = t.good;
  const tolerance = t.warn !== undefined ? Math.abs(centre - t.warn) : centre * 0.25;
  const deviation = Math.abs(value - centre);
  if (deviation <= tolerance) return 'good';
  if (deviation <= tolerance * 2) return 'warn';
  return 'bad';
}

const STATUS_POINTS: Record<Status, number | null> = {
  good: 100,
  warn: 60,
  bad: 20,
  unknown: null,
  unavailable: null,
};

function domainScore(values: KpiValue[]): number | null {
  const points = values.map((v) => STATUS_POINTS[v.status]).filter((p): p is number => p !== null);
  if (points.length === 0) return null;
  return round(points.reduce((a, b) => a + b, 0) / points.length, 1);
}

function overallScore(domains: ScorecardDomain[]): number | null {
  const scores = domains.map((d) => d.score).filter((s): s is number => s !== null);
  if (scores.length === 0) return null;
  return round(scores.reduce((a, b) => a + b, 0) / scores.length, 1);
}

function confidenceFor(sampleSize?: number): 'high' | 'medium' | 'low' {
  if (sampleSize === undefined) return 'medium';
  if (sampleSize >= 30) return 'high';
  if (sampleSize >= 10) return 'medium';
  return 'low';
}

function attachComparison(value: KpiValue, previous: number | null): KpiValue {
  if (value.value === null || previous === null) {
    return { ...value, previousValue: previous, delta: null, deltaPercent: null, improving: null };
  }
  const delta = value.value - previous;
  const deltaPercent = previous === 0 ? null : round((delta / Math.abs(previous)) * 100, 1);
  const improving =
    value.direction === 'higher_is_better'
      ? delta > 0
      : value.direction === 'lower_is_better'
        ? delta < 0
        : Math.abs(value.value - previous) < Math.abs(previous) * 0.1;

  return {
    ...value,
    previousValue: previous,
    delta: round(delta, 3),
    deltaPercent,
    improving: delta === 0 ? null : improving,
  };
}

function assessDataQuality(values: KpiValue[], reference: ReferenceData): DataQuality {
  const computed = values.filter((v) => v.value !== null).length;
  const warnings: string[] = [];

  const blocked = values.filter((v) => v.unavailableReason?.startsWith('Blocked by governance'));
  if (blocked.length > 0) {
    warnings.push(`${blocked.length} KPI(s) were withheld by governance policy at this scope.`);
  }

  const missingInputs = new Set<string>();
  for (const v of values) for (const m of v.missingInputs ?? []) missingInputs.add(m);
  if (missingInputs.size > 0) {
    warnings.push(`Missing inputs prevented some KPIs: ${[...missingInputs].sort().join(', ')}.`);
  }

  const lowConfidence = values.filter((v) => v.value !== null && v.confidence === 'low').length;
  if (lowConfidence > 0) {
    warnings.push(`${lowConfidence} KPI(s) are based on fewer than 10 observations — treat as indicative.`);
  }

  const tagCoverage = values.find((v) => v.kpiId === 'cloudfinops.tag_coverage')?.value ?? null;
  if (tagCoverage !== null && tagCoverage < 95) {
    warnings.push(
      `Cost allocation tag coverage is ${tagCoverage}%. Allocated cost figures are incomplete below 95%.`,
    );
  }

  return {
    completeness: round(safeDivide(computed * 100, values.length) ?? 0, 1)!,
    tagCoverage,
    referenceDataLoaded: reference.loaded,
    referenceDataMissing: reference.notFound,
    warnings,
  };
}

/** Splits a period into equal consecutive buckets for trend analysis. */
export function splitPeriod(period: Period, buckets: number): Period[] {
  const start = new Date(period.from).getTime();
  const end = new Date(period.to).getTime();
  const step = (end - start) / buckets;
  const slices: Period[] = [];
  for (let i = 0; i < buckets; i += 1) {
    const from = new Date(start + step * i);
    const to = new Date(start + step * (i + 1));
    slices.push({
      from: from.toISOString(),
      to: to.toISOString(),
      label: from.toISOString().slice(0, 10),
    });
  }
  return slices;
}
