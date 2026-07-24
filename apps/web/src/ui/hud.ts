import { game } from '../state/game';
import { clientPerf } from '../state/clientPerf';

// The panel deliberately polls while it is open instead of subscribing to the
// snapshot store. Snapshots arrive about ten times per second, while these
// diagnostic numbers only need a one-second cadence.
const FRAME_BUDGET_MS = 1000 / 60;

const serverRows = [
  ['tick', 'tick'], ['target', 'target'], ['actual', 'actual'], ['budget', 'budget'],
  ['last', 'last'], ['avg', 'avg'], ['max', 'max'], ['p95', 'p95'], ['overruns', 'overruns'],
] as const;
const clientRows = [
  ['fps', 'fps'], ['heap', 'heap'], ['draw budget', 'draw-budget'], ['draw avg', 'draw-avg'], ['draw peak', 'draw-peak'],
] as const;
const networkRows = [
  ['latency (rtt)', 'latency'], ['snapshots', 'snapshots'], ['snapshot (raw)', 'snapshot-raw'],
  ['snapshot (wire)', 'snapshot-wire'], ['compression', 'compression'], ['chunks / snapshot', 'chunks'],
  ['wire (raw)', 'wire-raw'], ['wire (actual)', 'wire-actual'],
] as const;

const staticGrid = (rows: readonly (readonly [string, string])[]): string =>
  `<div class="hud-grid">${rows.map(([label, key]) =>
    `<div class="hud-k">${label}</div><div class="hud-v" data-hud="${key}">—</div>`).join('')}</div>`;

/** Perf HUD: static labels, value-only writes, and a 1 Hz refresh while open. */
export function mountHud(el: HTMLElement): void {
  el.innerHTML = `
    <h2>Performance</h2>
    ${staticGrid(serverRows)}
    <svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none">
      <line data-hud="budget-line" x1="0" x2="200" class="spark-budget"/>
      <polyline data-hud="spark-line" class="spark-line"/>
    </svg>
    <p class="hint">line = tick ms · dashed = budget</p>
    <h2 class="mt">Client</h2>${staticGrid(clientRows)}
    <h2 class="mt">Network</h2>${staticGrid(networkRows)}`;

  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = (): void => {
    const state = game.get();
    const stats = state.stats;
    const cp = clientPerf.get();
    const budget = stats && stats.targetTps > 0 ? 1000 / stats.targetTps : 0;
    setValue(el, 'tick', stats ? state.tick.toLocaleString() : '—');
    setValue(el, 'target', stats ? `${round(stats.targetTps)} tps` : '—');
    setValue(el, 'actual', stats ? `${round(stats.actualTps)} tps` : '—');
    setValue(el, 'budget', budget ? `${round(budget)} ms` : '—');
    setValue(el, 'last', stats ? `${round(stats.last)} ms` : '—');
    setValue(el, 'avg', stats ? `${round(stats.avg)} ms` : '—');
    setValue(el, 'max', stats ? `${round(stats.max)} ms` : '—');
    setValue(el, 'p95', stats ? `${round(stats.p95)} ms` : '—');
    setValue(el, 'overruns', stats ? String(stats.overruns) : '—', Boolean(stats?.overruns));
    setValue(el, 'fps', String(round(cp.fps)));
    setValue(el, 'heap', cp.heapMB === undefined ? 'n/a' : `${round(cp.heapMB)} MB`);
    setValue(el, 'draw-budget', `${round(FRAME_BUDGET_MS)} ms`);
    const nearBudget = cp.drawMsPeak !== undefined && cp.drawMsPeak > FRAME_BUDGET_MS * 0.7;
    setValue(el, 'draw-avg', cp.drawMsAvg === undefined ? 'n/a' : `${round(cp.drawMsAvg)} ms`);
    setValue(el, 'draw-peak', cp.drawMsPeak === undefined ? 'n/a' : `${round(cp.drawMsPeak)} ms`, nearBudget);
    setValue(el, 'latency', cp.latencyMS === undefined ? 'n/a' : `${round(cp.latencyMS)} ms`);
    setValue(el, 'snapshots', `${round(cp.snapshotsPerSec)} /s`);
    setValue(el, 'snapshot-raw', cp.snapshotKB === undefined ? 'n/a' : `${round(cp.snapshotKB)} KB`);
    setValue(el, 'snapshot-wire', cp.snapshotWireKB === undefined ? 'n/a' : `${round(cp.snapshotWireKB)} KB`);
    setValue(el, 'compression', cp.compressRatio === undefined ? 'n/a' : `×${round(cp.compressRatio)}`);
    setValue(el, 'chunks', cp.chunksPerSnapshot === undefined ? 'n/a' : String(cp.chunksPerSnapshot));
    setValue(el, 'wire-raw', cp.wireKBps === undefined ? 'n/a' : `${round(cp.wireKBps)} KB/s`);
    setValue(el, 'wire-actual', cp.wireActualKBps === undefined ? 'n/a' : `${round(cp.wireActualKBps)} KB/s`);
    updateSparkline(el, stats?.samples ?? [], budget);
  };
  el.addEventListener('panelopen', () => {
    refresh();
    timer ??= setInterval(refresh, 1000);
  });
  el.addEventListener('panelclose', () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  });
}

function setValue(el: HTMLElement, key: string, value: string, warn = false): void {
  const node = el.querySelector<HTMLElement>(`[data-hud="${key}"]`)!;
  if (node.textContent !== value) node.textContent = value;
  node.classList.toggle('warn', warn);
}

function updateSparkline(el: HTMLElement, samples: number[], budget: number): void {
  const line = el.querySelector<SVGPolylineElement>('[data-hud="spark-line"]')!;
  const budgetLine = el.querySelector<SVGLineElement>('[data-hud="budget-line"]')!;
  const max = Math.max(budget, ...samples) * 1.1 || 1;
  const points = samples.length < 2 ? '' : samples
    .map((value, i) => `${round2((i * 200) / (samples.length - 1))},${round2(40 - (value / max) * 40)}`)
    .join(' ');
  if (line.getAttribute('points') !== points) line.setAttribute('points', points);
  const y = budget ? String(round2(40 - (budget / max) * 40)) : '40';
  if (budgetLine.getAttribute('y1') !== y) {
    budgetLine.setAttribute('y1', y);
    budgetLine.setAttribute('y2', y);
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
