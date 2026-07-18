// The AI History window — a large (≈80%×80%) modal for auditing the AI. Two
// tabs:
//   History — every request/response for the selected agent (command, the
//             actions it produced, latency, and the verbatim model output).
//   Config  — exactly what we send the model, split into friendly sections
//             (with a per-section KV-cache badge and the total prompt size).
// An agent selector switches which agent you're inspecting (one today, more
// later). Data comes from the host on demand via { m: 'aiHistoryReq' }, and an
// open window refetches when the host reports a new exchange (aiEvents).
import { describeAction, describeView, unitShort } from '@game/shared';
import type {
  Action,
  ActionRecord,
  ActionStatus,
  AiConfigView,
  AiExchange,
  AiPromptPart,
  AiRuntimeStatus,
  AiStats,
  MemoryOp,
  MemoryRevision,
} from '@game/shared';
import {
  actionLog,
  aiData,
  aiEvents,
  aiStatus,
  sendAiHistoryReq,
  sendAiMemoryEdit,
  sendAiModel,
  sendAiStatusReq,
  sendAiVoice,
} from '../net/client';
import { actionStatusMark } from './attribution';
import { closeLayer, openLayer } from './escStack';
import { setActive } from '../state/activeSurface';
import { setUi } from '../state/uiState';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** A stable key for matching an exchange's action to its live ActionRecord: the
 *  tick it was dispatched plus its type, unit, and target tile. The AI dispatches
 *  all of an exchange's actions on the exchange's own tick, so (tick, type, unit,
 *  coord) pins each one down. Used to look up the current execution status for
 *  the AI-history view (the exchange itself stores only the raw Action). */
function actionSig(a: Action, tick: number): string {
  const c = a.type === 'move' ? a.to : a.type === 'harvest' ? a.target : a.type === 'build' ? a.at : undefined;
  return `${tick}|${a.type}|${a.unitId}|${c ? `${c.x},${c.y}` : ''}`;
}

/** Index the live action log by signature → status, so AI-history actions can
 *  show their outcome. Point-in-time: it reflects the log as of this render (the
 *  Actions panel is the live view); old actions aged out of the ring simply have
 *  no status and draw no icon. */
function statusIndex(log: ActionRecord[]): Map<string, ActionStatus> {
  const idx = new Map<string, ActionStatus>();
  for (const r of log) if (r.status) idx.set(actionSig(r.action, r.tick), r.status);
  return idx;
}

export function mountAiHistory(root: HTMLElement): { toggle: () => void } {
  let isOpen = false;
  let current = 'orchestrator';
  let tab: 'history' | 'config' | 'memory' = 'history';
  // Config View-Pretty sections longer than this (chars) render collapsed by
  // default, so the long ones (System, World, Voice) don't bury the rest.
  const COLLAPSE_THRESHOLD = 200;
  // Which collapsible parts the user has expanded, by label. Survives the
  // periodic config refetch (aiEvents) so re-rendering doesn't slam open
  // sections shut mid-read.
  const openParts = new Set<string>();
  // While the Config tab is open we poll the host for live backend status
  // (daemon up, resident models, host memory/CPU) — it changes with no player
  // action. Held so open/close/tab-switch can start & stop it.
  let statusTimer: number | undefined;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-ai" role="dialog" aria-label="AI History">
      <header class="modal-head">
        <h2 class="modal-title">AI</h2>
        <select class="ai-select" id="ai-select"></select>
        <span class="spacer"></span>
        <div class="ai-tabs" id="ai-tabs">
          <button class="ai-tab" data-tab="history">History</button>
          <button class="ai-tab" data-tab="memory">Memory</button>
          <button class="ai-tab" data-tab="config">Config</button>
        </div>
        <button class="icon-btn" id="ai-close" title="Close">✕</button>
      </header>
      <div class="modal-body" id="ai-body"></div>
    </div>`;
  root.appendChild(overlay);

  const select = overlay.querySelector<HTMLSelectElement>('#ai-select')!;
  const body = overlay.querySelector<HTMLElement>('#ai-body')!;
  const tabs = overlay.querySelector<HTMLElement>('#ai-tabs')!;

  // --- rendering ---------------------------------------------------------

  // The cold (fully-uncached) prompt-eval throughput, estimated as the FLOOR of
  // observed prompt tok/s across exchanges — the slowest call is the one that
  // re-evaluated the most, i.e. closest to no cache. We use it to back out, per
  // call, how many prompt tokens were actually re-processed (promptMs × coldRate)
  // vs. served instantly from KV cache. Ollama's prompt_eval_count is ALWAYS the
  // full prompt (measured), so it can't reveal cache hits on its own — throughput
  // is the real signal (a cached prefix costs ~0 time, so tok/s spikes).
  function coldPromptRate(): number {
    let min = Infinity;
    for (const x of aiData.get().exchanges) {
      const t = x.output.stats?.promptTokens;
      const ms = x.output.stats?.promptMs;
      if (t && ms && ms > 0) min = Math.min(min, (t / ms) * 1000);
    }
    return Number.isFinite(min) ? min : 0;
  }

  // What fraction of THIS prompt we EXPECT served from KV cache, derived purely
  // from what changed since the previous prompt for the SAME agent. The prompt's
  // sections are laid out least-changing-first (see assemble), so the cache holds
  // through every leading section that is byte-identical and breaks at the first
  // one that differs. That gives a precise target to check the measured hit
  // against: the point isn't the absolute number (~60% is normal and fine) — it's
  // whether reality matches what the diff says SHOULD be reusable. Returns the
  // expected hit % and the section where the prefix breaks (the first change), or
  // null with no prior prompt to diff. Char-length is a faithful proxy for the
  // token prefix and needs no tokenizer.
  function expectedCache(cur: AiExchange, prev: AiExchange | undefined): { pct: number; boundary: string } | null {
    if (!prev) return null;
    const parts = cur.input.parts;
    const prior = prev.input.parts;
    const total = parts.reduce((sum, p) => sum + p.content.length, 0) || 1;
    let cached = 0;
    let boundary = '(unchanged)'; // nothing differed — the whole prompt is reusable
    for (let i = 0; i < parts.length; i++) {
      const pp = prior[i];
      if (pp && pp.label === parts[i].label && pp.content === parts[i].content) {
        cached += parts[i].content.length;
      } else {
        boundary = parts[i].label;
        break;
      }
    }
    return { pct: Math.round((cached / total) * 100), boundary };
  }

  // A compact telemetry strip: tokens in/out with per-phase throughput, a KV
  // cache-hit estimate, and where the time went. Only reported fields are shown.
  // `expected` (when we have a prior prompt to diff) drives the cache chip's
  // color: it's flagged red only when the MEASURED hit falls well below what the
  // content diff predicts — i.e. the prefix was evicted for a reason other than
  // normal content churn (model swap, keep-alive expiry, host restart).
  function statsRow(s: AiStats | undefined, expected: { pct: number; boundary: string } | null): string {
    if (!s) return '';
    const chips: string[] = [];
    const inRate = s.promptTokens && s.promptMs ? Math.round((s.promptTokens / s.promptMs) * 1000) : undefined;

    if (s.promptTokens != null || s.outputTokens != null) {
      chips.push(`<span class="ai-chip"><b>${s.promptTokens ?? '?'}</b> in / <b>${s.outputTokens ?? '?'}</b> out tok</span>`);
    }
    // Cache-hit estimate: fraction of the prompt NOT re-evaluated this call.
    // reeval ≈ promptMs × coldRate; hit% = 1 − reeval/total. When we have an
    // expected target, color by the gap to it (a noisy estimate, so a generous
    // tolerance); otherwise fall back to absolute thresholds.
    if (s.promptTokens && s.promptMs != null) {
      const cold = coldPromptRate();
      if (cold > 0) {
        const reeval = Math.min(s.promptTokens, (s.promptMs / 1000) * cold);
        const hit = Math.max(0, Math.min(100, Math.round((1 - reeval / s.promptTokens) * 100)));
        // Measured share is throughput-derived and noisy; only a clear shortfall
        // vs. expectation signals a real cache-eviction problem.
        const TOL = 15;
        const cls = expected
          ? hit >= expected.pct - TOL
            ? 'ai-chip-ok'
            : 'ai-chip-bad'
          : hit >= 80
            ? 'ai-chip-ok'
            : hit >= 40
              ? 'ai-chip-warn'
              : 'ai-chip-bad';
        const title = expected
          ? `Estimated KV-cache share this call (~${hit}%) vs expected ~${expected.pct}% — the prompt is byte-identical to the previous one up to “${esc(expected.boundary)}”, where the first change begins. Far below expected ⇒ the cached prefix was evicted/reset (model swap, keep-alive expiry, host restart), not just normal content changes.`
          : 'Estimated share of the prompt served from KV cache (not re-evaluated). Low = the cached prefix was busted/evicted.';
        chips.push(`<span class="ai-chip ${cls}" title="${title}">~${hit}% cached</span>`);
        if (expected) {
          chips.push(
            `<span class="ai-chip ai-chip-exp" title="Expected KV-cache share: everything up to “${esc(expected.boundary)}” is byte-identical to the previous prompt, so the cache should hold through it and re-evaluate from there. This is the target the measured share should match.">exp ~${expected.pct}% @ ${esc(expected.boundary)}</span>`,
          );
        }
      }
    }
    if (inRate != null) chips.push(`<span class="ai-chip" title="Prompt-eval throughput. High (thousands) = cache hit; hundreds = cold re-eval.">prompt ${s.promptMs}ms · ${inRate.toLocaleString()} tok/s in</span>`);
    if (s.tokensPerSec != null) chips.push(`<span class="ai-chip">gen ${s.evalMs}ms · ${s.tokensPerSec} tok/s out</span>`);
    if (s.loadMs != null && s.loadMs > 0) chips.push(`<span class="ai-chip ai-chip-warn">load ${s.loadMs}ms</span>`);
    if (s.model) chips.push(`<span class="ai-chip ai-chip-model">${esc(s.model)}</span>`);
    if (s.doneReason && s.doneReason !== 'stop') chips.push(`<span class="ai-chip ai-chip-warn">${esc(s.doneReason)}</span>`);
    return chips.length ? `<div class="ai-stats">${chips.join('')}</div>` : '';
  }

  function exchangeCard(x: AiExchange, prev: AiExchange | undefined, status: Map<string, ActionStatus>): string {
    const acts = x.output.actions.length
      ? `<ul class="ai-acts">${x.output.actions
          .map(
            (a) =>
              `<li>${actionStatusMark(status.get(actionSig(a, x.tick)))}<span class="act-unit">${esc(unitShort(a.unitId))}</span>${esc(describeAction(a))}</li>`,
          )
          .join('')}</ul>`
      : `<div class="ai-none">no actions</div>`;
    const err = x.output.error ? `<div class="ai-err">${esc(x.output.error)}</div>` : '';
    const who = x.input.onBehalfOf ? esc(x.input.onBehalfOf) : 'auto';
    const said = x.output.msg
      ? `<div class="ai-said"><span class="ai-lbl">AI said</span><p>${esc(x.output.msg)}</p></div>`
      : '';
    // Only present when the model changed saved memory on this call. Show the
    // exact edit ops it committed (add/edit/del), not the whole list.
    const mem = x.output.memoryOps?.length
      ? `<div class="ai-mem"><span class="ai-lbl">🧠 memory updated</span>` +
        `<ul class="ai-acts">${x.output.memoryOps.map((o) => `<li>${opSummary(o)}</li>`).join('')}</ul>` +
        `</div>`
      : '';
    // View moves the model made on the submitter's behalf (setView) — camera
    // pans/zooms, distinct from world actions.
    const views = x.output.viewCommands?.length
      ? `<div class="ai-mem"><span class="ai-lbl">👁 moved view</span>` +
        `<ul class="ai-acts">${x.output.viewCommands.map((v) => `<li>${esc(describeView(v))}</li>`).join('')}</ul>` +
        `</div>`
      : '';
    // Non-fatal problems: items we had to reject (bad unit, out-of-bounds,
    // unknown recipe) or an un-parseable response. Amber, distinct from the hard
    // error block, so a partly-usable plan reads differently from a total fail.
    const warn = x.output.warnings?.length
      ? `<div class="ai-warn"><span class="ai-lbl">⚠️ dropped ${x.output.warnings.length}</span>` +
        `<ul class="ai-acts">${x.output.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` +
        `</div>`
      : '';
    return (
      `<div class="ai-xchg">` +
      `<div class="ai-xhead"><span class="ai-cmd">${esc(x.input.command)}</span>` +
      `<span class="ai-xmeta">${who} · t${x.tick} · ${x.ms}ms</span></div>` +
      statsRow(x.output.stats, expectedCache(x, prev)) +
      said +
      mem +
      views +
      warn +
      `<div class="ai-xcol"><span class="ai-lbl">Actions (${x.output.actions.length})</span>${acts}${err}</div>` +
      `<details class="ai-raw"><summary>model output</summary><pre>${esc(x.output.raw || '(empty)')}</pre></details>` +
      `<details class="ai-raw"><summary>prompt sent</summary><pre>${esc(x.input.raw)}</pre></details>` +
      `</div>`
    );
  }

  function renderHistory(exchanges: AiExchange[]): string {
    if (exchanges.length === 0) {
      return `<div class="ai-placeholder">No exchanges yet. Use the command bar to send the AI an instruction.</div>`;
    }
    // exchanges are oldest→newest; each card's cache baseline is the previous
    // exchange for the same agent (the list is already agent-scoped, but match
    // explicitly so a mixed list can't diff across agents). Build cards in order,
    // then reverse for newest-first display.
    const findPrev = (i: number): AiExchange | undefined => {
      for (let j = i - 1; j >= 0; j--) if (exchanges[j].agent === exchanges[i].agent) return exchanges[j];
      return undefined;
    };
    const status = statusIndex(actionLog.get());
    const cards = exchanges.map((x, i) => exchangeCard(x, findPrev(i), status));
    return `<div class="ai-list">${cards.reverse().join('')}</div>`;
  }

  // chars→tokens: calibrate against the most recent real exchange (its verbatim
  // prompt length vs the daemon's reported promptTokens) so the estimate tracks
  // THIS model's tokenizer, which is denser than the generic ~4 chars/tok on
  // our coordinate-heavy prompts. Fall back to 4 when we've no exchange yet.
  function charsPerToken(): number {
    for (const x of [...aiData.get().exchanges].reverse()) {
      const chars = x.input.raw.length;
      const toks = x.output.stats?.promptTokens;
      if (chars > 0 && toks && toks > 0) return chars / toks;
    }
    return 4;
  }
  const sizeLabel = (chars: number, cpt: number): string =>
    `${chars.toLocaleString()} chars · ~${Math.round(chars / cpt).toLocaleString()} tok`;

  function renderConfig(config: AiConfigView | undefined): string {
    if (!config) return `<div class="ai-placeholder">Loading config…</div>`;
    const cpt = charsPerToken();
    const target = templateCacheTarget(config.parts);
    const targetChip = target
      ? `<span class="ai-chip ai-chip-exp" title="Expected KV-cache share in the steady state: everything before “${esc(target.boundary)}” (the stable + occasional sections) stays byte-identical between calls, so the cache should hold through it and re-evaluate from “${esc(target.boundary)}” onward. Compare against the measured “~X% cached” on the History tab.">expect ~${target.pct}% cached</span>`
      : '';
    const toggle =
      `<div class="ai-cfg-toggle">` +
      `<span class="ai-cfg-size" title="Total prompt size. Token estimate calibrated to the model's own tokenizer from recent exchanges.">${sizeLabel(config.raw.length, cpt)}</span>` +
      targetChip +
      `<span class="ai-model">model: ${esc(config.model)}</span>` +
      `</div>`;
    const voice = voiceCard(config);
    const settings = settingsCard(config);
    // Live backend status, right under the picker it relates to. The body is
    // filled now and repainted in place by the poll (paintStatus).
    const runtime =
      `<section class="ai-settings ai-runtime"><h3>Runtime</h3>` +
      `<div class="ai-runtime-body" id="ai-status">${statusCard(aiStatus.get().status)}</div></section>`;
    const content = `<div class="ai-cfg-parts">${config.parts.map((p) => partSection(p, cpt)).join('')}</div>`;
    // Request settings first — they're model-specific, and the model picker
    // lives here — then the live runtime card. Voice below: personas are common
    // across models.
    return toggle + settings + runtime + voice + content;
  }

  // The KV-cache badge for a section, from its volatility tier. It tells the
  // reader, at a glance, whether this section is part of the reliably-cached
  // prefix (✓), usually cached (~), or re-evaluated most turns (✗) — the same
  // tiers the expected-cache target is built from. Empty when a section has no
  // tier (older payloads).
  const KV_BADGE: Record<NonNullable<AiPromptPart['volatility']>, { cls: string; sym: string; title: string }> = {
    stable: {
      cls: 'ai-kv-stable',
      sym: '✓ KV',
      title: 'Stable prefix — byte-identical every call, so it stays in the KV cache and is never re-evaluated.',
    },
    occasional: {
      cls: 'ai-kv-occasional',
      sym: '~ KV',
      title: 'Usually cached — re-evaluated only when this section changes (a memory edit or a roster change).',
    },
    live: {
      cls: 'ai-kv-live',
      sym: '✗',
      title: 'Changes most turns (world snapshot / views / conversation / command) — re-evaluated, not served from cache.',
    },
  };
  function kvBadge(v: AiPromptPart['volatility']): string {
    if (!v) return '';
    const b = KV_BADGE[v];
    return `<span class="ai-kv ${b.cls}" title="${b.title}">${b.sym}</span>`;
  }

  // The steady-state expected cache share for the current template: the stable +
  // occasional sections are byte-identical between typical calls, so the cache
  // holds through them and re-evaluates from the first 'live' section onward.
  // That boundary (usually "World context") and the % before it are the target
  // the History tab's measured "~X% cached" should match. Null if no live section
  // (nothing would ever re-evaluate — shouldn't happen).
  function templateCacheTarget(parts: AiPromptPart[]): { pct: number; boundary: string } | null {
    const total = parts.reduce((sum, p) => sum + p.content.length, 0) || 1;
    let cached = 0;
    for (const p of parts) {
      if (p.volatility === 'live') return { pct: Math.round((cached / total) * 100), boundary: p.label };
      cached += p.content.length;
    }
    return null;
  }

  // One prompt section in the Config view. Short sections stay as plain, always-
  // visible cards; sections over COLLAPSE_THRESHOLD chars become a <details> so
  // the big ones (System, World, Voice) can be folded away. The open/closed
  // state is driven by openParts (see the 'toggle' listener) so a background
  // refetch doesn't reset what the reader has expanded.
  function partSection(p: AiPromptPart, cpt: number): string {
    const meta = `${kvBadge(p.volatility)}<span class="ai-part-size">${sizeLabel(p.content.length, cpt)}</span>`;
    const pre = `<pre>${esc(p.content)}</pre>`;
    if (p.content.length <= COLLAPSE_THRESHOLD) {
      return `<section class="ai-part"><h3>${esc(p.label)}${meta}</h3>${pre}</section>`;
    }
    const open = openParts.has(p.label) ? ' open' : '';
    return (
      `<details class="ai-part ai-part-fold" data-part="${esc(p.label)}"${open}>` +
      `<summary><span class="ai-part-label">${esc(p.label)}</span>${meta}</summary>${pre}</details>`
    );
  }

  // The Voice picker: a button per style (plus "Off"), with the active one
  // highlighted. Clicking sends the switch to the host, which flips it colony-
  // wide, persists it, and broadcasts back — so the "Voice" part below (in View
  // Pretty) updates to show EXACTLY what the chosen persona adds to the prompt
  // (or vanishes when Off). This is what makes styles A/B-able at a glance.
  function voiceCard(config: AiConfigView): string {
    const btns = config.voices
      .map(
        (v) =>
          `<button class="seg ai-voice-btn ${v.id === config.voice ? 'active' : ''}" ` +
          `data-voice="${esc(v.id)}">${esc(v.label)}</button>`,
      )
      .join('');
    return (
      `<section class="ai-voice"><div class="ai-voice-head"><h3>Voice</h3>` +
      `<span class="ai-voice-sub">the persona the AI's chat replies use — pick one or turn it Off; ` +
      `the change applies to the live prompt (see the Voice section below).</span></div>` +
      `<div class="ai-voice-btns">${btns}</div></section>`
    );
  }

  // The tuning knobs the host actually sends per call — model, keep-alive, and
  // the verbatim options object (temperature today, more later).
  function settingsCard(config: AiConfigView): string {
    const s = config.settings;
    // Thinking gets a "!" note: it's off for speed, and if it's ever turned
    // back on we'll need to capture message.thinking to actually show it.
    const thinkNote = s.think
      ? ''
      : `<span class="ai-note" title="Thinking is disabled for speed (this model reasons on every call otherwise, ~28× slower). If re-enabled, capture the response's thinking text to display the model's reasoning here.">!</span>`;
    // The model row is a picker when the daemon reported >1 installed model;
    // otherwise it's static (nothing to switch to). Guarantee the active model
    // is always an option even if it somehow isn't in the reported list. The
    // dropdown only STAGES a choice — browsing it doesn't switch the model; the
    // explicit "Switch" button does. So a player can peruse what's installed
    // without kicking off a load, and gets clear feedback (the Runtime card)
    // when the pick actually boots. The button starts on the active model
    // (disabled) and enables the moment a different tag is staged.
    const tags = config.models.includes(s.model) ? config.models : [s.model, ...config.models];
    const modelRow =
      tags.length > 1
        ? `<div class="ai-set"><span>model</span><div class="ai-model-pick">` +
          `<select class="ai-model-select" data-model-stage title="Preview an installed model. Browsing doesn't switch — press Switch to make it active.">` +
          tags
            .map((m) => `<option value="${esc(m)}"${m === s.model ? ' selected' : ''}>${esc(m)}</option>`)
            .join('') +
          `</select>` +
          `<button class="seg ai-model-switch" data-model-switch disabled title="Load the staged model and make it active colony-wide (persisted).">Active</button>` +
          `</div></div>`
        : `<div class="ai-set"><span>model</span><code>${esc(s.model)}</code></div>`;
    const rows: string[] = [
      modelRow,
      `<div class="ai-set"><span>keep-alive</span><code>${esc(s.keepAlive)}</code></div>`,
      `<div class="ai-set"><span>thinking</span><code>${s.think ? 'on' : 'off'}${thinkNote}</code></div>`,
    ];
    for (const [k, v] of Object.entries(s.options)) {
      rows.push(`<div class="ai-set"><span>${esc(k)}</span><code>${esc(String(v))}</code></div>`);
    }
    return `<section class="ai-settings"><h3>Request settings</h3><div class="ai-set-grid">${rows.join('')}</div></section>`;
  }

  // MB → a compact size, rolling up to GB past 1024 so a multi-gig model reads
  // "5.6 GB", not "5734 MB".
  const fmtMB = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
  // Keep-alive countdown: minutes past a minute, else seconds.
  const fmtDur = (sec: number): string => (sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`);
  const usageClass = (pct: number): string => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok');

  // The Runtime card body: whether the daemon's up, whether the ACTIVE model is
  // actually resident (vs. still warming or evicted), the full `ollama ps` set
  // (so a stray second resident model — the usual memory-pressure culprit — is
  // visible), and the host's memory/CPU. Rendered into #ai-status and patched in
  // place on each poll, so it stays live without rebuilding the model picker.
  function statusCard(st: AiRuntimeStatus | undefined): string {
    if (!st) return `<div class="ai-none">Checking backend…</div>`;
    const dot = (cls: string, label: string, title = ''): string =>
      `<span class="ai-dot ai-dot-${cls}"></span><span${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;

    const daemon = st.daemonUp
      ? dot('up', 'Ollama running')
      : dot('down', 'Ollama not reachable', 'Start it with `ollama serve`.');

    let activeState: string;
    if (!st.daemonUp) activeState = dot('down', 'offline');
    else if (st.warming) activeState = dot('warm', 'loading…', 'Warming the model into memory.');
    else if (st.activeLoaded) activeState = dot('up', 'resident', 'Loaded in memory — ready.');
    else activeState = dot('idle', 'not loaded', 'Installed but not in memory; the next command loads it.');

    const loaded = st.loaded.length
      ? `<ul class="ai-loaded">${st.loaded
          .map((m) => {
            const mem =
              m.vramMB != null
                ? `${fmtMB(m.vramMB)} VRAM`
                : m.sizeMB != null
                  ? fmtMB(m.sizeMB)
                  : '';
            const exp = m.expiresInSec != null ? ` · ${fmtDur(m.expiresInSec)} left` : '';
            const active = m.name === st.activeModel ? ' ai-loaded-active' : '';
            return (
              `<li class="ai-loaded-row${active}"><span class="ai-loaded-name">${esc(m.name)}</span>` +
              `<span class="ai-loaded-meta">${esc(mem)}${esc(exp)}</span></li>`
            );
          })
          .join('')}</ul>`
      : `<div class="ai-none">no models resident</div>`;

    const h = st.host;
    const memPct = h.memTotalMB > 0 ? Math.round((h.memUsedMB / h.memTotalMB) * 100) : 0;
    const resBar = (label: string, pct: number, val: string): string =>
      `<div class="ai-res-row"><span class="ai-res-lbl">${label}</span>` +
      `<div class="res-bar"><div class="res-fill res-${usageClass(pct)}" style="width:${Math.min(100, pct)}%"></div></div>` +
      `<span class="ai-res-val">${esc(val)}</span></div>`;
    const host =
      `<div class="ai-res">` +
      resBar('memory', memPct, `${fmtMB(h.memUsedMB)} / ${fmtMB(h.memTotalMB)} · ${memPct}%`) +
      (h.cpuPct != null ? resBar('cpu', h.cpuPct, `${h.cpuPct}% · ${h.cores} cores`) : '') +
      `</div>`;

    return (
      `<div class="ai-rt-top"><span class="ai-rt-line">${daemon}</span>` +
      `<span class="ai-rt-line"><b class="ai-rt-model">${esc(st.activeModel)}</b> ${activeState}</span></div>` +
      `<div class="ai-rt-sub">Resident models · ollama ps</div>${loaded}` +
      `<div class="ai-rt-sub">Host</div>${host}`
    );
  }

  // Repaint just the Runtime card body (not the whole Config view) so a 2s
  // status poll never rebuilds the model picker under the player's cursor.
  function paintStatus(): void {
    if (!isOpen || tab !== 'config') return;
    const el = body.querySelector<HTMLElement>('#ai-status');
    if (el) el.innerHTML = statusCard(aiStatus.get().status);
  }

  // Start/stop the status poll to match "modal open AND on the Config tab".
  // Fires an immediate request on start so the card fills without a 2s wait.
  function syncStatusPoll(): void {
    const shouldPoll = isOpen && tab === 'config';
    if (shouldPoll && statusTimer === undefined) {
      sendAiStatusReq(current);
      statusTimer = window.setInterval(() => sendAiStatusReq(current), 2000);
    } else if (!shouldPoll && statusTimer !== undefined) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
  }

  // One memory edit op as a short, escaped, human-readable line. Reused by the
  // History card (what the model committed) and the Memory tab's change log.
  function opSummary(op: MemoryOp): string {
    if (op.op === 'add') return `+ add “${esc(op.text)}”`;
    if (op.op === 'edit') return `~ edit #${op.id} → “${esc(op.text)}”`;
    return `− delete #${op.id}`;
  }

  // One entry in the change log: which revision, who caused it, at what tick,
  // and the exact ops it applied. The host stamps `by` as the literal 'AI' for
  // a model-driven change or a player's name for a manual Memory-tab edit, so we
  // render a distinct badge for each — an AI change and a change by a player who
  // happens to be reading shouldn't look the same.
  function revRow(r: MemoryRevision): string {
    const ops = r.ops
      .map((o) => `<li class="ai-mem-op ai-mem-op-${o.op}">${opSummary(o)}</li>`)
      .join('');
    const isAi = (r.by ?? 'AI') === 'AI';
    // AI changes are prompted by a player's command — show that player too so
    // it's clear the AI didn't act on its own.
    const via = isAi && r.via
      ? `<span class="ai-mem-via" title="Prompted by this player's command">via ${esc(r.via)}</span>`
      : '';
    const by = isAi
      ? `<span class="ai-mem-by ai-mem-by-ai" title="Changed by the AI on a command">🧠 AI</span>${via}`
      : `<span class="ai-mem-by ai-mem-by-player" title="Edited by hand in the Memory tab">✎ ${esc(r.by!)}</span>`;
    return (
      `<div class="ai-mem-rev">` +
      `<div class="ai-mem-rev-head"><span class="ai-mem-rev-n">rev ${r.rev}</span>` +
      `${by}<span class="ai-mem-rev-meta">t${r.tick}</span></div>` +
      `<ul class="ai-mem-ops">${ops}</ul></div>`
    );
  }

  // The Memory tab: the colony's current standing memory as an editable numbered
  // list (each line's number IS the id the model addresses it by), an add row,
  // and the append-only change history. Manual edits send the SAME add/edit/del
  // ops the model uses, so both paths funnel through the host's one applier.
  function renderMemory(memory: string[], log: MemoryRevision[]): string {
    const rows = memory.length
      ? memory
          .map((m, i) => {
            const id = i + 1;
            return (
              `<div class="ai-mem-row">` +
              `<span class="ai-mem-num">${id}</span>` +
              `<input class="ai-mem-input" data-mem-id="${id}" value="${esc(m)}" />` +
              `<button class="seg ai-mem-save" data-mem-save="${id}" title="Save this line">Save</button>` +
              `<button class="seg ai-mem-del" data-mem-del="${id}" title="Delete this line">✕</button>` +
              `</div>`
            );
          })
          .join('')
      : `<div class="ai-none">No standing memory yet.</div>`;
    const addRow =
      `<div class="ai-mem-row ai-mem-add">` +
      `<span class="ai-mem-num">+</span>` +
      `<input class="ai-mem-input" id="ai-mem-add-input" placeholder="Add a standing preference…" />` +
      `<button class="seg ai-mem-addbtn" data-mem-add title="Add this line">Add</button>` +
      `</div>`;
    const logRows = log.length
      ? [...log].reverse().map(revRow).join('')
      : `<div class="ai-none">No changes recorded yet.</div>`;
    return (
      `<div class="ai-memory">` +
      `<section class="ai-mem-current"><div class="ai-mem-head"><h3>Standing memory</h3>` +
      `<span class="ai-mem-sub">durable preferences the AI applies on every command. ` +
      `Edit them here, or let the AI update them as players state lasting preferences.</span></div>` +
      rows +
      addRow +
      `</section>` +
      `<section class="ai-mem-loghdr"><h3>Change history</h3>` +
      `<div class="ai-mem-log">${logRows}</div></section>` +
      `</div>`
    );
  }

  function render(): void {
    const data = aiData.get();

    // Keep the selector in sync with known agents.
    const agents = data.agents.length ? data.agents : [current];
    const opts = agents.map((a) => `<option value="${esc(a)}"${a === current ? ' selected' : ''}>${esc(a)}</option>`).join('');
    if (select.innerHTML !== opts) select.innerHTML = opts;
    select.value = current;

    tabs.querySelectorAll<HTMLElement>('.ai-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    if (tab === 'history') {
      body.innerHTML = renderHistory(data.exchanges);
    } else if (tab === 'config') {
      body.innerHTML = renderConfig(data.config);
    } else {
      // Memory: background refetches fire on every exchange (aiEvents). Don't
      // clobber a field the user is mid-edit — skip the re-render while a memory
      // input has focus; the next render (on blur/tab-switch) picks up fresh.
      const active = document.activeElement;
      if (body.contains(active) && active instanceof HTMLInputElement) return;
      body.innerHTML = renderMemory(data.memory, data.memoryLog);
    }
  }

  // --- open/close --------------------------------------------------------

  function open(): void {
    isOpen = true;
    overlay.hidden = false;
    openLayer('ai', close); // Esc closes the modal (top of the stack)
    setActive('ai');
    setUi({ ai: true }); // survive reload
    sendAiHistoryReq(current); // pull fresh history + config
    render();
    syncStatusPoll(); // start polling live backend status if on Config
  }
  function close(): void {
    isOpen = false;
    overlay.hidden = true;
    closeLayer('ai');
    setActive('map');
    setUi({ ai: false }); // survive reload
    syncStatusPoll(); // stop the status poll
  }
  function toggle(): void {
    isOpen ? close() : open();
  }

  // --- events ------------------------------------------------------------

  overlay.querySelector<HTMLButtonElement>('#ai-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(); // click backdrop
  });
  tabs.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.ai-tab');
    if (!btn) return;
    tab = btn.dataset.tab as 'history' | 'config' | 'memory';
    render();
    syncStatusPoll(); // poll only while the Config tab is showing
  });
  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Switch voice: fire-and-forget. The host echoes an aiEvent, which triggers
    // a refetch (below), so the picker + Voice part re-render from the new state.
    const voiceBtn = target.closest<HTMLElement>('[data-voice]');
    if (voiceBtn) {
      sendAiVoice(current, voiceBtn.dataset.voice!);
      return;
    }
    // Commit the staged model. The host validates it, warms it (which flips the
    // Runtime card to "loading…"), persists, and echoes an aiEvent → refetch →
    // the picker resets to the new active. Poll once right away so the load
    // state shows without waiting for the next 2s tick.
    const switchBtn = target.closest<HTMLButtonElement>('[data-model-switch]');
    if (switchBtn) {
      const sel = switchBtn.parentElement?.querySelector<HTMLSelectElement>('.ai-model-select');
      const active = aiData.get().config?.settings.model;
      if (sel && sel.value !== active) {
        sendAiModel(current, sel.value);
        switchBtn.disabled = true;
        switchBtn.textContent = 'Switching…';
        sendAiStatusReq(current);
      }
      return;
    }
    // Memory edits: each button sends one op. We blur first so the focus guard
    // in render() lets the host's echoed aiEvent refetch repaint the list.
    const saveBtn = target.closest<HTMLElement>('[data-mem-save]');
    if (saveBtn) {
      const id = Number(saveBtn.dataset.memSave);
      const input = body.querySelector<HTMLInputElement>(`.ai-mem-input[data-mem-id="${id}"]`);
      const text = input?.value.trim() ?? '';
      input?.blur();
      if (text) sendAiMemoryEdit(current, [{ op: 'edit', id, text }]);
      return;
    }
    const delBtn = target.closest<HTMLElement>('[data-mem-del]');
    if (delBtn) {
      sendAiMemoryEdit(current, [{ op: 'del', id: Number(delBtn.dataset.memDel) }]);
      return;
    }
    const addBtn = target.closest<HTMLElement>('[data-mem-add]');
    if (addBtn) {
      const input = body.querySelector<HTMLInputElement>('#ai-mem-add-input');
      const text = input?.value.trim() ?? '';
      if (text && input) {
        input.value = '';
        input.blur();
        sendAiMemoryEdit(current, [{ op: 'add', text }]);
      }
      return;
    }
  });
  // Enter in a memory field commits it (Save for an existing line, Add for the
  // new-line field), so editing feels like a normal text input.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target as HTMLElement;
    if (t.id === 'ai-mem-add-input') {
      e.preventDefault();
      body.querySelector<HTMLElement>('[data-mem-add]')?.click();
    } else if (t instanceof HTMLInputElement && t.dataset.memId) {
      e.preventDefault();
      body.querySelector<HTMLElement>(`[data-mem-save="${t.dataset.memId}"]`)?.click();
    }
  });
  // Staging the model picker: browsing the dropdown does NOT switch — it only
  // arms the Switch button. Enable it (and relabel) once the staged tag differs
  // from the active one, so the player can peruse installed models freely.
  body.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('.ai-model-select');
    if (!sel) return;
    const active = aiData.get().config?.settings.model;
    const btn = sel.parentElement?.querySelector<HTMLButtonElement>('.ai-model-switch');
    if (btn) {
      const changed = sel.value !== active;
      btn.disabled = !changed;
      btn.textContent = changed ? `Switch to ${sel.value}` : 'Active';
    }
  });
  // Remember which collapsible sections are expanded so a refetch re-render
  // keeps them open. `toggle` doesn't bubble, so listen in the capture phase.
  body.addEventListener(
    'toggle',
    (e) => {
      const d = e.target as HTMLElement;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('ai-part-fold')) return;
      const label = d.dataset.part!;
      if (d.open) openParts.add(label);
      else openParts.delete(label);
    },
    true,
  );
  select.addEventListener('change', () => {
    current = select.value;
    sendAiHistoryReq(current);
    syncStatusPoll(); // fetch status for the newly-selected agent immediately
  });
  // Re-render whenever data arrives; refetch when a live event hits our agent.
  aiData.subscribe(() => {
    if (isOpen) render();
  });
  // Live backend status: patch just the Runtime card in place (no full re-render,
  // so the model picker isn't rebuilt under the player's cursor mid-browse).
  aiStatus.subscribe(paintStatus);
  aiEvents.subscribe((ev) => {
    if (isOpen && ev.agent === current) sendAiHistoryReq(current);
  });

  return { toggle };
}
