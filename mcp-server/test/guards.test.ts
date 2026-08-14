import { describe, expect, it } from 'vitest';
import { getKpi } from '../src/catalog.js';
import {
  GovernanceError,
  assertAggregationAllowed,
  assertComparable,
  isAggregationAllowed,
  minimumAggregation,
} from '../src/kpi/guards.js';
import type { Scope } from '../src/types.js';

const scope = (aggregation: Scope['aggregation']): Scope => ({
  organization: 'contoso',
  project: 'Contoso Payments',
  team: aggregation === 'team' ? 'Payments Core' : undefined,
  aggregation,
});

describe('governance guards', () => {
  it('blocks every KPI at person level', () => {
    const kpi = getKpi('flow.velocity')!;
    expect(isAggregationAllowed(kpi, scope('person'))).toBe(false);
    expect(() => assertAggregationAllowed(kpi, scope('person'))).toThrow(GovernanceError);
  });

  it('allows team-level aggregation for ordinary KPIs', () => {
    const kpi = getKpi('flow.velocity')!;
    expect(isAggregationAllowed(kpi, scope('team'))).toBe(true);
  });

  it('enforces the declared minimum for sensitive team KPIs', () => {
    expect(minimumAggregation(getKpi('team.utilization_rate')!)).toBe('team');
    expect(isAggregationAllowed(getKpi('team.utilization_rate')!, scope('person'))).toBe(false);
  });

  it('explains why a KPI was blocked instead of failing silently', () => {
    try {
      assertAggregationAllowed(getKpi('team.context_switching')!, scope('person'));
      expect.unreachable('should have thrown');
    } catch (error) {
      const governance = error as GovernanceError;
      expect(governance.code).toBe('GOVERNANCE_BLOCKED');
      expect(governance.guidance).toContain('team level');
      expect(governance.message).toContain('team.context_switching');
    }
  });

  it('refuses cross-team comparison of team-local units', () => {
    const scopes: Scope[] = [
      { organization: 'contoso', project: 'A', team: 'One', aggregation: 'team' },
      { organization: 'contoso', project: 'A', team: 'Two', aggregation: 'team' },
    ];
    expect(() => assertComparable('agile.velocity_points', scopes)).toThrow(GovernanceError);
    expect(() => assertComparable('delivery.change_failure_rate', scopes)).not.toThrow();
  });

  it('permits single-team comparison of team-local units', () => {
    const scopes: Scope[] = [
      { organization: 'contoso', project: 'A', team: 'One', aggregation: 'team' },
      { organization: 'contoso', project: 'A', team: 'One', aggregation: 'team' },
    ];
    expect(() => assertComparable('agile.velocity_points', scopes)).not.toThrow();
  });
});
