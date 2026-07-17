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
  /** Mean time spent rebuilding the SVG per redraw this window, in ms. */
  drawMsAvg?: number;
  /** Worst single redraw this window, in ms — the read on "close to budget". */
  drawMsPeak?: number;
  /** Logical (uncompressed) size of the most recent snapshot, in KB — the whole
   *  world serialized to JSON. Watch it grow as the world does; it's what a
   *  delta pass would target. */
  snapshotKB?: number;
  /** Actual on-the-wire size of the most recent snapshot after gzip, in KB. */
  snapshotWireKB?: number;
  /** Compression ratio (raw ÷ wire) for the most recent snapshot, e.g. 10 = ×10. */
  compressRatio?: number;
  /** PeerJS/WebRTC chunks the last snapshot fragmented into. 1 = fits a single
   *  data-channel message (under the 16.3 KB chunk MTU); more means it was split
   *  and reassembled on arrival. */
  chunksPerSnapshot?: number;
  /** Hypothetical uncompressed wire throughput, in KB/s (raw size × rate) — the
   *  bandwidth we'd be pushing without gzip. */
  wireKBps?: number;
  /** Actual wire throughput after gzip, in KB/s (wire size × rate). */
  wireActualKBps?: number;
  /** Round-trip time to the host in ms (ping→pong), smoothed. */
  latencyMS?: number;
}

// PeerJS (BinaryPack) splits any data-channel message larger than this into
// chunks sent back-to-back and reassembled on the far side. Mirrors the
// library's `chunker.chunkedMTU` — kept here so the HUD can report chunk count
// without reaching into PeerJS internals.
const CHUNK_MTU = 16300;

export const clientPerf = new Store<ClientPerfState>({ fps: 0, snapshotsPerSec: 0 });

// Counters accumulated across the current ~1s window.
let frames = 0;
let snapshots = 0;
let bytesThisWindow = 0;
let wireBytesThisWindow = 0;
let lastSnapshotBytes = 0;
let lastWireBytes = 0;
let draws = 0;
let drawMsSum = 0;
let drawMsPeak = 0;
let windowStart = 0;
let started = false;

/** Record one SVG redraw's duration (ms), measured around the renderer's
 *  innerHTML rebuild. Redraws only happen on snapshots / view changes, not
 *  every frame, so we track the window's mean and worst case rather than a
 *  per-frame rate. */
export function recordDraw(ms: number): void {
  draws++;
  drawMsSum += ms;
  if (ms > drawMsPeak) drawMsPeak = ms;
}

/** Count one applied host snapshot (called from the net client on each one).
 *  `rawBytes` is the logical JSON size; `wireBytes` is what actually arrived on
 *  the wire (gzipped) — 0 for the rare snapshot small enough to skip compression,
 *  in which case the wire size equals the raw size. */
export function recordSnapshot(rawBytes = 0, wireBytes = 0): void {
  snapshots++;
  const wire = wireBytes || rawBytes; // uncompressed snapshots ride raw
  bytesThisWindow += rawBytes;
  wireBytesThisWindow += wire;
  if (rawBytes) lastSnapshotBytes = rawBytes;
  if (wire) lastWireBytes = wire;
}

// Exponential moving average so a single jittery round-trip doesn't make the
// number jump around; published straight to the store (not window-batched).
let latencyEma = 0;
export function recordLatency(rttMS: number): void {
  latencyEma = latencyEma ? latencyEma * 0.7 + rttMS * 0.3 : rttMS;
  clientPerf.set({ latencyMS: latencyEma });
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
        snapshotWireKB: lastWireBytes ? lastWireBytes / 1024 : undefined,
        compressRatio: lastWireBytes ? lastSnapshotBytes / lastWireBytes : undefined,
        chunksPerSnapshot: lastWireBytes ? Math.max(1, Math.ceil(lastWireBytes / CHUNK_MTU)) : undefined,
        wireKBps: bytesThisWindow ? bytesThisWindow / 1024 / (elapsed / 1000) : undefined,
        wireActualKBps: wireBytesThisWindow ? wireBytesThisWindow / 1024 / (elapsed / 1000) : undefined,
        drawMsAvg: draws ? drawMsSum / draws : undefined,
        drawMsPeak: draws ? drawMsPeak : undefined,
      });
      frames = 0;
      snapshots = 0;
      bytesThisWindow = 0;
      wireBytesThisWindow = 0;
      draws = 0;
      drawMsSum = 0;
      drawMsPeak = 0;
      windowStart = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
