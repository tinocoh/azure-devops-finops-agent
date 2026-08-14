<script setup>
import { nextTick, ref, watch } from 'vue';
import { api, formatValue } from '../api.js';

/**
 * Conversation panel.
 *
 * Two modes, decided at runtime:
 *
 *  - **connected** — talks to the Copilot Studio agent over Direct Line. This is the real
 *    product surface: full generative orchestration, Entra identity, the MCP tools.
 *  - **offline**   — the local demo. Copilot Studio is SaaS and has no offline mode
 *    (ADR-0001), so instead of faking an LLM we run a small deterministic intent matcher
 *    against the same KPI server the tiles use. It is honest about being a local responder
 *    rather than pretending to be the agent.
 */

const props = defineProps({
  scope: { type: Object, required: true },
  period: { type: String, required: true },
  scorecard: { type: Object, default: null },
  directLineToken: { type: String, default: '' },
});

const emit = defineEmits(['open-kpi']);

const messages = ref([]);
const input = ref('');
const busy = ref(false);
const listEl = ref(null);
const mode = ref(props.directLineToken ? 'connected' : 'offline');

let conversation = null;

const SUGGESTIONS = [
  'How are we doing overall?',
  'What is our change failure rate?',
  'Where is pipeline money being wasted?',
  'Are we on budget?',
  'Anything I should worry about?',
];

function push(role, text, meta = {}) {
  messages.value.push({ id: crypto.randomUUID(), role, text, ...meta });
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}

async function ensureConversation() {
  if (conversation || mode.value !== 'connected') return;
  const response = await fetch('https://directline.botframework.com/v3/directline/conversations', {
    method: 'POST',
    headers: { authorization: `Bearer ${props.directLineToken}` },
  });
  if (!response.ok) throw new Error(`Direct Line handshake failed (HTTP ${response.status}).`);
  conversation = await response.json();
}

async function sendConnected(text) {
  await ensureConversation();
  await fetch(
    `https://directline.botframework.com/v3/directline/conversations/${conversation.conversationId}/activities`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${props.directLineToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'message', from: { id: 'dashboard-user' }, text }),
    },
  );

  // Poll for the reply. Direct Line also offers a WebSocket stream; polling keeps the
  // dependency surface small for a dashboard panel.
  const deadline = Date.now() + 45_000;
  let watermark = conversation.watermark ?? null;

  while (Date.now() < deadline) {
    const url = `https://directline.botframework.com/v3/directline/conversations/${conversation.conversationId}/activities${
      watermark ? `?watermark=${watermark}` : ''
    }`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${props.directLineToken}` } });
    const payload = await response.json();
    watermark = payload.watermark ?? watermark;

    const reply = (payload.activities ?? []).find(
      (a) => a.type === 'message' && a.from?.id !== 'dashboard-user',
    );
    if (reply?.text) {
      push('agent', reply.text);
      return;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  push('agent', 'The agent did not respond in time. Check the Direct Line channel configuration.');
}

/* ── offline responder ──────────────────────────────────────────────────────────
   Deterministic intent matching over the live scorecard. No language model, and it
   says so, because a demo that silently degrades to canned text is worse than one
   that is clear about what it is. */

const INTENTS = [
  {
    match: /overall|how are we|health|summary|status/i,
    run: () => {
      const s = props.scorecard;
      if (!s) return 'The scorecard has not loaded yet.';
      const weakest = [...s.domains].filter((d) => d.score !== null).sort((a, b) => a.score - b.score)[0];
      const strongest = [...s.domains].filter((d) => d.score !== null).sort((a, b) => b.score - a.score)[0];
      return (
        `Overall health is **${s.overallScore}/100** for ${scopeName()} over ${props.period}.\n\n` +
        `Strongest area: **${strongest.name}** (${strongest.score}). ` +
        `Weakest: **${weakest.name}** (${weakest.score}).\n\n` +
        `Data completeness is ${s.dataQuality.completeness}% — ` +
        `${s.dataQuality.referenceDataMissing.length === 0 ? 'all reference data is loaded' : `missing ${s.dataQuality.referenceDataMissing.join(', ')}`}.`
      );
    },
  },
  {
    match: /waste|pipeline|ci cost|build cost|expensive/i,
    run: () => {
      const values = allKpis().filter((k) => k.domain === 'pipeline');
      const waste = values.find((k) => k.kpiId === 'pipeline.failed_run_waste');
      const lines = values
        .filter((k) => k.value !== null)
        .map((k) => `- ${k.name}: **${formatValue(k.value, k.unit)}**`)
        .join('\n');
      const wasted = waste?.percentiles?.wastedMinutes;
      return (
        `**Pipeline economics**\n\n${lines}\n\n` +
        (wasted
          ? `${wasted} minutes of compute produced no deployable artefact in this window. ` +
            'Flaky tests and slow-failing builds are the two levers here.'
          : '')
      );
    },
  },
  {
    match: /budget|margin|profit|cost of delivery|cpi|spi|earned value/i,
    run: () => {
      const values = allKpis().filter((k) => k.domain === 'profitability');
      const available = values.filter((k) => k.value !== null);
      if (available.length === 0) {
        const missing = [...new Set(values.flatMap((k) => k.missingInputs ?? []))];
        return (
          'Profitability cannot be computed — Azure DevOps holds no budgets, rates or revenue.\n\n' +
          `Missing reference data: ${missing.join(', ')}.`
        );
      }
      return (
        `**Profitability — ${scopeName()}**\n\n` +
        available.map((k) => `- ${k.name}: **${formatValue(k.value, k.unit)}**`).join('\n')
      );
    },
  },
  {
    match: /worry|risk|anomal|what changed|alert/i,
    run: async () => {
      const { anomalies } = await api.anomalies(props.scope, props.period);
      if (anomalies.length === 0) return 'No statistical anomalies. Every monitored KPI sits within its recent range.';
      return (
        `**${anomalies.length} anomaly signal(s)**\n\n` +
        anomalies
          .map(
            (a) =>
              `- ${a.direction === 'deterioration' ? '🔴' : '🟢'} **${a.name}** at ` +
              `${formatValue(a.value, a.unit)} against a baseline of ${formatValue(a.baseline, a.unit)} (z=${a.zScore})`,
          )
          .join('\n')
      );
    },
  },
];

function scopeName() {
  return [props.scope.project, props.scope.team].filter(Boolean).join(' / ') || props.scope.organization;
}

function allKpis() {
  return props.scorecard?.domains.flatMap((d) => d.kpis) ?? [];
}

async function sendOffline(text) {
  const intent = INTENTS.find((i) => i.match.test(text));
  if (intent) {
    push('agent', await intent.run(), { local: true });
    return;
  }

  // Fall back to matching a KPI by name.
  const kpis = allKpis();
  const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((w) => w.length > 3);
  const hit = kpis.find((k) => words.some((w) => k.name.toLowerCase().includes(w)));

  if (hit) {
    const movement =
      hit.deltaPercent !== null && hit.deltaPercent !== undefined
        ? ` — ${hit.improving ? 'improving' : 'deteriorating'} by ${Math.abs(hit.deltaPercent).toFixed(1)}% versus the previous period`
        : '';
    push(
      'agent',
      hit.value === null
        ? `**${hit.name}** is not available. ${hit.unavailableReason}`
        : `**${hit.name}** is **${formatValue(hit.value, hit.unit)}**${movement}.`,
      { local: true, kpiId: hit.kpiId },
    );
    return;
  }

  push(
    'agent',
    'This is the **offline responder**, not the Copilot Studio agent — it matches a small set ' +
      'of intents against the loaded scorecard. Try asking about overall health, pipeline ' +
      'waste, budget and margin, or anything to worry about. Connect a Direct Line token to ' +
      'talk to the real agent.',
    { local: true },
  );
}

async function send(text = input.value) {
  const trimmed = text.trim();
  if (!trimmed || busy.value) return;

  push('user', trimmed);
  input.value = '';
  busy.value = true;

  try {
    if (mode.value === 'connected') await sendConnected(trimmed);
    else await sendOffline(trimmed);
  } catch (error) {
    push('agent', `Something went wrong: ${error.message}`, { error: true });
  } finally {
    busy.value = false;
  }
}

/** Minimal, safe Markdown: bold, code and line breaks only. No raw HTML is ever injected. */
function render(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br />');
}

watch(
  () => props.directLineToken,
  (token) => {
    mode.value = token ? 'connected' : 'offline';
    conversation = null;
  },
);
</script>

<template>
  <section class="chat card" aria-label="Agent conversation">
    <header class="chat-head">
      <h2>Ask the agent</h2>
      <span class="chip" :class="mode === 'connected' ? 'chip-good' : 'chip-neutral'">
        {{ mode === 'connected' ? 'Copilot Studio' : 'offline responder' }}
      </span>
    </header>

    <div ref="listEl" class="messages">
      <div v-if="messages.length === 0" class="empty">
        <p class="faint">
          {{
            mode === 'connected'
              ? 'Connected to the Copilot Studio agent over Direct Line.'
              : 'Running offline against the local KPI server. Copilot Studio is a cloud service and cannot run on this machine — see ADR-0001.'
          }}
        </p>
        <div class="suggestions">
          <button
            v-for="suggestion in SUGGESTIONS"
            :key="suggestion"
            class="suggestion"
            type="button"
            @click="send(suggestion)"
          >
            {{ suggestion }}
          </button>
        </div>
      </div>

      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="[`from-${message.role}`, { error: message.error }]"
      >
        <div class="bubble" v-html="render(message.text)" />
        <button
          v-if="message.kpiId"
          class="jump"
          type="button"
          @click="emit('open-kpi', message.kpiId)"
        >
          Open detail →
        </button>
      </article>

      <p v-if="busy" class="faint thinking">Working…</p>
    </div>

    <form class="composer" @submit.prevent="send()">
      <input
        v-model="input"
        type="text"
        placeholder="Ask about delivery, cost or margin…"
        aria-label="Message"
        :disabled="busy"
      />
      <button type="submit" :disabled="busy || !input.trim()" aria-label="Send">↑</button>
    </form>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.chat-head h2 { margin: 0; font-size: 13px; letter-spacing: 0.01em; }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.empty { display: flex; flex-direction: column; gap: 12px; }
.empty p { margin: 0; font-size: 12px; }

.suggestions { display: flex; flex-direction: column; gap: 6px; }

.suggestion {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
}

.suggestion:hover { background: var(--surface-3); color: var(--text); border-color: var(--accent); }

.message { display: flex; flex-direction: column; gap: 4px; }
.from-user { align-items: flex-end; }

.bubble {
  max-width: 92%;
  padding: 9px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.55;
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.from-user .bubble {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.message.error .bubble { border-color: var(--bad); color: var(--bad); }

.bubble :deep(code) {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--surface-3);
  padding: 1px 4px;
  border-radius: 4px;
}

.jump {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 11px;
  padding: 0;
  align-self: flex-start;
}

.thinking { font-size: 12px; margin: 0; }

.composer {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}

.composer input {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 11px;
  color: var(--text);
  font-size: 13px;
}

.composer input:focus { border-color: var(--accent); outline: none; }

.composer button {
  width: 34px;
  border-radius: var(--radius);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-size: 15px;
}

.composer button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
