import type { TickStatsSnapshot } from '@game/shared';
import { game } from '../state/game';
import { clientPerf } from '../state/clientPerf';
import type { ClientPerfState } from '../state/clientPerf';

/** Perf HUD: server-side tick timing + throughput (so we can watch how close
 *  ticks are to their budget) plus a client-side section (this browser's frame
 *  rate, snapshot intake, and heap). */
export function mountHud(el: HTMLElement): void {
  const rerender = (): void => {
    const s = game.get();
    const server = s.stats
      ? render(s.stats, s.tick)
      : '<h2>Performance</h2><p class="hint">Waiting for host stats…</p>';
    el.innerHTML = server + renderClient(clientPerf.get());
  };
  game.subscribe(rerender);
  clientPerf.subscribe(rerender);
}

function renderClient(cp: ClientPerfState): string {
  const rows: [string, string][] = [
    ['fps', round(cp.fps).toString()],
    ['snapshots', `${round(cp.snapshotsPerSec)} /s`],
    ['heap', cp.heapMB !== undefined ? `${round(cp.heapMB)} MB` : 'n/a'],
  ];
  return `
    <h2 class="mt">Client</h2>
    <div class="hud-grid">
      ${rows.map(([k, v]) => `<div class="hud-k">${k}</div><div class="hud-v">${v}</div>`).join('')}
    </div>`;
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
