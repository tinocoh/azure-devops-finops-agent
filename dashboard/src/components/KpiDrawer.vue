<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { api, formatValue } from '../api.js';

/**
 * Drill-down drawer.
 *
 * Everything the previous agent buried in chat transcript — the formula, the caveats, the
 * benchmark, what to read it alongside — is surfaced here next to a real trend chart. The
 * intent is that a number on a tile is never the end of the story.
 */

const props = defineProps({
  kpi: { type: Object, default: null },
  definition: { type: Object, default: null },
  scope: { type: Object, required: true },
  period: { type: String, required: true },
  catalog: { type: Object, default: null },
});

const emit = defineEmits(['close', 'open-kpi']);

const chartEl = ref(null);
const loading = ref(false);
const error = ref(null);
let chart = null;

const themeColors = () => {
  const styles = getComputedStyle(document.documentElement);
  return {
    text: styles.getPropertyValue('--text-muted').trim(),
    grid: styles.getPropertyValue('--border').trim(),
    accent: styles.getPropertyValue('--accent').trim(),
    good: styles.getPropertyValue('--good').trim(),
    bad: styles.getPropertyValue('--bad').trim(),
    surface: styles.getPropertyValue('--surface-2').trim(),
  };
};

async function renderTrend() {
  if (!props.kpi || !chartEl.value) return;
  loading.value = true;
  error.value = null;

  try {
    const { points } = await api.trend(props.kpi.kpiId, props.scope, props.period, 14);
    const colors = themeColors();

    chart ??= echarts.init(chartEl.value, null, { renderer: 'svg' });

    const values = points.map((p) => p.value);
    const thresholds = props.definition?.thresholds ?? {};

    const markLines = [];
    if (thresholds.good !== undefined) {
      markLines.push({
        yAxis: thresholds.good,
        lineStyle: { color: colors.good, type: 'dashed', width: 1 },
        label: { formatter: 'target', color: colors.good, fontSize: 10, position: 'insideEndTop' },
      });
    }
    if (thresholds.warn !== undefined) {
      markLines.push({
        yAxis: thresholds.warn,
        lineStyle: { color: colors.bad, type: 'dotted', width: 1 },
        label: { formatter: 'threshold', color: colors.bad, fontSize: 10, position: 'insideEndBottom' },
      });
    }

    chart.setOption(
      {
        grid: { top: 24, right: 18, bottom: 28, left: 52 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: colors.surface,
          borderColor: colors.grid,
          textStyle: { color: colors.text },
          valueFormatter: (v) => formatValue(v, props.kpi.unit),
        },
        xAxis: {
          type: 'category',
          data: points.map((p) => p.period.slice(5, 10)),
          axisLine: { lineStyle: { color: colors.grid } },
          axisLabel: { color: colors.text, fontSize: 10 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
          axisLabel: {
            color: colors.text,
            fontSize: 10,
            formatter: (v) => formatValue(v, props.kpi.unit),
          },
        },
        series: [
          {
            type: 'line',
            smooth: 0.3,
            data: values,
            connectNulls: true,
            symbolSize: 6,
            lineStyle: { width: 2.4, color: colors.accent },
            itemStyle: { color: colors.accent },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: `${colors.accent}44` },
                { offset: 1, color: `${colors.accent}00` },
              ]),
            },
            markLine: markLines.length ? { silent: true, symbol: 'none', data: markLines } : undefined,
          },
        ],
      },
      true,
    );
    chart.resize();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

const onResize = () => chart?.resize();

onMounted(() => {
  window.addEventListener('resize', onResize);
  renderTrend();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});

watch(() => props.kpi?.kpiId, renderTrend);
watch(() => props.period, renderTrend);

const percentileRows = computed(() => Object.entries(props.kpi?.percentiles ?? {}));

const relatedKpis = computed(() => {
  const ids = props.definition?.pairs_with ?? [];
  return ids.map((id) => props.catalog?.kpis?.find((k) => k.id === id)).filter(Boolean);
});
</script>

<template>
  <aside v-if="kpi" class="drawer" role="dialog" aria-modal="false" :aria-label="`${kpi.name} detail`">
    <header class="drawer-head">
      <div>
        <p class="domain faint">{{ definition?.domainName ?? kpi.domain }}</p>
        <h2>{{ kpi.name }}</h2>
      </div>
      <button class="close" type="button" aria-label="Close detail" @click="emit('close')">✕</button>
    </header>

    <section class="headline">
      <div>
        <span class="big" :class="`status-${kpi.status}`">{{ formatValue(kpi.value, kpi.unit) }}</span>
        <span v-if="kpi.previousValue !== null && kpi.previousValue !== undefined" class="prev faint">
          from {{ formatValue(kpi.previousValue, kpi.unit) }}
        </span>
      </div>
      <span v-if="kpi.confidence" class="chip chip-neutral">
        {{ kpi.confidence }} confidence · n={{ kpi.sampleSize ?? '—' }}
      </span>
    </section>

    <section v-if="kpi.unavailableReason" class="notice">
      <p>{{ kpi.unavailableReason }}</p>
      <ul v-if="kpi.missingInputs?.length">
        <li v-for="input in kpi.missingInputs" :key="input" class="mono">{{ input }}</li>
      </ul>
    </section>

    <section class="chart-block">
      <h3>Trend</h3>
      <div v-show="!error" ref="chartEl" class="chart" />
      <p v-if="loading" class="faint">Loading trend…</p>
      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-if="percentileRows.length" class="block">
      <h3>Distribution</h3>
      <div class="pct-grid">
        <div v-for="[key, val] in percentileRows" :key="key" class="pct">
          <span class="pct-key faint">{{ key }}</span>
          <span class="pct-val">{{ formatValue(val, kpi.unit) }}</span>
        </div>
      </div>
    </section>

    <section v-if="definition" class="block">
      <h3>Definition</h3>
      <p class="formula mono">{{ definition.formula_display ?? definition.formula }}</p>
      <dl class="facts">
        <div><dt>Unit</dt><dd>{{ definition.unit }}</dd></div>
        <div><dt>Direction</dt><dd>{{ definition.direction.replace(/_/g, ' ') }}</dd></div>
        <div><dt>Data source</dt><dd>{{ definition.feasibility }}</dd></div>
        <div><dt>Revision</dt><dd>r{{ definition.revision }}</dd></div>
      </dl>
    </section>

    <section v-if="definition?.benchmarks" class="block">
      <h3>Benchmarks</h3>
      <ul class="plain">
        <li v-for="(val, key) in definition.benchmarks" :key="key">
          <strong>{{ key }}</strong> — {{ val }}
        </li>
      </ul>
    </section>

    <section v-if="definition?.interpretation" class="block">
      <h3>How to read it</h3>
      <p>{{ definition.interpretation }}</p>
    </section>

    <section v-if="definition?.caveats?.length" class="block caveats">
      <h3>Caveats</h3>
      <ul class="plain">
        <li v-for="caveat in definition.caveats" :key="caveat">{{ caveat }}</li>
      </ul>
    </section>

    <section v-if="relatedKpis.length" class="block">
      <h3>Read alongside</h3>
      <div class="related">
        <button
          v-for="related in relatedKpis"
          :key="related.id"
          class="chip chip-accent related-btn"
          type="button"
          @click="emit('open-kpi', related.id)"
        >
          {{ related.name }}
        </button>
      </div>
    </section>

    <section v-if="definition?.sources?.length" class="block">
      <h3>Sources</h3>
      <ul class="plain sources">
        <li v-for="(source, i) in definition.sources" :key="i">
          <span class="mono">{{ source.system }}</span>
          <span v-if="source.entity"> → {{ source.entity }}</span>
          <p v-if="source.notes" class="faint note">{{ source.notes }}</p>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 100vw);
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.3);
  padding: 18px 20px 40px;
  overflow-y: auto;
  z-index: 40;
  animation: slide-in 0.18s ease;
}

@keyframes slide-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.drawer-head h2 {
  margin: 2px 0 0;
  font-size: 19px;
  letter-spacing: -0.01em;
}

.domain {
  margin: 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.close {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 30px;
  height: 30px;
  color: var(--text-muted);
}

.close:hover { background: var(--surface-3); color: var(--text); }

.headline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0 16px;
  border-bottom: 1px solid var(--border);
}

.big {
  font-size: 34px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.prev {
  font-size: 12px;
  margin-left: 8px;
}

.notice {
  background: var(--warn-soft);
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin: 14px 0;
  font-size: 12px;
}

.notice p { margin: 0 0 6px; }
.notice ul { margin: 0; padding-left: 16px; }

.block, .chart-block { margin-top: 20px; }

h3 {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
}

.chart { width: 100%; height: 190px; }

.error { color: var(--bad); font-size: 12px; }

.formula {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 11px;
  margin: 0 0 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 0;
}

.facts > div { display: flex; flex-direction: column; }
.facts dt { font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; }
.facts dd { margin: 0; font-size: 13px; }

.pct-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 8px;
}

.pct {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
}

.pct-key { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.pct-val { font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; }

.plain { margin: 0; padding-left: 16px; font-size: 13px; }
.plain li { margin-bottom: 5px; }

.caveats { border-left: 2px solid var(--warn); padding-left: 12px; }

.related { display: flex; flex-wrap: wrap; gap: 6px; }
.related-btn { border-style: solid; }

.sources { list-style: none; padding: 0; }
.sources li { border-bottom: 1px solid var(--border); padding: 6px 0; }
.note { margin: 3px 0 0; font-size: 11px; }
</style>
