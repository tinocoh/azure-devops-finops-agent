import type { Period } from '../types.js';

/**
 * Period parsing.
 *
 * The agent receives natural-language time expressions from users ("last quarter", "the last
 * 90 days"). Resolving them here rather than in the prompt keeps the boundaries deterministic,
 * which matters because a KPI that silently shifts its window is not comparable over time.
 */

const RELATIVE = /^last[_\s-]?(\d+)[_\s-]?(day|days|week|weeks|month|months|quarter|quarters)$/i;

const DAY_MS = 86_400_000;

export function resolvePeriod(input?: string, now: Date = new Date()): Period {
  const reference = new Date(now);

  if (!input || input.trim() === '') return lastNDays(30, reference);

  const normalized = input.trim().toLowerCase();

  // Explicit ISO range: "2026-01-01..2026-04-01"
  const range = normalized.split('..');
  if (range.length === 2 && range[0] && range[1]) {
    return { from: isoDay(range[0]), to: isoDay(range[1]), label: input };
  }

  const relative = RELATIVE.exec(normalized);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]!.replace(/s$/, '');
    switch (unit) {
      case 'day':
        return lastNDays(count, reference);
      case 'week':
        return lastNDays(count * 7, reference);
      case 'month':
        return lastNMonths(count, reference);
      case 'quarter':
        return lastNMonths(count * 3, reference);
    }
  }

  switch (normalized) {
    case 'today':
      return { from: startOfDay(reference), to: endOfDay(reference), label: 'today' };
    case 'yesterday': {
      const y = new Date(reference.getTime() - DAY_MS);
      return { from: startOfDay(y), to: startOfDay(reference), label: 'yesterday' };
    }
    case 'this week':
    case 'current week':
      return lastNDays(7, reference);
    case 'this month':
    case 'current month':
      return {
        from: new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1)).toISOString(),
        to: endOfDay(reference),
        label: 'this month',
      };
    case 'last month':
      return lastNMonths(1, reference);
    case 'this quarter':
    case 'current quarter': {
      const q = Math.floor(reference.getUTCMonth() / 3);
      return {
        from: new Date(Date.UTC(reference.getUTCFullYear(), q * 3, 1)).toISOString(),
        to: endOfDay(reference),
        label: 'this quarter',
      };
    }
    case 'last quarter':
      return lastNMonths(3, reference);
    case 'this year':
    case 'ytd':
      return {
        from: new Date(Date.UTC(reference.getUTCFullYear(), 0, 1)).toISOString(),
        to: endOfDay(reference),
        label: 'year to date',
      };
    default:
      break;
  }

  // Bare ISO date means "from that date until now".
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return { from: isoDay(normalized), to: endOfDay(reference), label: input };
  }

  throw new Error(
    `Could not interpret the period "${input}". Use a relative expression such as ` +
      '"last 30 days", "last quarter", "this month", or an explicit range "2026-01-01..2026-04-01".',
  );
}

/** The equivalent window immediately preceding a period, for like-for-like comparison. */
export function precedingPeriod(period: Period): Period {
  const from = new Date(period.from).getTime();
  const to = new Date(period.to).getTime();
  const span = to - from;
  return {
    from: new Date(from - span).toISOString(),
    to: new Date(from).toISOString(),
    label: `previous ${describeSpan(span)}`,
  };
}

export function describeSpan(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  if (days <= 1) return 'day';
  if (days <= 14) return `${days} days`;
  if (days <= 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

export function describePeriod(period: Period): string {
  return period.label ?? `${period.from.slice(0, 10)} to ${period.to.slice(0, 10)}`;
}

function lastNDays(n: number, reference: Date): Period {
  return {
    from: new Date(reference.getTime() - n * DAY_MS).toISOString(),
    to: endOfDay(reference),
    label: `last ${n} days`,
  };
}

function lastNMonths(n: number, reference: Date): Period {
  const from = new Date(reference);
  from.setUTCMonth(from.getUTCMonth() - n);
  return {
    from: from.toISOString(),
    to: endOfDay(reference),
    label: n === 1 ? 'last month' : `last ${n} months`,
  };
}

function startOfDay(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function endOfDay(d: Date): string {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  ).toISOString();
}

function isoDay(value: string): string {
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: "${value}".`);
  return parsed.toISOString();
}
