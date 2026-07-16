// Rolling tick-timing instrumentation. The host measures how long each sim
// tick takes and pushes a snapshot to clients ~1×/sec, so we can see when
// ticks approach their budget before we crank the speed up and start missing
// them.

export interface TickStatsSnapshot {
  /** Most recent tick duration (ms). */
  last: number;
  /** Rolling mean over the window (ms). */
  avg: number;
  /** Worst tick in the window (ms). */
  max: number;
  /** 95th percentile in the window (ms). */
  p95: number;
  /** Ticks in the window that exceeded their budget. */
  overruns: number;
  /** Requested ticks/sec (BASE_TPS * speed). */
  targetTps: number;
  /** Actually achieved ticks/sec. */
  actualTps: number;
  /** Raw durations for a sparkline. */
  samples: number[];
}

export class TickStats {
  private samples: number[] = [];
  private readonly cap: number;
  targetTps = 0;
  actualTps = 0;

  constructor(cap = 120) {
    this.cap = cap;
  }

  /** Record one tick's duration against its budget (both ms). */
  push(durationMs: number, budgetMs: number): void {
    this.samples.push(durationMs > budgetMs ? -durationMs : durationMs);
    if (this.samples.length > this.cap) this.samples.shift();
  }

  snapshot(): TickStatsSnapshot {
    // Overruns are encoded as negative samples so the window (not all history)
    // defines the count. Callers only ever see absolute durations.
    const abs = this.samples.map(Math.abs);
    const n = abs.length || 1;
    const sum = abs.reduce((a, b) => a + b, 0);
    const sorted = [...abs].sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
      : 0;
    return {
      last: abs[abs.length - 1] ?? 0,
      avg: sum / n,
      max: sorted[sorted.length - 1] ?? 0,
      p95,
      overruns: this.samples.filter((s) => s < 0).length,
      targetTps: this.targetTps,
      actualTps: this.actualTps,
      samples: abs,
    };
  }
}
