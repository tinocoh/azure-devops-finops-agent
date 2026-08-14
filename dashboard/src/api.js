/** Thin client over the KPI server REST API. */

const BASE = import.meta.env.VITE_KPI_SERVER ?? '';

async function get(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const response = await fetch(`${BASE}${path}?${query}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // non-JSON error body
    }
    const error = new Error(payload.message ?? `Request failed with HTTP ${response.status}`);
    error.code = payload.error;
    error.guidance = payload.guidance;
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export const api = {
  health: () => get('/api/health'),
  catalog: () => get('/api/catalog'),
  scopes: (organization) => get('/api/scopes', { organization }),
  scorecard: (scope, period, options = {}) =>
    get('/api/scorecard', { ...scope, period, trend: options.trend ?? true, buckets: options.buckets }),
  trend: (kpiId, scope, period, buckets = 12) =>
    get(`/api/kpi/${encodeURIComponent(kpiId)}/trend`, { ...scope, period, buckets }),
  anomalies: (scope, period, sensitivity = 'normal') =>
    get('/api/anomalies', { ...scope, period, sensitivity }),
};

/** Formats a KPI value for display, honouring its unit. Mirrors the server-side renderer. */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return '—';

  const abs = Math.abs(value);
  const compact = (n) =>
    abs >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : abs >= 10_000
        ? `${(n / 1000).toFixed(1)}k`
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit === 'ratio') return value.toFixed(2);
  if (unit?.startsWith('currency')) return `$${compact(value)}`;
  if (unit === 'hours') return `${value.toFixed(1)}h`;
  if (unit === 'days') return `${value.toFixed(1)}d`;
  if (unit === 'seconds') return value >= 120 ? `${(value / 60).toFixed(1)}m` : `${value.toFixed(0)}s`;
  if (unit?.includes('minutes')) return `${compact(value)}m`;
  return compact(value);
}

/** The trailing unit label shown beneath a tile value. */
export function unitLabel(unit) {
  if (!unit) return '';
  if (['percent', 'ratio', 'hours', 'days', 'seconds'].includes(unit)) return '';
  if (unit.startsWith('currency/')) return `per ${unit.split('/')[1]}`;
  if (unit === 'currency') return '';
  return unit;
}
