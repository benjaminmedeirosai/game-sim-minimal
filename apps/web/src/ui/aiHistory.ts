// The AI History window — a large (≈80%×80%) modal for auditing the AI. Two
// tabs:
//   History — every request/response for the selected agent (command, the
//             actions it produced, latency, and the verbatim model output).
//   Config  — exactly what we send the model, as raw text (View Raw) or split
//             into friendly sections (View Pretty).
// An agent selector switches which agent you're inspecting (one today, more
// later). Data comes from the host on demand via { m: 'aiHistoryReq' }, and an
// open window refetches when the host reports a new exchange (aiEvents).
import { describeAction } from '@game/shared';
import type {
  AiConfigView,
  AiExchange,
  AiPromptPart,
  AiStats,
  MemoryOp,
  MemoryRevision,
} from '@game/shared';
import {
  aiData,
  aiEvents,
  sendAiHistoryReq,
  sendAiMemoryEdit,
  sendAiModel,
  sendAiVoice,
} from '../net/client';
import { closeLayer, openLayer } from './escStack';
import { setActive } from '../state/activeSurface';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function mountAiHistory(root: HTMLElement): { toggle: () => void } {
  let isOpen = false;
  let current = 'orchestrator';
  let tab: 'history' | 'config' | 'memory' = 'history';
  let configMode: 'pretty' | 'raw' = 'pretty';
  // Config View-Pretty sections longer than this (chars) render collapsed by
  // default, so the long ones (System, World, Voice) don't bury the rest.
  const COLLAPSE_THRESHOLD = 200;
  // Which collapsible parts the user has expanded, by label. Survives the
  // periodic config refetch (aiEvents) so re-rendering doesn't slam open
  // sections shut mid-read.
  const openParts = new Set<string>();

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

  // A compact telemetry strip: tokens in/out with per-phase throughput, a KV
  // cache-hit estimate, and where the time went. Only reported fields are shown.
  function statsRow(s: AiStats | undefined): string {
    if (!s) return '';
    const chips: string[] = [];
    const inRate = s.promptTokens && s.promptMs ? Math.round((s.promptTokens / s.promptMs) * 1000) : undefined;

    if (s.promptTokens != null || s.outputTokens != null) {
      chips.push(`<span class="ai-chip"><b>${s.promptTokens ?? '?'}</b> in / <b>${s.outputTokens ?? '?'}</b> out tok</span>`);
    }
    // Cache-hit estimate: fraction of the prompt NOT re-evaluated this call.
    // reeval ≈ promptMs × coldRate; hit% = 1 − reeval/total. A green/amber/red
    // class flags healthy reuse vs. an evicted/busted prefix at a glance.
    if (s.promptTokens && s.promptMs != null) {
      const cold = coldPromptRate();
      if (cold > 0) {
        const reeval = Math.min(s.promptTokens, (s.promptMs / 1000) * cold);
        const hit = Math.max(0, Math.min(100, Math.round((1 - reeval / s.promptTokens) * 100)));
        const cls = hit >= 80 ? 'ai-chip-ok' : hit >= 40 ? 'ai-chip-warn' : 'ai-chip-bad';
        chips.push(`<span class="ai-chip ${cls}" title="Estimated share of the prompt served from KV cache (not re-evaluated). Low = the cached prefix was busted/evicted.">~${hit}% cached</span>`);
      }
    }
    if (inRate != null) chips.push(`<span class="ai-chip" title="Prompt-eval throughput. High (thousands) = cache hit; hundreds = cold re-eval.">prompt ${s.promptMs}ms · ${inRate.toLocaleString()} tok/s in</span>`);
    if (s.tokensPerSec != null) chips.push(`<span class="ai-chip">gen ${s.evalMs}ms · ${s.tokensPerSec} tok/s out</span>`);
    if (s.loadMs != null && s.loadMs > 0) chips.push(`<span class="ai-chip ai-chip-warn">load ${s.loadMs}ms</span>`);
    if (s.model) chips.push(`<span class="ai-chip ai-chip-model">${esc(s.model)}</span>`);
    if (s.doneReason && s.doneReason !== 'stop') chips.push(`<span class="ai-chip ai-chip-warn">${esc(s.doneReason)}</span>`);
    return chips.length ? `<div class="ai-stats">${chips.join('')}</div>` : '';
  }

  function exchangeCard(x: AiExchange): string {
    const acts = x.output.actions.length
      ? `<ul class="ai-acts">${x.output.actions.map((a) => `<li>${esc(describeAction(a))}</li>`).join('')}</ul>`
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
    return (
      `<div class="ai-xchg">` +
      `<div class="ai-xhead"><span class="ai-cmd">${esc(x.input.command)}</span>` +
      `<span class="ai-xmeta">${who} · t${x.tick} · ${x.ms}ms</span></div>` +
      statsRow(x.output.stats) +
      said +
      mem +
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
    return `<div class="ai-list">${[...exchanges].reverse().map(exchangeCard).join('')}</div>`;
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
    const toggle =
      `<div class="ai-cfg-toggle">` +
      `<button class="seg ${configMode === 'pretty' ? 'active' : ''}" data-cfg="pretty">View Pretty</button>` +
      `<button class="seg ${configMode === 'raw' ? 'active' : ''}" data-cfg="raw">View Raw</button>` +
      `<span class="ai-cfg-size" title="Total prompt size. Token estimate calibrated to the model's own tokenizer from recent exchanges.">${sizeLabel(config.raw.length, cpt)}</span>` +
      `<span class="ai-model">model: ${esc(config.model)}</span>` +
      `</div>`;
    const voice = voiceCard(config);
    const settings = settingsCard(config);
    const content =
      configMode === 'raw'
        ? `<pre class="ai-cfg-raw">${esc(config.raw)}</pre>`
        : `<div class="ai-cfg-parts">${config.parts.map((p) => partSection(p, cpt)).join('')}</div>`;
    // Request settings first — they're model-specific, and the model picker
    // lives here. Voice below: the personas are common across models.
    return toggle + settings + voice + content;
  }

  // One prompt section in View Pretty. Short sections stay as plain, always-
  // visible cards; sections over COLLAPSE_THRESHOLD chars become a <details> so
  // the big ones (System, World, Voice) can be folded away. The open/closed
  // state is driven by openParts (see the 'toggle' listener) so a background
  // refetch doesn't reset what the reader has expanded.
  function partSection(p: AiPromptPart, cpt: number): string {
    const size = `<span class="ai-part-size">${sizeLabel(p.content.length, cpt)}</span>`;
    const pre = `<pre>${esc(p.content)}</pre>`;
    if (p.content.length <= COLLAPSE_THRESHOLD) {
      return `<section class="ai-part"><h3>${esc(p.label)}${size}</h3>${pre}</section>`;
    }
    const open = openParts.has(p.label) ? ' open' : '';
    return (
      `<details class="ai-part ai-part-fold" data-part="${esc(p.label)}"${open}>` +
      `<summary><span class="ai-part-label">${esc(p.label)}</span>${size}</summary>${pre}</details>`
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
    // The model row is a live picker when the daemon reported >1 installed
    // model; otherwise it's static (nothing to switch to). Guarantee the active
    // model is always an option even if it somehow isn't in the reported list.
    const tags = config.models.includes(s.model) ? config.models : [s.model, ...config.models];
    const modelRow =
      tags.length > 1
        ? `<div class="ai-set"><span>model</span>` +
          `<select class="ai-model-select" data-model title="Switch the model the AI runs on (must be installed on your Ollama). Colony-wide + persisted; the host warms it for the next command.">` +
          tags
            .map((m) => `<option value="${esc(m)}"${m === s.model ? ' selected' : ''}>${esc(m)}</option>`)
            .join('') +
          `</select></div>`
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
    sendAiHistoryReq(current); // pull fresh history + config
    render();
  }
  function close(): void {
    isOpen = false;
    overlay.hidden = true;
    closeLayer('ai');
    setActive('map');
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
  });
  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cfgBtn = target.closest<HTMLElement>('[data-cfg]');
    if (cfgBtn) {
      configMode = cfgBtn.dataset.cfg as 'pretty' | 'raw';
      render();
      return;
    }
    // Switch voice: fire-and-forget. The host echoes an aiEvent, which triggers
    // a refetch (below), so the picker + Voice part re-render from the new state.
    const voiceBtn = target.closest<HTMLElement>('[data-voice]');
    if (voiceBtn) {
      sendAiVoice(current, voiceBtn.dataset.voice!);
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
  // Switch the model: fire-and-forget, like voice. The host validates the tag
  // against the daemon, warms it, persists, and echoes an aiEvent → refetch →
  // the picker re-renders from the new state.
  body.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('.ai-model-select');
    if (sel) sendAiModel(current, sel.value);
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
  });
  // Re-render whenever data arrives; refetch when a live event hits our agent.
  aiData.subscribe(() => {
    if (isOpen) render();
  });
  aiEvents.subscribe((ev) => {
    if (isOpen && ev.agent === current) sendAiHistoryReq(current);
  });

  return { toggle };
}
