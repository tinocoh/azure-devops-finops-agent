<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import KpiTile from './components/KpiTile.vue';
import KpiDrawer from './components/KpiDrawer.vue';
import ScoreGauge from './components/ScoreGauge.vue';
import ChatPanel from './components/ChatPanel.vue';
import { api } from './api.js';

const PERIODS = [
  { value: 'last 30 days', label: '30 days' },
  { value: 'last 90 days', label: '90 days' },
  { value: 'last quarter', label: 'Quarter' },
  { value: 'last 6 months', label: '6 months' },
  { value: 'ytd', label: 'Year to date' },
];

const health = ref(null);
const catalog = ref(null);
const scopes = ref([]);
const scorecard = ref(null);
const anomalies = ref([]);

const organization = ref('contoso');
const project = ref('');
const team = ref('');
const period = ref('last 90 days');
const activeDomain = ref('all');
const showChat = ref(true);
const selected = ref(null);

const loading = ref(true);
const error = ref(null);

const directLineToken = ref(import.meta.env.VITE_DIRECTLINE_TOKEN ?? '');

const scope = computed(() => ({
  organization: organization.value,
  project: project.value || undefined,
  team: team.value || undefined,
}));

const availableTeams = computed(
  () => scopes.value.find((p) => p.name === project.value)?.teams ?? [],
);

const definitionsById = computed(() => {
  const map = new Map();
  for (const kpi of catalog.value?.kpis ?? []) map.set(kpi.id, kpi);
  return map;
});

const domains = computed(() => scorecard.value?.domains ?? []);

const visibleDomains = computed(() =>
  activeDomain.value === 'all' ? domains.value : domains.value.filter((d) => d.id === activeDomain.value),
);

const attention = computed(() =>
  domains.value
    .flatMap((d) => d.kpis)
    .filter((k) => k.status === 'bad')
    .sort((a, b) => (a.improving === false ? -1 : 0) - (b.improving === false ? -1 : 0))
    .slice(0, 4),
);

const selectedDefinition = computed(() =>
  selected.value ? definitionsById.value.get(selected.value.kpiId) : null,
);

async function loadStatic() {
  const [h, c] = await Promise.all([api.health(), api.catalog()]);
  health.value = h;
  catalog.value = c;
  const s = await api.scopes(organization.value);
  scopes.value = s.projects;
  if (!project.value && s.projects.length > 0) project.value = s.projects[0].name;
}

async function loadScorecard() {
  loading.value = true;
  error.value = null;
  try {
    const [card, anomalyResult] = await Promise.all([
      api.scorecard(scope.value, period.value, { trend: true, buckets: 10 }),
      api.anomalies(scope.value, period.value).catch(() => ({ anomalies: [] })),
    ]);
    scorecard.value = card;
    anomalies.value = anomalyResult.anomalies ?? [];

    // Keep the drawer in sync when filters change beneath it.
    if (selected.value) {
      const refreshed = card.domains.flatMap((d) => d.kpis).find((k) => k.kpiId === selected.value.kpiId);
      selected.value = refreshed ?? null;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function openKpi(kpiOrId) {
  const id = typeof kpiOrId === 'string' ? kpiOrId : kpiOrId.kpiId;
  selected.value = domains.value.flatMap((d) => d.kpis).find((k) => k.kpiId === id) ?? null;
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  localStorage.setItem('ado-kpi-theme', next);
}

watch(project, () => {
  team.value = '';
  loadScorecard();
});
watch([team, period, organization], loadScorecard);

onMounted(async () => {
  try {
    await loadStatic();
    await loadScorecard();
  } catch (err) {
    error.value = err.message;
    loading.value = false;
  }
});
</script>

<template>
  <div class="shell">
    <!-- ── header ───────────────────────────────────────────────────────────── -->
    <header class="topbar">
      <div class="brand">
        <svg viewBox="0 0 32 32" class="logo" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--accent-strong)" />
          <path d="M8 21V13m6 8V9m6 12v-5m-12 5h18" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none" />
        </svg>
        <div>
          <h1>Azure DevOps FinOps &amp; Delivery Intelligence</h1>
          <p class="faint sub">
            {{ catalog?.kpis?.length ?? '—' }} KPIs · delivery, engineering cost and project profitability
          </p>
        </div>
      </div>

      <div class="topbar-actions">
        <span
          v-if="health"
          class="chip"
          :class="health.provider === 'live' ? 'chip-good' : 'chip-accent'"
          :title="health.providerDescription"
        >
          {{ health.provider === 'live' ? 'live data' : 'demo data' }}
        </span>
        <button class="icon-btn" type="button" title="Toggle theme" @click="toggleTheme">◐</button>
        <button
          class="icon-btn"
          type="button"
          :title="showChat ? 'Hide agent panel' : 'Show agent panel'"
          @click="showChat = !showChat"
        >
          💬
        </button>
      </div>
    </header>

    <!-- ── filters ──────────────────────────────────────────────────────────── -->
    <nav class="filters" aria-label="Scope and period">
      <label class="field">
        <span>Project</span>
        <select v-model="project">
          <option value="">All projects</option>
          <option v-for="p in scopes" :key="p.id" :value="p.name">{{ p.name }}</option>
        </select>
      </label>

      <label class="field">
        <span>Team</span>
        <select v-model="team" :disabled="!project || availableTeams.length === 0">
          <option value="">All teams</option>
          <option v-for="t in availableTeams" :key="t.id" :value="t.name">{{ t.name }}</option>
        </select>
      </label>

      <div class="segmented" role="group" aria-label="Period">
        <button
          v-for="option in PERIODS"
          :key="option.value"
          type="button"
          :class="{ active: period === option.value }"
          @click="period = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <span v-if="loading" class="chip chip-neutral loading-chip">refreshing…</span>
    </nav>

    <!-- ── body ─────────────────────────────────────────────────────────────── -->
    <main class="body" :class="{ 'with-chat': showChat }">
      <div class="content">
        <p v-if="error" class="error-banner">{{ error }}</p>

        <!-- summary strip -->
        <section v-if="scorecard" class="summary card">
          <ScoreGauge :score="scorecard.overallScore" />

          <div class="summary-domains">
            <button
              v-for="domain in domains"
              :key="domain.id"
              class="domain-pill"
              :class="{ active: activeDomain === domain.id, dim: domain.score === null }"
              type="button"
              @click="activeDomain = activeDomain === domain.id ? 'all' : domain.id"
            >
              <span class="pill-name">{{ domain.name }}</span>
              <span class="pill-score" :class="domain.score === null ? '' : domain.score >= 75 ? 'status-good' : domain.score >= 50 ? 'status-warn' : 'status-bad'">
                {{ domain.score === null ? '—' : Math.round(domain.score) }}
              </span>
            </button>
          </div>

          <div class="quality">
            <div class="quality-row">
              <span class="faint">Data completeness</span>
              <strong>{{ scorecard.dataQuality.completeness }}%</strong>
            </div>
            <div class="quality-bar">
              <span :style="{ width: `${scorecard.dataQuality.completeness}%` }" />
            </div>
            <ul class="warnings">
              <li v-for="warning in scorecard.dataQuality.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </div>
        </section>

        <!-- anomalies -->
        <section v-if="anomalies.length" class="anomalies card">
          <h2>Signals</h2>
          <div class="anomaly-list">
            <button
              v-for="anomaly in anomalies"
              :key="anomaly.kpiId"
              class="anomaly"
              :class="anomaly.direction"
              type="button"
              @click="openKpi(anomaly.kpiId)"
            >
              <span class="anomaly-name">{{ anomaly.name }}</span>
              <span class="faint">
                {{ anomaly.direction === 'deterioration' ? 'deteriorating' : 'improving' }} sharply
                (z={{ anomaly.zScore }})
              </span>
            </button>
          </div>
        </section>

        <!-- needs attention -->
        <section v-if="attention.length && activeDomain === 'all'">
          <h2 class="section-title">Needs attention</h2>
          <div class="grid">
            <KpiTile
              v-for="kpi in attention"
              :key="kpi.kpiId"
              :kpi="kpi"
              :definition="definitionsById.get(kpi.kpiId)"
              @open="openKpi"
            />
          </div>
        </section>

        <!-- headline -->
        <section v-if="scorecard?.headline?.length && activeDomain === 'all'">
          <h2 class="section-title">Headline</h2>
          <div class="grid">
            <KpiTile
              v-for="kpi in scorecard.headline"
              :key="kpi.kpiId"
              :kpi="kpi"
              :definition="definitionsById.get(kpi.kpiId)"
              @open="openKpi"
            />
          </div>
        </section>

        <!-- per domain -->
        <section v-for="domain in visibleDomains" :key="domain.id">
          <h2 class="section-title">
            {{ domain.name }}
            <span v-if="domain.score !== null" class="faint">· {{ Math.round(domain.score) }}/100</span>
          </h2>
          <div class="grid">
            <KpiTile
              v-for="kpi in domain.kpis"
              :key="kpi.kpiId"
              :kpi="kpi"
              :definition="definitionsById.get(kpi.kpiId)"
              compact
              @open="openKpi"
            />
          </div>
        </section>

        <footer v-if="scorecard" class="footer faint">
          Catalog {{ scorecard.catalogVersion }} · generated
          {{ new Date(scorecard.generatedAt).toLocaleString() }} ·
          {{ health?.provider === 'live' ? 'live Azure DevOps data' : 'deterministic demo data' }}
        </footer>
      </div>

      <ChatPanel
        v-if="showChat"
        class="chat-slot"
        :scope="scope"
        :period="period"
        :scorecard="scorecard"
        :direct-line-token="directLineToken"
        @open-kpi="openKpi"
      />
    </main>

    <KpiDrawer
      v-if="selected"
      :kpi="selected"
      :definition="selectedDefinition"
      :scope="scope"
      :period="period"
      :catalog="catalog"
      @close="selected = null"
      @open-kpi="openKpi"
    />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── topbar ── */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.brand { display: flex; align-items: center; gap: 12px; }
.logo { width: 32px; height: 32px; flex-shrink: 0; }

.topbar h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 640;
  letter-spacing: -0.01em;
}

.sub { margin: 1px 0 0; font-size: 11px; }

.topbar-actions { display: flex; align-items: center; gap: 8px; }

.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 13px;
}

.icon-btn:hover { background: var(--surface-3); color: var(--text); }

/* ── filters ── */
.filters {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-wrap: wrap;
}

.field { display: flex; flex-direction: column; gap: 3px; }

.field span {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.field select {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 9px;
  color: var(--text);
  font-size: 13px;
  min-width: 168px;
}

.field select:disabled { opacity: 0.5; }

.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface);
}

.segmented button {
  border: none;
  background: transparent;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  border-right: 1px solid var(--border);
}

.segmented button:last-child { border-right: none; }
.segmented button:hover { background: var(--surface-3); }
.segmented button.active { background: var(--accent); color: #fff; font-weight: 600; }

.loading-chip { margin-left: auto; }

/* ── body ── */
.body {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr;
  min-height: 0;
}

.body.with-chat { grid-template-columns: 1fr 356px; }

.content {
  overflow-y: auto;
  padding: 18px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-width: 0;
}

.chat-slot {
  border-left: 1px solid var(--border);
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
  min-height: 0;
}

.error-banner {
  background: var(--bad-soft);
  border: 1px solid var(--bad);
  color: var(--bad);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin: 0;
  font-size: 13px;
}

/* ── summary ── */
.summary {
  display: grid;
  grid-template-columns: auto 1fr 260px;
  gap: 24px;
  align-items: center;
  padding: 16px 20px;
}

.summary-domains {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 7px;
}

.domain-pill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-muted);
  text-align: left;
}

.domain-pill:hover { border-color: var(--accent); color: var(--text); }
.domain-pill.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.domain-pill.dim { opacity: 0.55; }

.pill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill-score { font-weight: 680; font-variant-numeric: tabular-nums; }

.quality { display: flex; flex-direction: column; gap: 6px; }
.quality-row { display: flex; justify-content: space-between; font-size: 12px; }

.quality-bar {
  height: 5px;
  background: var(--surface-3);
  border-radius: 99px;
  overflow: hidden;
}

.quality-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 99px;
  transition: width 0.4s ease;
}

.warnings {
  margin: 4px 0 0;
  padding-left: 15px;
  font-size: 11px;
  color: var(--text-faint);
  max-height: 78px;
  overflow-y: auto;
}

.warnings li { margin-bottom: 3px; }

/* ── anomalies ── */
.anomalies { padding: 14px 18px; }
.anomalies h2 { margin: 0 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-faint); }
.anomaly-list { display: flex; flex-wrap: wrap; gap: 8px; }

.anomaly {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
  text-align: left;
  font-size: 12px;
}

.anomaly.deterioration { border-left: 3px solid var(--bad); }
.anomaly.improvement { border-left: 3px solid var(--good); }
.anomaly:hover { background: var(--surface-3); }
.anomaly-name { font-weight: 600; }
.anomaly .faint { font-size: 11px; }

/* ── grid ── */
.section-title {
  margin: 0 0 11px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
  font-weight: 650;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(226px, 1fr));
  gap: var(--gap);
}

.footer { font-size: 11px; text-align: center; padding-top: 6px; }

@media (max-width: 1180px) {
  .summary { grid-template-columns: 1fr; }
  .body.with-chat { grid-template-columns: 1fr; }
  .chat-slot { display: none; }
}
</style>
