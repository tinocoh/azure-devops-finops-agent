import type { Aggregation, KpiDefinition, Scope } from '../types.js';

/**
 * Governance guards.
 *
 * These are enforced in code rather than documented as a convention, because a metrics product
 * that *can* rank individuals eventually will be used to rank individuals. Refusing at the
 * engine level means neither the Copilot Studio agent, the dashboard, nor a direct API caller
 * can route around the policy.
 *
 * See docs/RESPONSIBLE-METRICS.md for the reasoning.
 */

export class GovernanceError extends Error {
  readonly code = 'GOVERNANCE_BLOCKED';
  readonly kpiId: string;
  readonly requested: Aggregation;
  readonly minimum: Aggregation;
  readonly guidance: string;

  constructor(kpiId: string, requested: Aggregation, minimum: Aggregation, guidance: string) {
    super(
      `KPI "${kpiId}" cannot be computed at "${requested}" level. ` +
        `Minimum permitted aggregation is "${minimum}". ${guidance}`,
    );
    this.name = 'GovernanceError';
    this.kpiId = kpiId;
    this.requested = requested;
    this.minimum = minimum;
    this.guidance = guidance;
  }
}

const RANK: Record<Aggregation, number> = {
  organization: 0,
  project: 1,
  team: 2,
  repository: 2,
  person: 3,
};

/** The default floor. No KPI in this product is ever computed per person. */
export const GLOBAL_MIN_AGGREGATION: Aggregation = 'team';

const GUIDANCE: Record<string, string> = {
  default:
    'Individual-level engineering metrics are unreliable as performance signals and are ' +
    'out of scope for this product. Aggregate to team level and investigate the system, ' +
    'not the person.',
  'team.utilization_rate':
    'Per-person utilisation is a surveillance metric. Report the team average and treat a ' +
    'high reading as a capacity risk rather than an achievement.',
  'team.context_switching':
    'Per-person reassignment counts measure how work is assigned to someone, not how they ' +
    'perform. Report at team level and address the assignment process.',
  'team.knowledge_concentration':
    'This KPI names at-risk code paths, never authors. Request it at repository level.',
  'profitability.cost_per_story_point':
    'Story points are team-local. A per-person or cross-team cost per point is not a ' +
    'meaningful quantity.',
};

export function guidanceFor(kpiId: string): string {
  return GUIDANCE[kpiId] ?? GUIDANCE.default!;
}

/** The minimum aggregation permitted for a KPI, taking the global floor into account. */
export function minimumAggregation(kpi: KpiDefinition): Aggregation {
  const declared = kpi.min_aggregation;
  if (!declared) return GLOBAL_MIN_AGGREGATION;
  return RANK[declared] > RANK[GLOBAL_MIN_AGGREGATION] ? declared : GLOBAL_MIN_AGGREGATION;
}

/** Throws when the requested scope is finer-grained than the KPI permits. */
export function assertAggregationAllowed(kpi: KpiDefinition, scope: Scope): void {
  const minimum = minimumAggregation(kpi);
  if (RANK[scope.aggregation] > RANK[minimum]) {
    throw new GovernanceError(kpi.id, scope.aggregation, minimum, guidanceFor(kpi.id));
  }
}

/** Non-throwing variant for batch computation, where one blocked KPI must not fail the set. */
export function isAggregationAllowed(kpi: KpiDefinition, scope: Scope): boolean {
  return RANK[scope.aggregation] <= RANK[minimumAggregation(kpi)];
}

/**
 * Cross-team comparison guard. Story points and velocity are only meaningful within one team's
 * own history; comparing them across teams produces confident nonsense.
 */
const NOT_COMPARABLE_ACROSS_TEAMS = new Set([
  'agile.velocity_points',
  'flow.velocity',
  'profitability.cost_per_story_point',
  'team.focus_factor',
]);

export function assertComparable(kpiId: string, scopes: Scope[]): void {
  if (!NOT_COMPARABLE_ACROSS_TEAMS.has(kpiId)) return;
  const teams = new Set(scopes.map((s) => `${s.project ?? ''}/${s.team ?? ''}`));
  if (teams.size > 1) {
    throw new GovernanceError(
      kpiId,
      'team',
      'team',
      'This KPI is not comparable across teams because its unit is defined locally by each ' +
        'team. Compare a single team against its own history instead.',
    );
  }
}

/** Strips anything that could re-identify a contributor before a result leaves the engine. */
export function redactContributor<T extends { contributorKey?: string | null }>(fact: T): T {
  if (fact.contributorKey == null) return fact;
  return { ...fact, contributorKey: hashKey(fact.contributorKey) };
}

function hashKey(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `c_${(hash >>> 0).toString(36)}`;
}
