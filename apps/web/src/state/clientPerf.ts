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
  /** Serialized size of the most recent snapshot, in KB. The host broadcasts
   *  the whole world each tick with no compression, so this is the raw
   *  per-message payload — watch it grow as the world does. */
  snapshotKB?: number;
  /** Uncompressed wire throughput from snapshots, in KB/s (size × rate). */
  wireKBps?: number;
}

export const clientPerf = new Store<ClientPerfState>({ fps: 0, snapshotsPerSec: 0 });

// Counters accumulated across the current ~1s window.
let frames = 0;
let snapshots = 0;
let bytesThisWindow = 0;
let lastSnapshotBytes = 0;
let windowStart = 0;
let started = false;

/** Count one applied host snapshot (called from the net client on each one),
 *  along with its serialized byte size so the Perf dialog can show payload
 *  size and wire throughput. */
export function recordSnapshot(bytes = 0): void {
  snapshots++;
  bytesThisWindow += bytes;
  if (bytes) lastSnapshotBytes = bytes;
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
        snapshotKB: lastSnapshotBytes ? lastSnapshotBytes / 1024 : undefined,
        wireKBps: bytesThisWindow ? bytesThisWindow / 1024 / (elapsed / 1000) : undefined,
      });
      frames = 0;
      snapshots = 0;
      bytesThisWindow = 0;
      windowStart = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
