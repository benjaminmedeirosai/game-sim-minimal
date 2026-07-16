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
import type { AiConfigView, AiExchange, AiStats } from '@game/shared';
import { aiData, aiEvents, sendAiHistoryReq } from '../net/client';
import { closeLayer, openLayer } from './escStack';
import { setActive } from '../state/activeSurface';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function mountAiHistory(root: HTMLElement): { toggle: () => void } {
  let isOpen = false;
  let current = 'orchestrator';
  let tab: 'history' | 'config' = 'history';
  let configMode: 'pretty' | 'raw' = 'pretty';

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

  // A compact telemetry strip: tokens in/out, generation speed, and where the
  // time went. Only the fields the backend reported are shown.
  function statsRow(s: AiStats | undefined): string {
    if (!s) return '';
    const chips: string[] = [];
    if (s.promptTokens != null || s.outputTokens != null) {
      chips.push(`<span class="ai-chip"><b>${s.promptTokens ?? '?'}</b> in / <b>${s.outputTokens ?? '?'}</b> out tok</span>`);
    }
    if (s.tokensPerSec != null) chips.push(`<span class="ai-chip">${s.tokensPerSec} tok/s</span>`);
    if (s.loadMs != null && s.loadMs > 0) chips.push(`<span class="ai-chip">load ${s.loadMs}ms</span>`);
    if (s.promptMs != null) chips.push(`<span class="ai-chip">prompt ${s.promptMs}ms</span>`);
    if (s.evalMs != null) chips.push(`<span class="ai-chip">gen ${s.evalMs}ms</span>`);
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
    return (
      `<div class="ai-xchg">` +
      `<div class="ai-xhead"><span class="ai-cmd">${esc(x.input.command)}</span>` +
      `<span class="ai-xmeta">${who} · t${x.tick} · ${x.ms}ms</span></div>` +
      statsRow(x.output.stats) +
      said +
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

  function renderConfig(config: AiConfigView | undefined): string {
    if (!config) return `<div class="ai-placeholder">Loading config…</div>`;
    const toggle =
      `<div class="ai-cfg-toggle">` +
      `<button class="seg ${configMode === 'pretty' ? 'active' : ''}" data-cfg="pretty">View Pretty</button>` +
      `<button class="seg ${configMode === 'raw' ? 'active' : ''}" data-cfg="raw">View Raw</button>` +
      `<span class="ai-model">model: ${esc(config.model)}</span>` +
      `</div>`;
    const settings = settingsCard(config);
    const content =
      configMode === 'raw'
        ? `<pre class="ai-cfg-raw">${esc(config.raw)}</pre>`
        : `<div class="ai-cfg-parts">${config.parts
            .map(
              (p) =>
                `<section class="ai-part"><h3>${esc(p.label)}</h3><pre>${esc(p.content)}</pre></section>`,
            )
            .join('')}</div>`;
    return toggle + settings + content;
  }

  // The tuning knobs the host actually sends per call — model, keep-alive, and
  // the verbatim options object (temperature today, more later).
  function settingsCard(config: AiConfigView): string {
    const s = config.settings;
    const rows: string[] = [
      `<div class="ai-set"><span>model</span><code>${esc(s.model)}</code></div>`,
      `<div class="ai-set"><span>keep-alive</span><code>${esc(s.keepAlive)}</code></div>`,
    ];
    for (const [k, v] of Object.entries(s.options)) {
      rows.push(`<div class="ai-set"><span>${esc(k)}</span><code>${esc(String(v))}</code></div>`);
    }
    return `<section class="ai-settings"><h3>Request settings</h3><div class="ai-set-grid">${rows.join('')}</div></section>`;
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

    body.innerHTML = tab === 'history' ? renderHistory(data.exchanges) : renderConfig(data.config);
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
    tab = btn.dataset.tab as 'history' | 'config';
    render();
  });
  body.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cfg]');
    if (!btn) return;
    configMode = btn.dataset.cfg as 'pretty' | 'raw';
    render();
  });
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
