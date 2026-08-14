import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Catalog, KpiDefinition, KpiDomain } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The catalog ships as YAML so that a KPI definition can be reviewed by someone who does not
 * read TypeScript — a finance partner or a delivery manager should be able to audit a formula
 * in a pull request.
 */
function resolveCatalogDir(): string {
  const candidates = [
    process.env.KPI_CATALOG_DIR,
    join(here, '..', '..', 'kpi-engine', 'catalog'),
    join(here, '..', '..', '..', 'kpi-engine', 'catalog'),
    join(process.cwd(), 'kpi-engine', 'catalog'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      const entries = readdirSync(candidate);
      if (entries.some((e) => e.endsWith('.yaml'))) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `KPI catalog not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      'Set KPI_CATALOG_DIR to the directory containing the catalog YAML files.',
  );
}

interface RawDomainFile {
  domain: KpiDomain;
  kpis: Array<Omit<KpiDefinition, 'domain' | 'domainName'>>;
}

let cached: Catalog | null = null;

export function loadCatalog(force = false): Catalog {
  if (cached && !force) return cached;

  const dir = resolveCatalogDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
    .sort();

  const domains: KpiDomain[] = [];
  const kpis: KpiDefinition[] = [];

  for (const file of files) {
    const raw = parse(readFileSync(join(dir, file), 'utf8')) as RawDomainFile;
    if (!raw?.domain?.id) throw new Error(`Catalog file ${file} has no domain block.`);
    domains.push(raw.domain);

    for (const kpi of raw.kpis ?? []) {
      if (!kpi.id.startsWith(`${raw.domain.id}.`)) {
        throw new Error(
          `KPI id "${kpi.id}" in ${file} must be prefixed with its domain id "${raw.domain.id}."`,
        );
      }
      kpis.push({ ...kpi, domain: raw.domain.id, domainName: raw.domain.name });
    }
  }

  domains.sort((a, b) => a.order - b.order);

  const ids = new Set<string>();
  for (const k of kpis) {
    if (ids.has(k.id)) throw new Error(`Duplicate KPI id in catalog: ${k.id}`);
    ids.add(k.id);
  }

  // pairs_with must reference KPIs that actually exist, otherwise the agent will promise
  // a cross-reference it cannot deliver.
  for (const k of kpis) {
    for (const pair of k.pairs_with ?? []) {
      if (!ids.has(pair)) {
        throw new Error(`KPI "${k.id}" declares pairs_with "${pair}", which is not in the catalog.`);
      }
    }
  }

  cached = { domains, kpis };
  return cached;
}

export function getKpi(id: string): KpiDefinition | undefined {
  return loadCatalog().kpis.find((k) => k.id === id);
}

export function kpisByDomain(domainId: string): KpiDefinition[] {
  return loadCatalog().kpis.filter((k) => k.domain === domainId);
}

/**
 * A stable fingerprint of the catalog contents. Emitted with every scorecard so a stored result
 * can be traced back to the exact formula revision that produced it.
 */
export function catalogVersion(): string {
  const { kpis } = loadCatalog();
  const total = kpis.reduce((sum, k) => sum + k.revision, 0);
  return `${kpis.length}kpi-r${total}`;
}

/** The headline KPIs shown on the executive scorecard, in presentation order. */
export const HEADLINE_KPIS = [
  'delivery.deployment_frequency',
  'delivery.change_lead_time',
  'delivery.change_failure_rate',
  'flow.flow_efficiency',
  'pipeline.failed_run_waste',
  'profitability.cpi',
  'profitability.gross_margin',
  'cloudfinops.cost_per_project',
] as const;
