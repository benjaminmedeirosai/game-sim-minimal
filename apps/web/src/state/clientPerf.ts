// Client-side performance sampling — the browser half of the Perf dialog (the
// server half comes from the host's TickStats). A single requestAnimationFrame
// loop measures the paint frame rate and, once per second, folds in how many
// host snapshots we applied and the JS heap size (when the browser exposes it).
import { Store } from '@game/shared';

export interface ClientPerfState {
  /** Rendered frames per second (rAF), a read on main-thread health. */
  fps: number;
  /** Host snapshots applied per second (target is ~10/s). */
  snapshotsPerSec: number;
  /** Used JS heap in MB, if the browser exposes performance.memory. */
  heapMB?: number;
}

export const clientPerf = new Store<ClientPerfState>({ fps: 0, snapshotsPerSec: 0 });

// Counters accumulated across the current ~1s window.
let frames = 0;
let snapshots = 0;
let windowStart = 0;
let started = false;

/** Count one applied host snapshot (called from the net client on each one). */
export function recordSnapshot(): void {
  snapshots++;
}

// Chrome-only, non-standard; typed narrowly so we don't lean on `any` elsewhere.
interface MemoryInfo {
  usedJSHeapSize: number;
}

/** Start the sampling loop (idempotent). Publishes to `clientPerf` every ~1s. */
export function startClientPerf(): void {
  if (started) return;
  started = true;

  const loop = (now: number): void => {
    if (windowStart === 0) windowStart = now;
    frames++;
    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
      clientPerf.set({
        fps: (frames * 1000) / elapsed,
        snapshotsPerSec: (snapshots * 1000) / elapsed,
        heapMB: mem ? mem.usedJSHeapSize / 1_048_576 : undefined,
      });
      frames = 0;
      snapshots = 0;
      windowStart = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
