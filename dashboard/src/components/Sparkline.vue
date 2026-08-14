<script setup>
import { computed } from 'vue';

/**
 * Inline sparkline drawn as a plain SVG path.
 *
 * Deliberately not an ECharts instance: a scorecard renders 60+ tiles, and 60 chart
 * instances costs roughly a second of main-thread time on a demo laptop. ECharts is
 * reserved for the drill-down view where interactivity actually matters.
 */

const props = defineProps({
  values: { type: Array, required: true },
  direction: { type: String, default: 'higher_is_better' },
  width: { type: Number, default: 72 },
  height: { type: Number, default: 24 },
});

const geometry = computed(() => {
  const values = props.values;
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = props.width / (values.length - 1);
  const pad = 2;
  const usable = props.height - pad * 2;

  const points = values.map((v, i) => ({
    x: i * stepX,
    y: pad + usable - ((v - min) / span) * usable,
  }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${props.width},${props.height} L0,${props.height} Z`;

  return { line, area, last: points.at(-1) };
});

/** Colour reflects whether the movement is good, which depends on the KPI's direction. */
const tone = computed(() => {
  const values = props.values;
  if (values.length < 2) return 'var(--text-faint)';
  const change = values.at(-1) - values[0];
  if (Math.abs(change) < Math.abs(values[0] ?? 1) * 0.02) return 'var(--text-faint)';
  const better = props.direction === 'higher_is_better' ? change > 0 : props.direction === 'lower_is_better' ? change < 0 : null;
  if (better === null) return 'var(--accent)';
  return better ? 'var(--good)' : 'var(--bad)';
});
</script>

<template>
  <svg
    v-if="geometry"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    aria-label="trend sparkline"
    class="spark"
  >
    <path :d="geometry.area" :fill="tone" opacity="0.12" />
    <path :d="geometry.line" :stroke="tone" stroke-width="1.6" fill="none" stroke-linejoin="round" />
    <circle :cx="geometry.last.x" :cy="geometry.last.y" r="2.2" :fill="tone" />
  </svg>
</template>

<style scoped>
.spark {
  display: block;
  overflow: visible;
}
</style>
