// Browser client: always a plain peer that connects to the host (the peer
// holding ROOM_ID). It never becomes host and never mutates world state — it
// renders the host's snapshots and forwards intents/commands.
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { ORCHESTRATOR_AGENT, ROOM_ID, Store } from '@game/shared';
import type {
  Action,
  ActionRecord,
  AiConfigView,
  AiExchange,
  AiPending,
  AiRuntimeStatus,
  AiTestResult,
  AiTestSettings,
  ClientMsg,
  HostMsg,
  MemoryOp,
  MemoryRevision,
  PeerInfo,
  World,
  WorldSettings,
} from '@game/shared';
import { camera, game } from '../state/game';
import { clampTilesAcross, currentView, refreshViewportInfo } from '../render/viewport';
import { recordLatency, recordSnapshot } from '../state/clientPerf';
import {
  deviceToken,
  rememberName,
  saveAllowOthers,
  saveCamera,
  saveName,
  savedCamera,
} from '../state/identity';
import type { CameraState } from '@game/shared';

export interface NetState {
  /** 'idle' = showing the join form, not yet connecting; 'error' = host
   *  unreachable (retryable); 'rejected' = host refused the name (re-show form). */
  status: 'idle' | 'connecting' | 'connected' | 'error' | 'rejected';
  me?: PeerInfo;
  roster: PeerInfo[];
  error?: string;
}

export const net = new Store<NetState>({ status: 'idle', roster: [] });

// Recent attributed actions for the Actions panel; replaced every snapshot.
export const actionLog = new Store<ActionRecord[]>([]);

// The currently-loaded AI history + prompt config (for the AI History window).
export interface AiState {
  agent?: string;
  agents: string[];
  exchanges: AiExchange[];
  config?: AiConfigView;
  // Commands accepted but not yet answered (running + queued), oldest first.
  pending: AiPending[];
  // The colony's current standing memory and its change log, for the Memory tab.
  memory: string[];
  memoryLog: MemoryRevision[];
  testResults: AiTestResult[];
}
export const aiData = new Store<AiState>({
  agents: [],
  exchanges: [],
  pending: [],
  memory: [],
  memoryLog: [],
  testResults: [],
});

// Bumped whenever the host reports a new exchange, so an open window refetches.
export const aiEvents = new Store<{ agent: string; n: number }>({ agent: '', n: 0 });

// The AI backend's live runtime status (daemon up, resident models, host
// memory/CPU). Polled by the Config tab; `status` is undefined until the first
// reply (Store requires an object, so it's wrapped).
export const aiStatus = new Store<{ status?: AiRuntimeStatus }>({});
export const aiTest = new Store<{ result?: AiTestResult }>({});

let conn: DataConnection | undefined;
let peer: Peer | undefined;
let clientName = '';
let clientAllowOthers = false;
// The account's saved camera, sent by the host in `welcome`. Held until the
// first snapshot so we can pick the newer of it vs. our local camera.
let hostCamera: CameraState | undefined;
let lastWorldId: string | undefined;
// Highest snapshot tick applied for the current world. Snapshots inflate
// asynchronously, so a slower-decompressing older frame can resolve after a
// newer one — this lets us drop the stale straggler instead of rewinding.
let lastSnapshotTick = -1;
let pingTimer: ReturnType<typeof setInterval> | undefined;

const PING_INTERVAL_MS = 2000;

// How long panning/zooming must settle before we report the camera to the host.
// The report is pure orientation info for the AI, not gameplay, so a lazy 2s
// trailing debounce keeps a smooth pan from spamming the channel; an action send
// flushes it immediately (see sendAction) so a command always carries a fresh
// view "for free".
const CAMERA_DEBOUNCE_MS = 2000;
let cameraTimer: ReturnType<typeof setTimeout> | undefined;
// Last camera we actually reported, as a comparison key, so an unchanged view
// (or the echo from a host-driven setCamera) doesn't re-send.
let lastCameraKey: string | undefined;

/** Report the current camera to the host now, unless it's unchanged since the
 *  last report (or we're not connected). Values are rounded to whole tiles — the
 *  AI only needs an approximate view, and rounding makes the unchanged-guard
 *  effective during sub-tile panning. */
function sendCamera(): void {
  if (!conn?.open) return;
  const v = currentView();
  const cx = Math.round(v.cx);
  const cy = Math.round(v.cy);
  const w = Math.max(1, Math.round(v.w));
  const h = Math.max(1, Math.round(v.h));
  const key = `${cx},${cy},${w},${h}`;
  if (key === lastCameraKey) return;
  lastCameraKey = key;
  send({ m: 'camera', cx, cy, w, h });
  // Persist locally too (world-scoped + timestamped). Width in tiles IS the zoom
  // (tilesAcross). The matching ts is how the host and this browser decide whose
  // saved camera is newer on the next load.
  const worldId = game.get().world?.id;
  if (worldId) saveCamera({ worldId, cx, cy, tilesAcross: w, ts: Date.now() });
}

/** Trailing-debounced camera report: called on every camera change, actually
 *  sends once movement settles for CAMERA_DEBOUNCE_MS. */
function scheduleCameraSend(): void {
  if (cameraTimer) clearTimeout(cameraTimer);
  cameraTimer = setTimeout(() => {
    cameraTimer = undefined;
    sendCamera();
  }, CAMERA_DEBOUNCE_MS);
}

// Report the camera (debounced) whenever it pans or zooms. subscribe() fires
// once immediately; that early call is a no-op (not connected yet).
camera.subscribe(scheduleCameraSend);

function startPinging(): void {
  stopPinging();
  const ping = (): void => send({ m: 'ping', t: Date.now() });
  ping(); // measure immediately, then on an interval
  pingTimer = setInterval(ping, PING_INTERVAL_MS);
}

function stopPinging(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;
}

/** Re-run the last connection attempt (used by the "Retry" button on the
 *  connection gate when the host is unreachable). No-op before the first
 *  connect(). */
export function reconnect(): void {
  if (clientName) connect(clientName, clientAllowOthers);
}

/** Leave the current room session and return to the join screen. The saved
 * identity remains available there, so this is a deliberate sign-out, not an
 * account reset. */
export function returnToLogin(): void {
  stopPinging();
  if (cameraTimer) clearTimeout(cameraTimer);
  cameraTimer = undefined;
  conn?.close();
  conn = undefined;
  peer?.destroy();
  peer = undefined;
  clientName = '';
  clientAllowOthers = false;
  net.set({ status: 'idle', roster: [] });
}

/** Join as `name`. `allowOthers` opens this account's device-enrollment window
 *  (see the protocol note). The device token is pulled from localStorage. */
export function connect(name: string, allowOthers: boolean): void {
  clientName = name;
  clientAllowOthers = allowOthers;
  saveName(name);
  saveAllowOthers(allowOthers);
  net.set({ status: 'connecting', error: undefined });

  // Tear down any peer from a previous (failed) attempt so retries start clean.
  peer?.destroy();

  const p = new Peer(); // random id assigned by the broker
  peer = p;

  p.on('open', () => {
    conn = p.connect(ROOM_ID, { reliable: true });

    conn.on('open', () => {
      const hello: ClientMsg = {
        m: 'hello',
        name,
        role: 'player',
        deviceToken: deviceToken(),
        allowOthers,
      };
      conn!.send(hello);
      // NB: not "connected" yet — the host may reject the name. We flip to
      // connected on `welcome`, or back to the form on `rejected`.
    });

    conn.on('data', (raw) => {
      // Large host messages arrive gzipped as a binary frame (see safeSend on the
      // host); small ones come through as plain objects. Inflate the binary ones
      // off the event-loop, then dispatch. Decompression is async, so the
      // snapshot handler guards against an older frame landing after a newer one.
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        // The byteLength here IS the compressed on-wire size of this frame —
        // pass it through so the snapshot handler can report the real wire cost.
        const wireBytes =
          raw instanceof ArrayBuffer ? raw.byteLength : (raw as ArrayBufferView).byteLength;
        inflate(raw as ArrayBuffer | ArrayBufferView)
          .then((msg) => handleHostMsg(msg as HostMsg, wireBytes))
          .catch((err) => console.error('failed to inflate host message', err));
      } else {
        handleHostMsg(raw as HostMsg);
      }
    });

    conn.on('close', () => {
      stopPinging();
      // Ignore closes that fire while we're tearing down for a fresh attempt
      // (reconnect destroys the old peer); only a drop from a live session is a
      // real disconnect. A `rejected` also leaves us off the connected state.
      if (net.get().status === 'connected') {
        net.set({ status: 'error', error: 'Disconnected from host.' });
      }
    });
  });

  peer.on('error', (err) => {
    const type = (err as { type?: string }).type ?? 'unknown';
    const detail =
      type === 'peer-unavailable'
        ? 'Host is not running. Start the server and reload.'
        : type;
    net.set({ status: 'error', error: detail });
  });
}

/** Inflate a gzipped binary host frame back into its message object. Uses the
 *  built-in DecompressionStream (zero deps) via the Response stream plumbing. */
async function inflate(buf: ArrayBuffer | ArrayBufferView): Promise<unknown> {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function handleHostMsg(msg: HostMsg, wireBytes = 0): void {
  switch (msg.m) {
    case 'welcome':
      // Accepted. NOW we're truly connected: stash the account's saved camera
      // (used on the first snapshot), start the chat + latency probes.
      hostCamera = msg.lastCamera;
      // Remember the canonical name for the join screen's player picker, so a
      // returning player reselects this character instead of retyping (and
      // risking a new one).
      rememberName(msg.you.name);
      net.set({ status: 'connected', me: msg.you, roster: msg.roster, error: undefined });
      sendAiHistoryReq(ORCHESTRATOR_AGENT);
      startPinging();
      break;
    case 'rejected':
      // Host refused the name (taken by another device, invalid, or superseded).
      // Drop back to the join form with the reason; do NOT auto-retry.
      stopPinging();
      peer?.destroy();
      net.set({ status: 'rejected', error: msg.reason });
      break;
    case 'roster':
      net.set({ roster: msg.roster });
      break;
    case 'snapshot': {
      // Drop a stale frame that inflated out of order (same world, older tick).
      // A new world (different id) always applies and resets the tick baseline.
      const w = msg.world;
      if (w.id === lastWorldId && w.tick < lastSnapshotTick) break;
      // Report both sizes: the logical world size (raw JSON) and the actual
      // gzipped bytes that arrived (wireBytes, 0 if this snapshot was small
      // enough to skip compression). The panel shows the ratio + chunk count.
      recordSnapshot(JSON.stringify(msg).length, wireBytes);
      onSnapshot(w); // sets lastWorldId on a new world
      lastSnapshotTick = w.tick;
      actionLog.set(() => msg.actionLog); // replace (updater form: array, not a merge)
      break;
    }
    case 'stats':
      game.set({ stats: msg.stats, tick: msg.tick, speed: msg.speed });
      break;
    case 'aiHistory':
      aiData.set({
        agent: msg.agent,
        agents: msg.agents,
        exchanges: msg.exchanges,
        config: msg.config,
        pending: msg.pending,
        memory: msg.memory,
        memoryLog: msg.memoryLog,
        testResults: msg.testResults,
      });
      break;
    case 'aiStatus':
      aiStatus.set(() => ({ status: msg.status }));
      break;
    case 'aiTest':
      aiTest.set(() => ({ result: msg.result }));
      break;
    case 'aiEvent':
      aiEvents.set((s) => ({ agent: msg.agent, n: s.n + 1 }));
      // Keep the loaded history live (sidebar chat + any open window) without
      // waiting for the player to reopen anything.
      sendAiHistoryReq(msg.agent);
      break;
    case 'setCamera': {
      // The AI moved THIS player's camera (setView) in response to their own
      // command — pan and/or zoom, whatever it sent. Pure view-state: clamp the
      // zoom the same way manual zoom does, and keep the center inside the world.
      const world = game.get().world;
      const cam = camera.get();
      const next: Partial<typeof cam> = {};
      if (msg.cx != null) next.cx = world ? Math.max(0, Math.min(world.width, msg.cx)) : msg.cx;
      if (msg.cy != null) next.cy = world ? Math.max(0, Math.min(world.height, msg.cy)) : msg.cy;
      if (msg.tilesAcross != null) next.tilesAcross = clampTilesAcross(msg.tilesAcross);
      if (Object.keys(next).length) camera.set(next);
      break;
    }
    case 'pong':
      recordLatency(Date.now() - msg.t); // round-trip time
      break;
  }
}

function onSnapshot(world: World): void {
  game.set({ world });
  // On the FIRST snapshot of a world (id changed), restore the camera. Ongoing
  // snapshots of the same world leave the player's pan/zoom alone.
  if (world.id !== lastWorldId) {
    lastWorldId = world.id;
    refreshViewportInfo(); // new world dims change the zoom cap
    restoreCamera(world);
  }
}

/** Pick the camera to open a world at: the newer (by timestamp) of this
 *  browser's saved camera and the account's host-saved camera, provided it's for
 *  THIS world; otherwise center on the world at its configured zoom. This makes
 *  the local client authoritative when it's freshest, but lets a move made on
 *  another device (newer on the host) win. */
function restoreCamera(world: World): void {
  const candidates = [savedCamera(), hostCamera].filter(
    (c): c is CameraState => !!c && c.worldId === world.id,
  );
  const best = candidates.sort((a, b) => b.ts - a.ts)[0];
  if (best) {
    camera.set({
      cx: Math.max(0, Math.min(world.width, best.cx)),
      cy: Math.max(0, Math.min(world.height, best.cy)),
      tilesAcross: clampTilesAcross(best.tilesAcross),
    });
  } else {
    camera.set({
      cx: world.width / 2,
      cy: world.height / 2,
      tilesAcross: clampTilesAcross(world.settings.zoom),
    });
  }
}

function send(msg: ClientMsg): void {
  if (conn?.open) conn.send(msg);
}

export function sendNewWorld(settings: WorldSettings): void {
  send({ m: 'newWorld', settings });
}

export function sendSpeed(multiplier: number): void {
  send({ m: 'setSpeed', multiplier });
}

export function sendAction(action: Action): void {
  send({ m: 'action', action });
  // Piggyback a fresh camera report on the action (free orientation for the AI)
  // and cancel the pending debounced send — this one supersedes it.
  if (cameraTimer) {
    clearTimeout(cameraTimer);
    cameraTimer = undefined;
  }
  sendCamera();
}

export function sendCommand(text: string): void {
  send({ m: 'command', text });
}

export function sendAiHistoryReq(agent: string): void {
  send({ m: 'aiHistoryReq', agent });
}

export function sendAiStatusReq(agent: string): void {
  send({ m: 'aiStatusReq', agent });
}

export function sendAiClear(agent: string): void {
  send({ m: 'aiClear', agent });
}

export function sendAiVoice(agent: string, voice: string): void {
  send({ m: 'aiVoice', agent, voice });
}

export function sendAiModel(agent: string, model: string): void {
  send({ m: 'aiModel', agent, model });
}

export function sendAiTest(agent: string, exchangeId: number, settings: AiTestSettings): void {
  send({ m: 'aiTest', agent, exchangeId, settings });
}

export function sendAiTestOriginal(agent: string, exchangeId: number): void {
  send({ m: 'aiTestOriginal', agent, exchangeId });
}

export function sendAiTestClear(agent: string): void {
  send({ m: 'aiTestClear', agent });
}

export function sendAiMemoryEdit(agent: string, ops: MemoryOp[]): void {
  if (ops.length) send({ m: 'aiMemoryEdit', agent, ops });
}
