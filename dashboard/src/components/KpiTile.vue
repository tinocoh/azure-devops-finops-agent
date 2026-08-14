<script setup>
import { computed } from 'vue';
import Sparkline from './Sparkline.vue';
import { formatValue, unitLabel } from '../api.js';

const props = defineProps({
  kpi: { type: Object, required: true },
  definition: { type: Object, default: null },
  compact: { type: Boolean, default: false },
});

defineEmits(['open']);

const statusClass = computed(() => `tile-${props.kpi.status}`);

const value = computed(() => formatValue(props.kpi.value, props.kpi.unit));
const suffix = computed(() => unitLabel(props.kpi.unit));

const delta = computed(() => {
  const { delta: d, deltaPercent, improving } = props.kpi;
  if (d === null || d === undefined) return null;
  if (d === 0) return { text: 'no change', tone: 'neutral', arrow: '→' };
  return {
    text: deltaPercent !== null && deltaPercent !== undefined ? `${Math.abs(deltaPercent).toFixed(1)}%` : formatValue(Math.abs(d), props.kpi.unit),
    tone: improving === null ? 'neutral' : improving ? 'good' : 'bad',
    arrow: d > 0 ? '▲' : '▼',
  };
});

const sparkValues = computed(() =>
  (props.kpi.trend ?? []).map((p) => p.value).filter((v) => v !== null && v !== undefined),
);

/* The unavailable state is a first-class design case, not an error. A KPI that needs a
   blended labour rate should say so on the tile rather than render a zero. */
const unavailable = computed(() => props.kpi.value === null);

const blockedByGovernance = computed(() =>
  Boolean(props.kpi.unavailableReason?.startsWith('Blocked by governance')),
);
</script>

<template>
  <button
    class="tile card"
    :class="[statusClass, { compact, unavailable }]"
    type="button"
    @click="$emit('open', kpi)"
  >
    <header class="tile-head">
      <span class="tile-name">{{ kpi.name }}</span>
      <span v-if="blockedByGovernance" class="chip chip-neutral" title="Withheld by governance policy">
        withheld
      </span>
      <span
        v-else-if="kpi.confidence === 'low' && !unavailable"
        class="chip chip-neutral"
        :title="`Based on only ${kpi.sampleSize} observations`"
      >
        n={{ kpi.sampleSize }}
      </span>
    </header>

    <div v-if="unavailable" class="tile-unavailable">
      <span class="dash">—</span>
      <p class="reason">{{ kpi.unavailableReason }}</p>
      <ul v-if="kpi.missingInputs?.length" class="missing">
        <li v-for="input in kpi.missingInputs.slice(0, 3)" :key="input" class="mono">{{ input }}</li>
      </ul>
    </div>

    <div v-else class="tile-body">
      <div class="value-row">
        <span class="value">{{ value }}</span>
        <span v-if="suffix" class="suffix">{{ suffix }}</span>
      </div>

      <div class="meta-row">
        <span v-if="delta" class="delta" :class="`delta-${delta.tone}`">
          <span aria-hidden="true">{{ delta.arrow }}</span> {{ delta.text }}
          <span class="sr-only">{{ delta.tone === 'good' ? 'improving' : delta.tone === 'bad' ? 'deteriorating' : '' }}</span>
        </span>
        <span v-else class="faint">no prior period</span>

        <Sparkline
          v-if="sparkValues.length > 2"
          :values="sparkValues"
          :direction="kpi.direction"
          class="spark"
        />
      </div>

      <p v-if="definition?.benchmarks && !compact" class="benchmark faint">
        target {{ Object.values(definition.benchmarks)[0] }}
      </p>
    </div>
  </button>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  text-align: left;
  border-left: 3px solid var(--neutral);
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
  min-height: 132px;
}

.tile:hover {
  transform: translateY(-2px);
  background: var(--surface-2);
}

.tile-good { border-left-color: var(--good); }
.tile-warn { border-left-color: var(--warn); }
.tile-bad { border-left-color: var(--bad); }
.tile-unknown,
.tile-unavailable { border-left-color: var(--border-strong); }

.tile.unavailable { opacity: 0.72; }

.tile-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.tile-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.01em;
}

.tile-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.value-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.value {
  font-size: 30px;
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.tile-good .value { color: var(--good); }
.tile-warn .value { color: var(--warn); }
.tile-bad .value { color: var(--bad); }

.suffix {
  font-size: 12px;
  color: var(--text-faint);
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
}

.delta {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.delta-good { color: var(--good); }
.delta-bad { color: var(--bad); }
.delta-neutral { color: var(--text-faint); }

.spark { flex-shrink: 0; }

.benchmark {
  font-size: 11px;
  margin: 0;
}

.tile-unavailable {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.dash {
  font-size: 28px;
  font-weight: 650;
  color: var(--text-faint);
  line-height: 1;
}

.reason {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.missing {
  margin: 0;
  padding-left: 14px;
  font-size: 10px;
  color: var(--text-faint);
}
</style>
