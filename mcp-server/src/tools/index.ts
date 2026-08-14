import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HEADLINE_KPIS, catalogVersion, getKpi, loadCatalog } from '../catalog.js';
import type { KpiEngine } from '../kpi/engine.js';
import { GovernanceError } from '../kpi/guards.js';
import type { Aggregation, KpiValue, Scope } from '../types.js';
import { describePeriod, precedingPeriod, resolvePeriod } from '../util/period.js';
import { renderScorecard, renderKpiList, renderKpiTable, renderAnomalies } from './render.js';

/**
 * MCP tool surface.
 *
 * Tool count is deliberately kept low. Copilot Studio's generative orchestration degrades in
 * tool selection accuracy beyond roughly 30–40 choices across tools, topics and connected
 * agents, so each tool here is broad and parameterised rather than narrow and numerous.
 */

const scopeShape = {
  organization: z.string().describe('Azure DevOps organisation name.'),
  project: z.string().optional().describe('Azure DevOps project. Omit for organisation-wide.'),
  team: z.string().optional().describe('Team name. Omit for project-wide.'),
  repository: z.string().optional().describe('Repository name, for code-health KPIs.'),
};

const periodShape = {
  period: z
    .string()
    .optional()
    .describe(
      'Time window: "last 30 days", "last quarter", "this month", "ytd", or an explicit ' +
        'range "2026-01-01..2026-04-01". Defaults to the last 30 days.',
    ),
};

function buildScope(args: {
  organization: string;
  project?: string;
  team?: string;
  repository?: string;
}): Scope {
  let aggregation: Aggregation = 'organization';
  if (args.repository) aggregation = 'repository';
  else if (args.team) aggregation = 'team';
  else if (args.project) aggregation = 'project';

  return {
    organization: args.organization,
    project: args.project,
    team: args.team,
    repository: args.repository,
    aggregation,
  };
}

function textResult(text: string, structured?: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured !== undefined ? { structuredContent: structured as Record<string, unknown> } : {}),
  };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerTools(server: McpServer, engine: KpiEngine): void {
  // ── 1. catalog discovery ─────────────────────────────────────────────────────
  server.registerTool(
    'list_kpis',
    {
      title: 'List available KPIs',
      description:
        'Browse the KPI catalog. Returns every KPI this agent can compute, with its formula, ' +
        'unit, data source and whether it needs data from outside Azure DevOps. Use this ' +
        'first when the user asks what can be measured, or to find the right KPI id.',
      inputSchema: {
        domain: z
          .enum(['delivery', 'flow', 'agile', 'code', 'pipeline', 'team', 'profitability', 'cloudfinops'])
          .optional()
          .describe('Restrict to one domain.'),
        feasibility: z
          .enum(['native', 'derived', 'external'])
          .optional()
          .describe('native = straight from Azure DevOps; external = needs finance or cloud cost data.'),
        search: z.string().optional().describe('Free-text match against name, id and formula.'),
      },
    },
    async ({ domain, feasibility, search }) => {
      const catalog = loadCatalog();
      let kpis = catalog.kpis;
      if (domain) kpis = kpis.filter((k) => k.domain === domain);
      if (feasibility) kpis = kpis.filter((k) => k.feasibility === feasibility);
      if (search) {
        const q = search.toLowerCase();
        kpis = kpis.filter(
          (k) =>
            k.name.toLowerCase().includes(q) ||
            k.id.toLowerCase().includes(q) ||
            k.formula.toLowerCase().includes(q),
        );
      }
      return textResult(renderKpiList(kpis, catalog.domains), {
        catalogVersion: catalogVersion(),
        count: kpis.length,
        kpis: kpis.map((k) => ({
          id: k.id,
          name: k.name,
          domain: k.domain,
          unit: k.unit,
          feasibility: k.feasibility,
          formula: k.formula_display ?? k.formula,
        })),
      });
    },
  );

  // ── 2. KPI definition ────────────────────────────────────────────────────────
  server.registerTool(
    'describe_kpi',
    {
      title: 'Explain a KPI definition',
      description:
        'Return the full definition of one KPI: exact formula, unit, direction, thresholds, ' +
        'industry benchmark, how to interpret it, its caveats and which KPIs it should be read ' +
        'alongside. Use this whenever the user asks what a metric means or how it is calculated.',
      inputSchema: { kpiId: z.string().describe('KPI id, for example "delivery.change_lead_time".') },
    },
    async ({ kpiId }) => {
      const kpi = getKpi(kpiId);
      if (!kpi) {
        return errorResult(
          `Unknown KPI "${kpiId}". Call list_kpis to see the available ids.`,
        );
      }
      const lines = [
        `## ${kpi.name} (\`${kpi.id}\`)`,
        '',
        `**Domain:** ${kpi.domainName}  |  **Unit:** ${kpi.unit}  |  **Direction:** ${kpi.direction.replace(/_/g, ' ')}`,
        `**Formula:** ${kpi.formula_display ?? kpi.formula}`,
        `**Data feasibility:** ${kpi.feasibility}`,
        '',
      ];
      if (kpi.benchmarks) {
        lines.push('**Benchmarks**', ...Object.entries(kpi.benchmarks).map(([k, v]) => `- ${k}: ${v}`), '');
      }
      if (kpi.interpretation) lines.push('**How to read it**', kpi.interpretation, '');
      if (kpi.caveats?.length) {
        lines.push('**Caveats**', ...kpi.caveats.map((c) => `- ${c}`), '');
      }
      if (kpi.pairs_with?.length) {
        lines.push(`**Read alongside:** ${kpi.pairs_with.join(', ')}`, '');
      }
      lines.push(
        '**Sources**',
        ...kpi.sources.map(
          (s) => `- ${s.system}${s.entity ? ` → ${s.entity}` : ''}${s.notes ? ` — ${s.notes}` : ''}`,
        ),
      );
      if (kpi.min_aggregation) {
        lines.push('', `**Governance:** may not be computed below "${kpi.min_aggregation}" level.`);
      }
      return textResult(lines.join('\n'), { kpi });
    },
  );

  // ── 3. the workhorse: scorecard ──────────────────────────────────────────────
  server.registerTool(
    'get_scorecard',
    {
      title: 'Get the full KPI scorecard',
      description:
        'Compute every KPI for a scope and period and return a scored executive scorecard: ' +
        'domain scores, headline KPIs, period-over-period movement and a data-quality ' +
        'assessment. This is the primary tool — use it for broad questions such as "how are we ' +
        'doing", "give me the numbers for project X", or any request for an overview.',
      inputSchema: {
        ...scopeShape,
        ...periodShape,
        compareToPrevious: z
          .boolean()
          .optional()
          .describe('Include movement against the immediately preceding equivalent window. Default true.'),
        includeTrend: z.boolean().optional().describe('Include a trend series for headline KPIs.'),
      },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const scorecard = await engine.scorecard(scope, period, {
          previous: args.compareToPrevious === false ? undefined : precedingPeriod(period),
          includeTrend: args.includeTrend ?? false,
        });
        return textResult(renderScorecard(scorecard), scorecard as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 4. targeted KPI query ────────────────────────────────────────────────────
  server.registerTool(
    'get_kpis',
    {
      title: 'Compute specific KPIs',
      description:
        'Compute a named set of KPIs for a scope and period, with period-over-period movement. ' +
        'Use this when the user asks about particular metrics rather than an overview — for ' +
        'example "what is our lead time and change failure rate this quarter".',
      inputSchema: {
        ...scopeShape,
        ...periodShape,
        kpiIds: z
          .array(z.string())
          .min(1)
          .describe('KPI ids to compute. Use list_kpis to discover them.'),
        compareToPrevious: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const values =
          args.compareToPrevious === false
            ? await engine.computeMany(args.kpiIds, scope, period)
            : await engine.compare(args.kpiIds, scope, period, precedingPeriod(period));

        return textResult(
          `**${scopeLabel(scope)} — ${describePeriod(period)}**\n\n${renderKpiTable(values)}`,
          { scope, period, values },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 5. trend ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_kpi_trend',
    {
      title: 'Get a KPI trend over time',
      description:
        'Return a time series for one KPI, split into equal buckets across the period. Use for ' +
        '"is X getting better or worse", "show me the trend", or before making any claim about ' +
        'direction of travel.',
      inputSchema: {
        ...scopeShape,
        ...periodShape,
        kpiId: z.string(),
        buckets: z.number().int().min(2).max(24).optional().describe('Number of buckets. Default 6.'),
      },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const kpi = getKpi(args.kpiId);
        if (!kpi) return errorResult(`Unknown KPI "${args.kpiId}".`);

        const points = await engine.trend(args.kpiId, scope, period, args.buckets ?? 6);
        const rendered = points
          .map((p) => `| ${p.period.slice(0, 10)} | ${p.value ?? 'n/a'} |`)
          .join('\n');

        const values = points.map((p) => p.value).filter((v): v is number => v !== null);
        const first = values[0];
        const last = values.at(-1);
        let direction = 'insufficient data to call a direction';
        if (first !== undefined && last !== undefined && first !== 0) {
          const change = ((last - first) / Math.abs(first)) * 100;
          const better =
            kpi.direction === 'higher_is_better' ? change > 0 : kpi.direction === 'lower_is_better' ? change < 0 : null;
          direction =
            Math.abs(change) < 5
              ? 'broadly flat'
              : `${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}%` +
                (better === null ? '' : better ? ' (improving)' : ' (deteriorating)');
        }

        return textResult(
          `**${kpi.name}** — ${scopeLabel(scope)}, ${describePeriod(period)}\n\n` +
            `| Period start | ${kpi.unit} |\n| --- | --- |\n${rendered}\n\n` +
            `Direction across the window: **${direction}**.`,
          { kpiId: args.kpiId, unit: kpi.unit, points },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 6. anomalies ─────────────────────────────────────────────────────────────
  server.registerTool(
    'detect_anomalies',
    {
      title: 'Detect KPI anomalies',
      description:
        'Find KPIs whose most recent bucket is a statistical outlier against their own recent ' +
        'history, using a median-absolute-deviation z-score. Use for "anything I should worry ' +
        'about", "what changed", or a proactive health check.',
      inputSchema: {
        ...scopeShape,
        ...periodShape,
        kpiIds: z.array(z.string()).optional().describe('Restrict the sweep. Defaults to headline KPIs.'),
        sensitivity: z
          .enum(['low', 'normal', 'high'])
          .optional()
          .describe('high flags more; low flags only severe outliers. Default normal.'),
      },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const threshold = args.sensitivity === 'high' ? 2.5 : args.sensitivity === 'low' ? 5 : 3.5;
        const anomalies = await engine.detectAnomalies(scope, period, {
          kpiIds: args.kpiIds,
          threshold,
        });
        return textResult(renderAnomalies(anomalies, scopeLabel(scope), describePeriod(period)), {
          scope,
          period,
          anomalies,
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 7. profitability ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_project_profitability',
    {
      title: 'Get project profitability and earned value',
      description:
        'Full earned-value analysis for a project: actual cost, earned value, planned value, ' +
        'CPI, SPI, estimate at completion, budget burn and gross margin. Requires financial ' +
        'reference data (budget, rates, revenue); states precisely what is missing if it is not ' +
        'configured. Use for "are we making money on X", "will we come in on budget", ' +
        '"what is our margin".',
      inputSchema: { ...scopeShape, ...periodShape },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const ids = loadCatalog()
          .kpis.filter((k) => k.domain === 'profitability')
          .map((k) => k.id);
        const values = await engine.compare(ids, scope, period, precedingPeriod(period));

        const unavailable = values.filter((v) => v.value === null);
        const header =
          unavailable.length === values.length
            ? '> **Profitability cannot be computed.** Azure DevOps does not hold budgets, ' +
              'labour rates or contract revenue. Configure `reference-data/projects.yaml` and ' +
              '`reference-data/rates.yaml` to enable this domain.\n\n'
            : '';

        return textResult(
          `${header}**Profitability — ${scopeLabel(scope)}, ${describePeriod(period)}**\n\n` +
            renderKpiTable(values),
          { scope, period, values },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 8. pipeline cost ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_pipeline_economics',
    {
      title: 'Analyse pipeline cost and waste',
      description:
        'Break down what the delivery pipeline costs and where it is wasted: minutes consumed ' +
        'by agent type, failed-run waste, queue wait, agent pool utilisation, cost per run and ' +
        'cost per successful build. Use for "why is our CI so expensive", "how much are failed ' +
        'builds costing us", "should we buy another parallel job".',
      inputSchema: { ...scopeShape, ...periodShape },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const ids = loadCatalog()
          .kpis.filter((k) => k.domain === 'pipeline' || k.id === 'code.flaky_test_rate' || k.id === 'code.build_success_rate')
          .map((k) => k.id);
        const values = await engine.compare(ids, scope, period, precedingPeriod(period));

        const waste = values.find((v) => v.kpiId === 'pipeline.failed_run_waste');
        const wastedMinutes = waste?.percentiles?.wastedMinutes;
        const commentary =
          wastedMinutes !== undefined
            ? `\n\n**${wastedMinutes} minutes** of compute were spent on runs that produced no ` +
              'deployable artefact in this window. Reducing flaky tests and failing fast are the ' +
              'two levers that move this figure.'
            : '';

        return textResult(
          `**Pipeline economics — ${scopeLabel(scope)}, ${describePeriod(period)}**\n\n` +
            renderKpiTable(values) +
            commentary,
          { scope, period, values },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 9. cloud cost allocation ─────────────────────────────────────────────────
  server.registerTool(
    'get_cloud_cost_allocation',
    {
      title: 'Allocate Azure cost to Azure DevOps projects',
      description:
        'Show Azure spend attributed to Azure DevOps projects and teams via the tagging ' +
        'contract, plus tag coverage, non-production off-hours waste, idle resource cost and ' +
        'unit economics. Always reports tag coverage alongside any allocated figure. Use for ' +
        '"what is project X costing us in Azure", "where is cloud waste", "showback".',
      inputSchema: { ...scopeShape, ...periodShape },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const ids = loadCatalog()
          .kpis.filter((k) => k.domain === 'cloudfinops')
          .map((k) => k.id);
        const values = await engine.compare(ids, scope, period, precedingPeriod(period));

        const coverage = values.find((v) => v.kpiId === 'cloudfinops.tag_coverage')?.value;
        const caveat =
          coverage !== null && coverage !== undefined && coverage < 95
            ? `\n\n> **Allocation caveat:** only ${coverage}% of cost carries the allocation tag. ` +
              'Figures below are therefore a lower bound. Treat this as showback, not chargeback, ' +
              'until coverage exceeds 95%.'
            : '';

        return textResult(
          `**Cloud cost allocation — ${scopeLabel(scope)}, ${describePeriod(period)}**\n\n` +
            renderKpiTable(values) +
            caveat,
          { scope, period, values },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 10. discovery ────────────────────────────────────────────────────────────
  server.registerTool(
    'list_scopes',
    {
      title: 'List projects and teams',
      description:
        'List the Azure DevOps projects, and optionally the teams within a project, that this ' +
        'agent can report on. Use when the user names something ambiguous, or to confirm a ' +
        'project exists before computing KPIs against it.',
      inputSchema: {
        organization: z.string(),
        project: z.string().optional().describe('Supply to list teams within this project.'),
      },
    },
    async ({ organization, project }) => {
      try {
        if (project) {
          const teams = await engine.listTeams(organization, project);
          return textResult(
            teams.length === 0
              ? `No teams found in project "${project}".`
              : `Teams in **${project}**:\n${teams.map((t) => `- ${t.name}`).join('\n')}`,
            { teams },
          );
        }
        const projects = await engine.listProjects(organization);
        return textResult(
          `Projects in **${organization}**:\n${projects.map((p) => `- ${p.name}`).join('\n')}`,
          { projects },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  // ── 11. headline shortcut ────────────────────────────────────────────────────
  server.registerTool(
    'get_headline_kpis',
    {
      title: 'Get the eight headline KPIs',
      description:
        'A fast, low-cost summary: the eight headline KPIs spanning delivery, flow, pipeline ' +
        'cost, profitability and cloud spend, with movement against the previous period. Use ' +
        'this for a quick status check rather than get_scorecard when the user wants brevity.',
      inputSchema: { ...scopeShape, ...periodShape },
    },
    async (args) => {
      try {
        const scope = buildScope(args);
        const period = resolvePeriod(args.period);
        const values = await engine.compare([...HEADLINE_KPIS], scope, period, precedingPeriod(period));
        return textResult(
          `**Headline KPIs — ${scopeLabel(scope)}, ${describePeriod(period)}**\n\n${renderKpiTable(values)}`,
          { scope, period, values },
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

export function scopeLabel(scope: Scope): string {
  const parts = [scope.organization];
  if (scope.project) parts.push(scope.project);
  if (scope.team) parts.push(scope.team);
  if (scope.repository) parts.push(scope.repository);
  return parts.join(' / ');
}

function describeError(error: unknown): string {
  if (error instanceof GovernanceError) {
    return (
      `**Request declined by governance policy.**\n\n${error.message}\n\n` +
      'This restriction is enforced by the KPI engine and cannot be overridden from the ' +
      'conversation.'
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return `The request could not be completed: ${message}`;
}

export type { KpiValue };
