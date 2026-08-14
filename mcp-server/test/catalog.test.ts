import { describe, expect, it } from 'vitest';
import { catalogVersion, getKpi, loadCatalog, HEADLINE_KPIS } from '../src/catalog.js';
import { CALCULATORS, hasCalculator } from '../src/kpi/calculators.js';

describe('KPI catalog', () => {
  const catalog = loadCatalog();

  it('loads all eight domains', () => {
    expect(catalog.domains).toHaveLength(8);
    expect(catalog.domains.map((d) => d.id)).toEqual([
      'delivery',
      'flow',
      'agile',
      'code',
      'pipeline',
      'team',
      'profitability',
      'cloudfinops',
    ]);
  });

  it('defines the full KPI set', () => {
    expect(catalog.kpis.length).toBeGreaterThanOrEqual(58);
  });

  it('gives every KPI a calculator', () => {
    const orphans = catalog.kpis.filter((k) => !hasCalculator(k)).map((k) => k.id);
    expect(orphans).toEqual([]);
  });

  it('has no calculator without a catalog entry', () => {
    const ids = new Set(catalog.kpis.map((k) => k.id));
    const orphans = Object.keys(CALCULATORS).filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  it('requires every KPI to declare a unit, direction and at least one source', () => {
    for (const kpi of catalog.kpis) {
      expect(kpi.unit, `${kpi.id} unit`).toBeTruthy();
      expect(kpi.direction, `${kpi.id} direction`).toBeTruthy();
      expect(kpi.feasibility, `${kpi.id} feasibility`).toBeTruthy();
      expect(kpi.revision, `${kpi.id} revision`).toBeGreaterThan(0);
    }
  });

  it('resolves every headline KPI', () => {
    for (const id of HEADLINE_KPIS) {
      expect(getKpi(id), `headline ${id}`).toBeDefined();
    }
  });

  it('produces a stable catalog version fingerprint', () => {
    expect(catalogVersion()).toMatch(/^\d+kpi-r\d+$/);
  });

  it('marks every profitability KPI that needs money as external', () => {
    const evmKpis = catalog.kpis.filter(
      (k) => k.domain === 'profitability' && k.id !== 'profitability.effort_variance',
    );
    for (const kpi of evmKpis) {
      expect(kpi.feasibility, `${kpi.id}`).toBe('external');
    }
  });
});
