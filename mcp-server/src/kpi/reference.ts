import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Reference data is everything the KPI engine needs that Azure DevOps does not hold:
 * labour rates, budgets, contract revenue, tagging conventions and production selectors.
 *
 * It is deliberately file-based and version-controlled rather than prompted from the user at
 * runtime, so that a currency figure in a board report can always be traced to an approved input.
 */

export interface RateCard {
  currency?: string;
  blendedLoadedRate?: number;
  parallelJobMonthlyCost?: number;
  parallelJobCount?: number;
  selfHostedAgentCount?: number;
  artifactStorageGb?: number;
  artifactStorageFreeGb?: number;
  artifactStorageRatePerGb?: number;
}

export interface ProjectFinance {
  key?: string;
  name?: string;
  budgetAtCompletion?: number;
  contractRevenue?: number;
  directCosts?: number;
  storyPointsInScope?: number;
  plannedPercentComplete?: number;
  startDate?: string;
  endDate?: string;
  standardRate?: number;
  actualBilledRate?: number;
  workingHours?: { start: string; end: string; days: string[] };
}

export interface Conventions {
  projectTagKey?: string;
  teamTagKey?: string;
  billableTag?: string;
  hoursPerStoryPoint?: number;
  idleUtilizationThreshold?: number;
  productionSelector?: {
    pipelineNamePattern?: string;
    stageNamePattern?: string;
    environmentNamePattern?: string;
    tag?: string;
  };
  incidentSelector?: { workItemType?: string; tag?: string; priorityAtOrBelow?: number };
}

export interface ReferenceData {
  rates?: RateCard;
  project?: ProjectFinance;
  projects?: ProjectFinance[];
  conventions?: Conventions;
  /** Files that were successfully loaded. */
  loaded: string[];
  /** Files that were expected but not found. */
  notFound: string[];
}

export const EMPTY_REFERENCE: ReferenceData = { loaded: [], notFound: [] };

function readYaml<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Loads reference data from a directory. Missing files are recorded rather than thrown, because
 * a partially-configured deployment should still return every KPI that does not need money.
 */
export function loadReferenceData(dir?: string, projectKey?: string): ReferenceData {
  const base = dir ?? process.env.REFERENCE_DATA_DIR ?? join(process.cwd(), 'reference-data');
  const loaded: string[] = [];
  const notFound: string[] = [];

  const rates = readYaml<RateCard>(join(base, 'rates.yaml'));
  rates ? loaded.push('rates.yaml') : notFound.push('rates.yaml');

  const projectsFile = readYaml<{ projects: ProjectFinance[] }>(join(base, 'projects.yaml'));
  projectsFile ? loaded.push('projects.yaml') : notFound.push('projects.yaml');

  const conventions = readYaml<Conventions>(join(base, 'conventions.yaml'));
  conventions ? loaded.push('conventions.yaml') : notFound.push('conventions.yaml');

  const projects = projectsFile?.projects ?? [];
  const project = projectKey
    ? projects.find((p) => p.key === projectKey || p.name === projectKey)
    : projects[0];

  return {
    rates: rates ?? undefined,
    projects,
    project,
    conventions: conventions ?? undefined,
    loaded,
    notFound,
  };
}

/** Merges an in-memory override over file-loaded reference data. Used by the demo provider. */
export function withOverrides(base: ReferenceData, override: Partial<ReferenceData>): ReferenceData {
  return {
    ...base,
    ...override,
    rates: { ...base.rates, ...override.rates },
    conventions: { ...base.conventions, ...override.conventions },
    project: { ...base.project, ...override.project },
    loaded: [...new Set([...base.loaded, ...(override.loaded ?? [])])],
    notFound: base.notFound.filter((f) => !(override.loaded ?? []).includes(f)),
  };
}
