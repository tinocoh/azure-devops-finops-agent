import type { KpiEngine } from './kpi/engine.js';
import { HEADLINE_KPIS, loadCatalog } from './catalog.js';
import { GovernanceError } from './kpi/guards.js';
import type { Aggregation, Scope } from './types.js';
import { precedingPeriod, resolvePeriod } from './util/period.js';
import type { Express, Request, Response } from 'express';

/**
 * REST surface for the dashboard.
 *
 * The same engine backs both MCP and REST, so a number shown on a tile and a number quoted in
 * the chat cannot disagree. This endpoint is what makes the offline demo possible: the
 * dashboard talks to it directly, with no SaaS dependency in the path.
 */

function scopeFrom(req: Request): Scope {
  const organization = String(req.query.organization ?? req.query.org ?? 'contoso');
  const project = req.query.project ? String(req.query.project) : undefined;
  const team = req.query.team ? String(req.query.team) : undefined;
  const repository = req.query.repository ? String(req.query.repository) : undefined;

  let aggregation: Aggregation = 'organization';
  if (repository) aggregation = 'repository';
  else if (team) aggregation = 'team';
  else if (project) aggregation = 'project';

  return { organization, project, team, repository, aggregation };
}

function handle(res: Response, error: unknown): void {
  if (error instanceof GovernanceError) {
    res.status(403).json({
      error: 'GOVERNANCE_BLOCKED',
      message: error.message,
      kpiId: error.kpiId,
      minimumAggregation: error.minimum,
      guidance: error.guidance,
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ error: 'REQUEST_FAILED', message });
}

export function registerRestApi(app: Express, engine: KpiEngine): void {
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: engine.providerKind,
      providerDescription: engine.providerDescription,
      referenceData: {
        loaded: engine.referenceData.loaded,
        missing: engine.referenceData.notFound,
      },
      catalogKpis: loadCatalog().kpis.length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/catalog', (_req, res) => {
    const catalog = loadCatalog();
    res.json({
      domains: catalog.domains,
      kpis: catalog.kpis,
      headline: HEADLINE_KPIS,
    });
  });

  app.get('/api/scopes', async (req, res) => {
    try {
      const organization = String(req.query.organization ?? 'contoso');
      const projects = await engine.listProjects(organization);
      const withTeams = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          teams: await engine.listTeams(organization, project.name),
        })),
      );
      res.json({ organization, projects: withTeams });
    } catch (error) {
      handle(res, error);
    }
  });

  app.get('/api/scorecard', async (req, res) => {
    try {
      const scope = scopeFrom(req);
      const period = resolvePeriod(req.query.period ? String(req.query.period) : undefined);
      const includeTrend = req.query.trend !== 'false';
      const scorecard = await engine.scorecard(scope, period, {
        previous: precedingPeriod(period),
        includeTrend,
        trendBuckets: Number(req.query.buckets ?? 8),
      });
      res.json(scorecard);
    } catch (error) {
      handle(res, error);
    }
  });

  app.get('/api/kpi/:kpiId/trend', async (req, res) => {
    try {
      const scope = scopeFrom(req);
      const period = resolvePeriod(req.query.period ? String(req.query.period) : undefined);
      const buckets = Math.min(24, Math.max(2, Number(req.query.buckets ?? 8)));
      const points = await engine.trend(req.params.kpiId, scope, period, buckets);
      res.json({ kpiId: req.params.kpiId, scope, period, points });
    } catch (error) {
      handle(res, error);
    }
  });

  app.get('/api/kpis', async (req, res) => {
    try {
      const scope = scopeFrom(req);
      const period = resolvePeriod(req.query.period ? String(req.query.period) : undefined);
      const ids = String(req.query.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        res.status(400).json({ error: 'REQUEST_FAILED', message: 'Provide ?ids=a,b,c' });
        return;
      }
      const values = await engine.compare(ids, scope, period, precedingPeriod(period));
      res.json({ scope, period, values });
    } catch (error) {
      handle(res, error);
    }
  });

  app.get('/api/anomalies', async (req, res) => {
    try {
      const scope = scopeFrom(req);
      const period = resolvePeriod(req.query.period ? String(req.query.period) : undefined);
      const sensitivity = String(req.query.sensitivity ?? 'normal');
      const threshold = sensitivity === 'high' ? 2.5 : sensitivity === 'low' ? 5 : 3.5;
      const anomalies = await engine.detectAnomalies(scope, period, { threshold });
      res.json({ scope, period, anomalies });
    } catch (error) {
      handle(res, error);
    }
  });
}
