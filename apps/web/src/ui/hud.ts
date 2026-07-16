import type { TickStatsSnapshot } from '@game/shared';
import { game } from '../state/game';
import { clientPerf } from '../state/clientPerf';
import type { ClientPerfState } from '../state/clientPerf';

/** Perf HUD, three sections: the host's tick timing (Performance), this
 *  browser's own health (Client: frame rate + heap), and the host→client
 *  transport (Network: snapshot intake, payload size, wire rate, latency). */
export function mountHud(el: HTMLElement): void {
  const rerender = (): void => {
    const s = game.get();
    const server = s.stats
      ? render(s.stats, s.tick)
      : '<h2>Performance</h2><p class="hint">Waiting for host stats…</p>';
    const cp = clientPerf.get();
    el.innerHTML = server + renderClient(cp) + renderNetwork(cp);
  };
  game.subscribe(rerender);
  clientPerf.subscribe(rerender);
}

function grid(rows: [string, string][]): string {
  return `<div class="hud-grid">${rows
    .map(([k, v]) => `<div class="hud-k">${k}</div><div class="hud-v">${v}</div>`)
    .join('')}</div>`;
}

// The 60fps frame budget: rAF caps fps here, so a redraw's ms vs this number is
// the real headroom signal. Peak past ~70% of it means redraws risk dropping
// frames on a slower window.
const FRAME_BUDGET_MS = 1000 / 60;

function renderClient(cp: ClientPerfState): string {
  const near = cp.drawMsPeak !== undefined && cp.drawMsPeak > FRAME_BUDGET_MS * 0.7;
  const rows: [string, string, boolean?][] = [
    ['fps', round(cp.fps).toString()],
    ['heap', cp.heapMB !== undefined ? `${round(cp.heapMB)} MB` : 'n/a'],
    ['draw budget', `${round(FRAME_BUDGET_MS)} ms`],
    ['draw avg', cp.drawMsAvg !== undefined ? `${round(cp.drawMsAvg)} ms` : 'n/a'],
    ['draw peak', cp.drawMsPeak !== undefined ? `${round(cp.drawMsPeak)} ms` : 'n/a', near],
  ];
  return `<h2 class="mt">Client</h2><div class="hud-grid">${rows
    .map(
      ([k, v, warn]) =>
        `<div class="hud-k">${k}</div><div class="hud-v${warn ? ' warn' : ''}">${v}</div>`,
    )
    .join('')}</div>`;
}

function renderNetwork(cp: ClientPerfState): string {
  const rows: [string, string][] = [
    ['latency (rtt)', cp.latencyMS !== undefined ? `${round(cp.latencyMS)} ms` : 'n/a'],
    ['snapshots', `${round(cp.snapshotsPerSec)} /s`],
    ['snapshot size', cp.snapshotKB !== undefined ? `${round(cp.snapshotKB)} KB` : 'n/a'],
    ['wire (uncompressed)', cp.wireKBps !== undefined ? `${round(cp.wireKBps)} KB/s` : 'n/a'],
  ];
  return `<h2 class="mt">Network</h2>${grid(rows)}`;
}

function render(st: TickStatsSnapshot, tick: number): string {
  const budgetMs = st.targetTps > 0 ? 1000 / st.targetTps : 0;
  const overBudget = st.overruns > 0;
  const rows: [string, string][] = [
    ['tick', tick.toLocaleString()],
    ['target', `${round(st.targetTps)} tps`],
    ['actual', `${round(st.actualTps)} tps`],
    ['budget', budgetMs ? `${round(budgetMs)} ms` : '—'],
    ['last', `${round(st.last)} ms`],
    ['avg', `${round(st.avg)} ms`],
    ['max', `${round(st.max)} ms`],
    ['p95', `${round(st.p95)} ms`],
    ['overruns', String(st.overruns)],
  ];

  return `
    <h2>Performance</h2>
    <div class="hud-grid">
      ${rows
        .map(
          ([k, v]) =>
            `<div class="hud-k">${k}</div><div class="hud-v${
              k === 'overruns' && overBudget ? ' warn' : ''
            }">${v}</div>`,
        )
        .join('')}
    </div>
    ${sparkline(st.samples, budgetMs)}`;
}

function sparkline(samples: number[], budgetMs: number): string {
  if (samples.length < 2) return '';
  const w = 200;
  const h = 40;
  const max = Math.max(budgetMs, ...samples) * 1.1 || 1;
  const step = w / (samples.length - 1);
  const pts = samples.map((v, i) => `${round2(i * step)},${round2(h - (v / max) * h)}`).join(' ');
  const budgetY = round2(h - (budgetMs / max) * h);
  return `
    <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${budgetMs ? `<line x1="0" y1="${budgetY}" x2="${w}" y2="${budgetY}" class="spark-budget"/>` : ''}
      <polyline points="${pts}" class="spark-line"/>
    </svg>
    <p class="hint">line = tick ms · dashed = budget</p>`;
}

const round = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
