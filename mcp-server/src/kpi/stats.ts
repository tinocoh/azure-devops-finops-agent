/** Small, dependency-free statistics helpers. Kept separate so they are trivially testable. */

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/**
 * Linear-interpolated percentile (the "exclusive-free" R-7 method, matching Excel's PERCENTILE.INC
 * and the convention used by Azure DevOps Analytics widgets).
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);

  const sorted = [...values].sort((a, b) => a - b);
  const rank = ((sorted.length - 1) * p) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = sorted[lower]!;
  if (lower === upper) return lo;
  const hi = sorted[upper]!;
  return lo + (hi - lo) * (rank - lower);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/** Population standard deviation. */
export function stdDev(values: number[]): number | null {
  const m = mean(values);
  if (m === null || values.length === 0) return null;
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / values.length);
}

/** Coefficient of variation — the stability measure used for velocity and throughput. */
export function coefficientOfVariation(values: number[]): number | null {
  const m = mean(values);
  const s = stdDev(values);
  if (m === null || s === null || m === 0) return null;
  return s / Math.abs(m);
}

export function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

export function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Modified z-score using the median absolute deviation. Chosen over a mean/stddev z-score
 * because cost and duration series are right-skewed and a single outlier would otherwise
 * inflate the threshold enough to hide itself.
 */
export function modifiedZScores(values: number[]): number[] {
  const med = median(values);
  if (med === null) return values.map(() => 0);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  if (mad === null || mad === 0) return values.map(() => 0);
  return values.map((v) => (0.6745 * (v - med)) / mad);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / 86_400_000;
}

export function hoursBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / 3_600_000;
}
