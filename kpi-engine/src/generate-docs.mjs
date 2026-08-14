#!/usr/bin/env node
/**
 * Generates docs/KPI-CATALOG.md from the YAML catalog.
 *
 * The catalog is the source of truth; the document is an artefact. CI regenerates it and
 * fails if the committed copy is stale, so the published formula can never drift from the
 * one the engine actually runs.
 *
 * Usage:  node kpi-engine/src/generate-docs.mjs [--check]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'catalog');
const outputPath = join(here, '..', '..', 'docs', 'KPI-CATALOG.md');

const FEASIBILITY_NOTE = {
  native: 'available directly from Azure DevOps',
  derived: 'computable from Azure DevOps once a naming or tagging convention is configured',
  external: 'requires data Azure DevOps does not hold — finance, HR or Azure cost',
};

function loadDomains() {
  return readdirSync(catalogDir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
    .sort()
    .map((file) => parse(readFileSync(join(catalogDir, file), 'utf8')));
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function build() {
  const files = loadDomains();
  const totalKpis = files.reduce((sum, f) => sum + (f.kpis?.length ?? 0), 0);

  const lines = [];

  lines.push('# KPI catalog');
  lines.push('');
  lines.push('> **Generated from [`kpi-engine/catalog/`](../kpi-engine/catalog/). Do not edit by hand.**');
  lines.push('> Run `node kpi-engine/src/generate-docs.mjs` after changing a definition.');
  lines.push('');
  lines.push(
    `${totalKpis} KPIs across ${files.length} domains. Every KPI is versioned: changing a formula ` +
      'requires a `revision` bump, because trend data is only comparable within a revision.',
  );
  lines.push('');

  lines.push('## Data feasibility');
  lines.push('');
  lines.push('| Level | Meaning |');
  lines.push('| --- | --- |');
  for (const [key, note] of Object.entries(FEASIBILITY_NOTE)) {
    lines.push(`| \`${key}\` | ${note} |`);
  }
  lines.push('');
  lines.push(
    'A KPI marked `external` is not a defect. Azure DevOps does not hold budgets, labour rates ' +
      'or contract revenue, and the engine will report the KPI as unavailable — naming the ' +
      'missing input — rather than estimating it.',
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Domain | KPIs | Audience |');
  lines.push('| --- | --- | --- |');
  for (const file of files) {
    lines.push(
      `| [${file.domain.name}](#${slug(file.domain.name)}) | ${file.kpis?.length ?? 0} | ${(file.domain.audience ?? []).join(', ')} |`,
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const file of files) {
    const d = file.domain;
    lines.push(`## ${d.name}`);
    lines.push('');
    lines.push(d.description.trim());
    lines.push('');

    if (d.governance) {
      lines.push(
        `> **Governance: ${d.governance}.** Every KPI in this domain declares a minimum ` +
          'aggregation level that the engine enforces in code. Person-level computation is ' +
          'refused, not merely discouraged.',
      );
      lines.push('');
    }

    if (d.requires_reference_data) {
      lines.push(
        `> **Requires reference data:** ${d.requires_reference_data.map((f) => `\`${f}\``).join(', ')}. ` +
          'Without it, these KPIs report as unavailable.',
      );
      lines.push('');
    }

    if (d.definitions) {
      lines.push('**Definitions**');
      lines.push('');
      for (const [term, meaning] of Object.entries(d.definitions)) {
        lines.push(`- **${term}** — ${meaning}`);
      }
      lines.push('');
    }

    if (d.tagging_contract) {
      lines.push('**Tagging contract**');
      lines.push('');
      lines.push(d.tagging_contract.description.trim());
      lines.push('');
      lines.push('| Tag | Purpose |');
      lines.push('| --- | --- |');
      for (const [tag, purpose] of Object.entries(d.tagging_contract.required_tags)) {
        lines.push(`| \`${tag}\` | ${purpose} |`);
      }
      lines.push('');
      lines.push(`_Enforcement: ${d.tagging_contract.enforcement}_`);
      lines.push('');
    }

    lines.push('| KPI | Formula | Unit | Feasibility | Benchmark |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const kpi of file.kpis ?? []) {
      const benchmark = kpi.benchmarks ? Object.values(kpi.benchmarks)[0] : '—';
      lines.push(
        `| **${escapeCell(kpi.name)}** | \`${escapeCell(kpi.formula_display ?? kpi.formula)}\` | ${escapeCell(kpi.unit)} | ${kpi.feasibility} | ${escapeCell(benchmark)} |`,
      );
    }
    lines.push('');

    // Detail blocks only where there is genuine guidance to give.
    const detailed = (file.kpis ?? []).filter((k) => k.interpretation || k.caveats?.length);
    if (detailed.length > 0) {
      lines.push('<details>');
      lines.push('<summary>Interpretation and caveats</summary>');
      lines.push('');
      for (const kpi of detailed) {
        lines.push(`#### ${kpi.name}`);
        lines.push('');
        lines.push(`\`${kpi.id}\` · revision ${kpi.revision} · ${kpi.direction.replace(/_/g, ' ')}`);
        lines.push('');
        if (kpi.interpretation) {
          lines.push(kpi.interpretation.trim());
          lines.push('');
        }
        if (kpi.caveats?.length) {
          lines.push('**Caveats**');
          lines.push('');
          for (const caveat of kpi.caveats) lines.push(`- ${caveat}`);
          lines.push('');
        }
        if (kpi.pairs_with?.length) {
          lines.push(`**Read alongside:** ${kpi.pairs_with.map((p) => `\`${p}\``).join(', ')}`);
          lines.push('');
        }
        if (kpi.min_aggregation) {
          lines.push(`**Minimum aggregation:** \`${kpi.min_aggregation}\``);
          lines.push('');
        }
      }
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  lines.push('## Sources');
  lines.push('');
  lines.push('| Framework | Applies to |');
  lines.push('| --- | --- |');
  lines.push('| DORA / Accelerate State of DevOps | Delivery Performance |');
  lines.push('| Flow Framework, SAFe flow metrics | Flow Metrics |');
  lines.push('| Azure DevOps Analytics entity reference | Native KPI availability |');
  lines.push('| PMI earned value management | Project Profitability |');
  lines.push('| FinOps Foundation Framework, FOCUS specification | Cloud FinOps Linkage |');
  lines.push('| SPACE and DevEx frameworks | The reason no single throughput number is presented alone |');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const content = build();

if (process.argv.includes('--check')) {
  const existing = (() => {
    try {
      return readFileSync(outputPath, 'utf8');
    } catch {
      return '';
    }
  })();
  if (existing !== content) {
    process.stderr.write(
      'docs/KPI-CATALOG.md is out of date with kpi-engine/catalog/.\n' +
        'Run: node kpi-engine/src/generate-docs.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('docs/KPI-CATALOG.md is up to date.\n');
} else {
  writeFileSync(outputPath, content, 'utf8');
  process.stdout.write(`Wrote ${outputPath}\n`);
}
