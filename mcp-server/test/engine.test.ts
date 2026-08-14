import { describe, expect, it } from 'vitest';
import { KpiEngine, scoreStatus, splitPeriod } from '../src/kpi/engine.js';
import { DemoProvider } from '../src/providers/demo.js';
import { getKpi } from '../src/catalog.js';
import { precedingPeriod, resolvePeriod } from '../src/util/period.js';
import type { Period, Scope } from '../src/types.js';

const scope: Scope = {
  organization: 'contoso',
  project: 'Contoso Payments',
  aggregation: 'project',
};

const period: Period = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  label: 'test window',
};

function engineWithReference() {
  return new KpiEngine({
    provider: new DemoProvider(20260814),
    reference: {
      loaded: ['rates.yaml', 'projects.yaml', 'conventions.yaml'],
      notFound: [],
      rates: {
        currency: 'USD',
        blendedLoadedRate: 95,
        parallelJobMonthlyCost: 40,
        parallelJobCount: 5,
        selfHostedAgentCount: 6,
        artifactStorageGb: 14,
        artifactStorageFreeGb: 2,
        artifactStorageRatePerGb: 2,
      },
      project: {
        key: 'Contoso Payments',
        budgetAtCompletion: 2_400_000,
        contractRevenue: 3_200_000,
        directCosts: 60_000,
        storyPointsInScope: 4200,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        standardRate: 180,
        actualBilledRate: 162,
      },
      conventions: {
        projectTagKey: 'ado-project',
        billableTag: 'billable',
        hoursPerStoryPoint: 6,
        idleUtilizationThreshold: 5,
        productionSelector: { pipelineNamePattern: 'release' },
        incidentSelector: { workItemType: 'Bug' },
      },
    },
  });
}

describe('KPI engine with demo data', () => {
  const engine = engineWithReference();

  it('is deterministic for a fixed seed', async () => {
    const a = await engine.computeOne('flow.flow_time', scope, period);
    const b = await engineWithReference().computeOne('flow.flow_time', scope, period);
    expect(a.value).toBe(b.value);
    expect(a.value).not.toBeNull();
  });

  it('computes native KPIs without any reference data', async () => {
    const bare = new KpiEngine({ provider: new DemoProvider(20260814) });
    const value = await bare.computeOne('code.build_success_rate', scope, period);
    expect(value.value).toBeGreaterThan(0);
    expect(value.value).toBeLessThanOrEqual(100);
    expect(value.status).not.toBe('unavailable');
  });

  it('reports precisely which inputs are missing rather than estimating', async () => {
    const bare = new KpiEngine({ provider: new DemoProvider(20260814) });
    const value = await bare.computeOne('profitability.cpi', scope, period);
    expect(value.value).toBeNull();
    expect(value.status).toBe('unavailable');
    expect(value.missingInputs).toContain('projects.budgetAtCompletion');
    expect(value.missingInputs).toContain('rates.blendedLoadedRate');
  });

  it('computes earned value management once reference data is supplied', async () => {
    const values = await engine.computeMany(
      ['profitability.cpi', 'profitability.spi', 'profitability.eac', 'profitability.gross_margin'],
      scope,
      period,
    );
    for (const value of values) {
      expect(value.value, `${value.kpiId} should be computable`).not.toBeNull();
    }
    const cpi = values.find((v) => v.kpiId === 'profitability.cpi')!;
    expect(cpi.value).toBeGreaterThan(0);
  });

  it('keeps percentages within range', async () => {
    const values = await engine.computeMany(
      [
        'delivery.change_failure_rate',
        'flow.flow_efficiency',
        'code.test_pass_rate',
        'pipeline.failed_run_waste',
        'cloudfinops.tag_coverage',
      ],
      scope,
      period,
    );
    for (const value of values) {
      if (value.value === null) continue;
      expect(value.value, `${value.kpiId}`).toBeGreaterThanOrEqual(0);
      expect(value.value, `${value.kpiId}`).toBeLessThanOrEqual(100);
    }
  });

  it('returns percentiles for distribution KPIs', async () => {
    const value = await engine.computeOne('flow.flow_time', scope, period);
    expect(value.percentiles).toBeDefined();
    expect(value.percentiles!.p50).toBeLessThanOrEqual(value.percentiles!.p85!);
    expect(value.percentiles!.p85).toBeLessThanOrEqual(value.percentiles!.p95!);
  });

  it('attaches period-over-period movement with direction awareness', async () => {
    const values = await engine.compare(
      ['delivery.change_failure_rate'],
      scope,
      period,
      precedingPeriod(period),
    );
    const cfr = values[0]!;
    expect(cfr.previousValue).not.toBeUndefined();
    if (cfr.delta !== null && cfr.delta !== undefined && cfr.delta !== 0) {
      // change failure rate is lower_is_better, so a negative delta must read as improving
      expect(cfr.improving).toBe(cfr.delta < 0);
    }
  });

  it('builds a scorecard covering every domain', async () => {
    const scorecard = await engine.scorecard(scope, period);
    expect(scorecard.domains).toHaveLength(8);
    expect(scorecard.headline.length).toBeGreaterThan(0);
    expect(scorecard.overallScore).not.toBeNull();
    expect(scorecard.dataQuality.completeness).toBeGreaterThan(50);
    expect(scorecard.catalogVersion).toMatch(/kpi-r/);
  });

  it('withholds blocked KPIs in a scorecard instead of failing the whole request', async () => {
    const personScope: Scope = { ...scope, aggregation: 'person' };
    const scorecard = await engine.scorecard(personScope, period);
    const blocked = scorecard.domains
      .flatMap((d) => d.kpis)
      .filter((k) => k.unavailableReason?.startsWith('Blocked by governance'));
    expect(blocked.length).toBeGreaterThan(0);
    expect(scorecard.dataQuality.warnings.join(' ')).toContain('withheld by governance');
  });

  it('produces a trend series of the requested length', async () => {
    const points = await engine.trend('code.build_duration', scope, period, 6);
    expect(points).toHaveLength(6);
    expect(points.every((p) => typeof p.period === 'string')).toBe(true);
  });

  it('reflects archetype differences between demo projects', async () => {
    const waste = await engine.computeOne('pipeline.failed_run_waste', {
      ...scope,
      project: 'Contoso Data Platform',
    }, period);
    const healthy = await engine.computeOne('pipeline.failed_run_waste', {
      ...scope,
      project: 'Contoso Payments',
    }, period);
    expect(waste.value!).toBeGreaterThan(healthy.value!);
  });
});

describe('status scoring', () => {
  it('scores lower_is_better against thresholds', () => {
    const kpi = getKpi('delivery.change_failure_rate')!;
    expect(scoreStatus(kpi, 3)).toBe('good');
    expect(scoreStatus(kpi, 12)).toBe('warn');
    expect(scoreStatus(kpi, 40)).toBe('bad');
  });

  it('scores higher_is_better against thresholds', () => {
    const kpi = getKpi('code.build_success_rate')!;
    expect(scoreStatus(kpi, 95)).toBe('good');
    expect(scoreStatus(kpi, 80)).toBe('warn');
    expect(scoreStatus(kpi, 50)).toBe('bad');
  });

  it('treats a target band as degrading in both directions', () => {
    const kpi = getKpi('team.utilization_rate')!;
    expect(scoreStatus(kpi, 75)).toBe('good');
    // far above the band is a risk, not an achievement
    expect(scoreStatus(kpi, 99)).not.toBe('good');
  });
});

describe('period handling', () => {
  it('parses relative expressions', () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    expect(resolvePeriod('last 30 days', now).from.slice(0, 10)).toBe('2026-07-15');
    expect(resolvePeriod('last quarter', now).from.slice(0, 10)).toBe('2026-05-14');
    expect(resolvePeriod('ytd', now).from.slice(0, 10)).toBe('2026-01-01');
  });

  it('parses explicit ranges', () => {
    const p = resolvePeriod('2026-01-01..2026-04-01');
    expect(p.from.slice(0, 10)).toBe('2026-01-01');
    expect(p.to.slice(0, 10)).toBe('2026-04-01');
  });

  it('rejects an uninterpretable expression rather than guessing', () => {
    expect(() => resolvePeriod('sometime recently')).toThrow(/Could not interpret/);
  });

  it('derives an equal-length preceding window', () => {
    const previous = precedingPeriod(period);
    const span = (p: Period) => new Date(p.to).getTime() - new Date(p.from).getTime();
    expect(span(previous)).toBe(span(period));
    expect(previous.to).toBe(period.from);
  });

  it('splits a period into contiguous buckets', () => {
    const buckets = splitPeriod(period, 4);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]!.from).toBe(period.from);
    expect(buckets[3]!.to).toBe(period.to);
    expect(buckets[1]!.from).toBe(buckets[0]!.to);
  });
});
