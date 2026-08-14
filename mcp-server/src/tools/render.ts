import type { Anomaly } from '../kpi/engine.js';
import type { KpiDefinition, KpiDomain, KpiValue, Scorecard, Status } from '../types.js';

/**
 * Markdown rendering for the MCP text channel.
 *
 * Copilot Studio renders Markdown tables reliably but cannot draw charts, so the text channel
 * is built to be genuinely readable on its own: status glyphs, explicit units, and movement
 * arrows that already account for whether up is good. The dashboard consumes the structured
 * payload instead and draws the visuals.
 */

const GLYPH: Record<Status, string> = {
  good: '🟢',
  warn: '🟡',
  bad: '🔴',
  unknown: '⚪',
  unavailable: '⚫',
};

export function formatValue(value: number | null, unit: string): string {
  if (value === null) return '—';

  const abs = Math.abs(value);
  const compact = abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : abs >= 10_000 ? `${(value / 1000).toFixed(1)}k` : null;

  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit === 'ratio') return value.toFixed(2);
  if (unit.startsWith('currency')) {
    const suffix = unit.includes('/') ? ` ${unit.split('/').slice(1).join('/')}` : '';
    return `$${compact ?? value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  }
  if (unit === 'hours') return `${value.toFixed(1)} h`;
  if (unit === 'days') return `${value.toFixed(1)} d`;
  if (unit === 'seconds') return value >= 120 ? `${(value / 60).toFixed(1)} min` : `${value.toFixed(0)} s`;
  if (unit === 'minutes' || unit.endsWith('minutes')) return `${compact ?? value.toFixed(1)} min`;

  return `${compact ?? value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

function movement(value: KpiValue): string {
  if (value.delta === null || value.delta === undefined) return '';
  if (value.delta === 0) return '→ flat';
  const arrow = value.delta > 0 ? '▲' : '▼';
  const pct = value.deltaPercent !== null && value.deltaPercent !== undefined ? `${Math.abs(value.deltaPercent).toFixed(1)}%` : '';
  const judgement = value.improving === null ? '' : value.improving ? ' better' : ' worse';
  return `${arrow} ${pct}${judgement}`;
}

export function renderKpiTable(values: KpiValue[]): string {
  if (values.length === 0) return '_No KPIs matched._';

  const rows = values.map((v) => {
    const status = GLYPH[v.status];
    const val = v.value === null ? '—' : formatValue(v.value, v.unit);
    const move = movement(v);
    const note =
      v.value === null
        ? truncate(v.unavailableReason ?? 'Not available', 110)
        : v.confidence === 'low'
          ? `low confidence (n=${v.sampleSize})`
          : '';
    return `| ${status} | ${v.name} | ${val} | ${move} | ${note} |`;
  });

  return ['| | KPI | Value | vs previous | Note |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function renderScorecard(scorecard: Scorecard): string {
  const lines: string[] = [];
  const scopeName = [scorecard.scope.organization, scorecard.scope.project, scorecard.scope.team]
    .filter(Boolean)
    .join(' / ');

  lines.push(`# Engineering scorecard — ${scopeName}`);
  lines.push(
    `_${scorecard.period.label ?? `${scorecard.period.from.slice(0, 10)} → ${scorecard.period.to.slice(0, 10)}`}_`,
  );
  lines.push('');

  if (scorecard.overallScore !== null) {
    lines.push(`**Overall health: ${scorecard.overallScore}/100** ${scoreBar(scorecard.overallScore)}`);
    lines.push('');
  }

  lines.push('## Headline');
  lines.push(renderKpiTable(scorecard.headline));
  lines.push('');

  lines.push('## By domain');
  lines.push('| Domain | Score | Good | Watch | Poor | Not available |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const domain of scorecard.domains) {
    const count = (s: Status) => domain.kpis.filter((k) => k.status === s).length;
    lines.push(
      `| ${domain.name} | ${domain.score ?? '—'} | ${count('good')} | ${count('warn')} | ${count('bad')} | ${
        count('unavailable') + count('unknown')
      } |`,
    );
  }
  lines.push('');

  const attention = scorecard.domains
    .flatMap((d) => d.kpis)
    .filter((k) => k.status === 'bad')
    .sort((a, b) => (a.improving === false ? -1 : 1));

  if (attention.length > 0) {
    lines.push('## Needs attention');
    lines.push(renderKpiTable(attention.slice(0, 8)));
    lines.push('');
  }

  lines.push('## Data quality');
  lines.push(`- Completeness: **${scorecard.dataQuality.completeness}%** of catalog KPIs produced a value.`);
  if (scorecard.dataQuality.tagCoverage !== null && scorecard.dataQuality.tagCoverage !== undefined) {
    lines.push(`- Cost allocation tag coverage: **${scorecard.dataQuality.tagCoverage}%**.`);
  }
  if (scorecard.dataQuality.referenceDataMissing.length > 0) {
    lines.push(`- Reference data not loaded: ${scorecard.dataQuality.referenceDataMissing.join(', ')}.`);
  }
  for (const warning of scorecard.dataQuality.warnings) lines.push(`- ${warning}`);
  lines.push('');
  lines.push(`_Catalog ${scorecard.catalogVersion} · generated ${scorecard.generatedAt.slice(0, 19)}Z_`);

  return lines.join('\n');
}

export function renderKpiList(kpis: KpiDefinition[], domains: KpiDomain[]): string {
  if (kpis.length === 0) return '_No KPIs matched that filter._';

  const lines: string[] = [`**${kpis.length} KPI(s) available.**`, ''];
  for (const domain of domains) {
    const inDomain = kpis.filter((k) => k.domain === domain.id);
    if (inDomain.length === 0) continue;
    lines.push(`### ${domain.name}`);
    lines.push('| id | KPI | Unit | Source |');
    lines.push('| --- | --- | --- | --- |');
    for (const k of inDomain) {
      lines.push(`| \`${k.id}\` | ${k.name} | ${k.unit} | ${k.feasibility} |`);
    }
    lines.push('');
  }
  lines.push(
    '_`native` comes straight from Azure DevOps. `derived` needs a naming or tagging ' +
      'convention. `external` needs finance or Azure cost data._',
  );
  return lines.join('\n');
}

export function renderAnomalies(anomalies: Anomaly[], scope: string, period: string): string {
  if (anomalies.length === 0) {
    return (
      `No statistical anomalies detected for **${scope}** over ${period}. ` +
      'Every monitored KPI sits within its own recent range.'
    );
  }

  const lines = [
    `**${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} detected — ${scope}, ${period}**`,
    '',
    '| | KPI | Latest | Recent baseline | Severity |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const a of anomalies) {
    const glyph = a.direction === 'deterioration' ? '🔴' : '🟢';
    const severity = Math.abs(a.zScore) > 5 ? 'severe' : Math.abs(a.zScore) > 3.5 ? 'notable' : 'mild';
    lines.push(
      `| ${glyph} | ${a.name} | ${formatValue(a.value, a.unit)} | ${formatValue(a.baseline, a.unit)} | ${severity} (z=${a.zScore}) |`,
    );
  }

  lines.push('');
  lines.push(
    '_Outliers are detected with a median-absolute-deviation z-score, which is resistant to a ' +
      'single extreme value masking itself._',
  );
  return lines.join('\n');
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return `\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\``;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
