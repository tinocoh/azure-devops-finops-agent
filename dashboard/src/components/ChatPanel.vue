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
  'List all the projects',
  'What should I focus on right now?',
  'How are we doing overall?',
  'Where is pipeline money being wasted?',
  'Are we on budget?',
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
    // Deliberately before the health intent: "status of all projects" must not be
    // captured by the single-scope health answer.
    match: /\b(list|show|which|what)\b.*\bprojects?\b|\ball (the )?projects?\b|\bportfolio\b|\bprojects?\b.*\b(status|health|doing)\b/i,
    run: async () => {
      const { projects } = await api.scopes(props.scope.organization);
      if (!projects?.length) return 'No projects are visible for this organisation.';

      // One scorecard per project. Trends are skipped — this is a comparison view, and
      // requesting trends here would multiply the work for no visible gain.
      const rows = await Promise.all(
        projects.map(async (project) => {
          try {
            const card = await api.scorecard(
              { organization: props.scope.organization, project: project.name },
              props.period,
              { trend: false },
            );
            const weakest = [...card.domains]
              .filter((d) => d.score !== null)
              .sort((a, b) => a.score - b.score)[0];
            return {
              name: project.name,
              teams: project.teams?.length ?? 0,
              score: card.overallScore,
              weakest: weakest?.name ?? '—',
              weakestScore: weakest?.score ?? null,
            };
          } catch {
            return { name: project.name, teams: project.teams?.length ?? 0, score: null, weakest: '—' };
          }
        }),
      );

      rows.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

      // A list rather than a Markdown table: the panel is ~356px wide, and the safe
      // renderer here handles bold and line breaks only. A four-column table would be
      // both cramped and rendered as raw pipes.
      const list = rows
        .map((r) => {
          const glyph = r.score === null ? '⚪' : r.score >= 75 ? '🟢' : r.score >= 50 ? '🟡' : '🔴';
          const weakest =
            r.weakest === '—'
              ? ''
              : `\n   weakest: ${r.weakest}${r.weakestScore !== null ? ` (${Math.round(r.weakestScore)}/100)` : ''}`;
          const teams = r.teams > 0 ? ` · ${r.teams} team${r.teams === 1 ? '' : 's'}` : '';
          return `${glyph} **${r.name}** — ${r.score ?? 'not scored'}${r.score !== null ? '/100' : ''}${teams}${weakest}`;
        })
        .join('\n\n');

      const worst = rows[0];
      return (
        `**${rows.length} projects — ${props.period}**\n\n${list}\n\n` +
        (worst && worst.score !== null
          ? `Lowest is **${worst.name}** at ${worst.score}/100, dragged down by ${worst.weakest}. ` +
            'Select it in the project filter to drill in.'
          : '')
      );
    },
  },
  {
    // "what should I focus on", "top priorities", "what is critical" — this exists because
    // without it the word "focus" fell through to a KPI-name match and confidently
    // returned Focus Factor, which answers a completely different question.
    match: /\b(focus|prioriti|priority|critical|urgent|attention|most important|top \d*\s*(issue|problem|thing|item)s?)\b/i,
    run: () => {
      const s = props.scorecard;
      if (!s) return 'The scorecard has not loaded yet.';

      const bad = allKpis()
        .filter((k) => k.status === 'bad' && k.value !== null)
        // Deteriorating problems outrank stable ones: a bad number getting worse is
        // where attention actually changes the outcome.
        .sort((a, b) => {
          const worsening = (k) => (k.improving === false ? 0 : 1);
          if (worsening(a) !== worsening(b)) return worsening(a) - worsening(b);
          return Math.abs(b.deltaPercent ?? 0) - Math.abs(a.deltaPercent ?? 0);
        })
        .slice(0, 5);

      if (bad.length === 0) {
        return (
          `Nothing is in the red for ${scopeName()} over ${props.period}. ` +
          `Overall health is ${s.overallScore}/100. The weakest domain is ` +
          `**${[...s.domains].filter((d) => d.score !== null).sort((a, b) => a.score - b.score)[0]?.name}**.`
        );
      }

      const lines = bad
        .map((k) => {
          const move =
            k.deltaPercent === null || k.deltaPercent === undefined
              ? ''
              : k.improving === false
                ? ` — worsening ${Math.abs(k.deltaPercent).toFixed(1)}%`
                : ` — improving ${Math.abs(k.deltaPercent).toFixed(1)}%`;
          return `- **${k.name}**: ${formatValue(k.value, k.unit)}${move}`;
        })
        .join('\n');

      const worsening = bad.filter((k) => k.improving === false).length;
      return (
        `**${bad.length} KPI(s) need attention — ${scopeName()}, ${props.period}**\n\n${lines}\n\n` +
        (worsening > 0
          ? `${worsening} of these are still getting worse — start there.`
          : 'None are deteriorating further, so these are chronic rather than acute.')
      );
    },
  },
  {
    match: /overall|how are we|health|summary|status|doing/i,
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
  //
  // This used to accept any word over three characters against any part of a KPI name,
  // which meant "what should I focus on" matched "Focus Factor" and answered a completely
  // different question with total confidence. A wrong answer that looks right is the worst
  // failure mode a metrics tool has, so the matching is now scored, stop-worded, and
  // explicit whenever it is guessing.
  const STOP_WORDS = new Set([
    'what', 'whats', 'which', 'where', 'when', 'should', 'right', 'this', 'that', 'there',
    'here', 'have', 'been', 'with', 'from', 'about', 'into', 'over', 'more', 'most', 'much',
    'many', 'some', 'them', 'they', 'their', 'your', 'ours', 'tell', 'show', 'give', 'need',
    'want', 'help', 'know', 'look', 'like', 'just', 'only', 'also', 'very', 'really', 'now',
    'today', 'please', 'could', 'would', 'does', 'doing', 'make', 'made', 'take', 'good',
    'best', 'worst', 'high', 'time', 'rate', 'cost',
  ]);

  const kpis = allKpis();
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  const scored = kpis
    .map((k) => {
      const name = k.name.toLowerCase();
      const nameTokens = name.split(/[^a-z]+/).filter(Boolean);
      let score = 0;

      // Whole KPI name appearing in the question is decisive.
      if (name.length > 4 && text.toLowerCase().includes(name)) score += 100;

      for (const w of words) {
        // Exact token match is strong; a substring match is weak and only counts a little.
        if (nameTokens.includes(w)) score += 10;
        else if (name.includes(w)) score += 2;
      }
      return { kpi: k, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  // A single weak token ("cost", "focus") is not enough to commit to an answer.
  if (best && best.score >= 10) {
    const runnersUp = scored.slice(1, 4).filter((c) => c.score >= 10);
    const hit = best.kpi;
    const movement =
      hit.deltaPercent !== null && hit.deltaPercent !== undefined
        ? ` — ${hit.improving ? 'improving' : 'deteriorating'} by ${Math.abs(hit.deltaPercent).toFixed(1)}% versus the previous period`
        : '';

    const alternatives =
      runnersUp.length > 0
        ? `\n\nAlso matched: ${runnersUp.map((c) => c.kpi.name).join(', ')}.`
        : '';

    push(
      'agent',
      (hit.value === null
        ? `**${hit.name}** is not available. ${hit.unavailableReason}`
        : `**${hit.name}** is **${formatValue(hit.value, hit.unit)}**${movement}.`) + alternatives,
      { local: true, kpiId: hit.kpiId },
    );
    return;
  }

  // Weak match: say it is a guess rather than presenting it as the answer.
  if (best) {
    push(
      'agent',
      `I'm not confident I understood that. The closest KPI I have is **${best.kpi.name}** ` +
        `(${formatValue(best.kpi.value, best.kpi.unit)}) — but that may not be what you meant.\n\n` +
        'Try: *list all the projects*, *what should I focus on*, *where is pipeline money ' +
        'being wasted*, *are we on budget*, or name a KPI directly.',
      { local: true, kpiId: best.kpi.kpiId },
    );
    return;
  }

  push(
    'agent',
    'This is the **offline responder**, not the Copilot Studio agent — it matches a small set ' +
      'of intents against the loaded scorecard.\n\n' +
      'Try: *list all the projects*, *what should I focus on right now*, *how are we doing ' +
      'overall*, *where is pipeline money being wasted*, *are we on budget*, or *anything I ' +
      'should worry about*. Connect a Direct Line token to talk to the real agent.',
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
