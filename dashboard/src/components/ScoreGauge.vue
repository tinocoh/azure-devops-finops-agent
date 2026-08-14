<script setup>
import { computed } from 'vue';

const props = defineProps({
  score: { type: Number, default: null },
  label: { type: String, default: 'Overall health' },
  size: { type: Number, default: 132 },
});

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/* Three-quarter arc, so the gauge reads as a dial rather than a pie. */
const ARC = CIRCUMFERENCE * 0.75;

const offset = computed(() => {
  if (props.score === null) return ARC;
  return ARC - (Math.min(100, Math.max(0, props.score)) / 100) * ARC;
});

const tone = computed(() => {
  if (props.score === null) return 'var(--text-faint)';
  if (props.score >= 75) return 'var(--good)';
  if (props.score >= 50) return 'var(--warn)';
  return 'var(--bad)';
});

const verdict = computed(() => {
  if (props.score === null) return 'not scored';
  if (props.score >= 85) return 'strong';
  if (props.score >= 70) return 'healthy';
  if (props.score >= 50) return 'mixed';
  if (props.score >= 35) return 'under strain';
  return 'critical';
});
</script>

<template>
  <div class="gauge" :style="{ width: `${size}px` }">
    <svg :width="size" :height="size" viewBox="0 0 132 132" role="img" :aria-label="`${label}: ${score ?? 'not scored'} out of 100`">
      <g transform="rotate(135 66 66)">
        <circle
          cx="66"
          cy="66"
          :r="RADIUS"
          fill="none"
          stroke="var(--surface-3)"
          stroke-width="10"
          stroke-linecap="round"
          :stroke-dasharray="`${ARC} ${CIRCUMFERENCE}`"
        />
        <circle
          cx="66"
          cy="66"
          :r="RADIUS"
          fill="none"
          :stroke="tone"
          stroke-width="10"
          stroke-linecap="round"
          :stroke-dasharray="`${ARC} ${CIRCUMFERENCE}`"
          :stroke-dashoffset="offset"
          class="arc"
        />
      </g>
      <text x="66" y="62" text-anchor="middle" class="score" :fill="tone">
        {{ score === null ? '—' : Math.round(score) }}
      </text>
      <text x="66" y="80" text-anchor="middle" class="verdict">{{ verdict }}</text>
    </svg>
    <p class="label">{{ label }}</p>
  </div>
</template>

<style scoped>
.gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.arc {
  transition: stroke-dashoffset 0.5s ease;
}

.score {
  font-size: 30px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.verdict {
  font-size: 10px;
  fill: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.09em;
}

.label {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}
</style>
