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
  ClientMsg,
  HostMsg,
  MemoryOp,
  MemoryRevision,
  PeerInfo,
  World,
  WorldSettings,
} from '@game/shared';
import { camera, game } from '../state/game';
import { clampTilesAcross, refreshViewportInfo } from '../render/viewport';
import { recordLatency, recordSnapshot } from '../state/clientPerf';

export interface NetState {
  status: 'connecting' | 'connected' | 'error';
  me?: PeerInfo;
  roster: PeerInfo[];
  error?: string;
}

export const net = new Store<NetState>({ status: 'connecting', roster: [] });

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
}
export const aiData = new Store<AiState>({
  agents: [],
  exchanges: [],
  pending: [],
  memory: [],
  memoryLog: [],
});

// Bumped whenever the host reports a new exchange, so an open window refetches.
export const aiEvents = new Store<{ agent: string; n: number }>({ agent: '', n: 0 });

let conn: DataConnection | undefined;
let peer: Peer | undefined;
let clientName = '';
let lastWorldId: string | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;

const PING_INTERVAL_MS = 2000;

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
 *  connection gate). No-op before the first connect(). */
export function reconnect(): void {
  if (clientName) connect(clientName);
}

export function connect(name: string): void {
  clientName = name;
  net.set({ status: 'connecting', error: undefined });

  // Tear down any peer from a previous (failed) attempt so retries start clean.
  peer?.destroy();

  const p = new Peer(); // random id assigned by the broker
  peer = p;

  p.on('open', () => {
    conn = p.connect(ROOM_ID, { reliable: true });

    conn.on('open', () => {
      const hello: ClientMsg = { m: 'hello', name, role: 'player' };
      conn!.send(hello);
      net.set({ status: 'connected' });
      // Pull the shared chat immediately so the sidebar has it without anyone
      // opening the AI History window first.
      sendAiHistoryReq(ORCHESTRATOR_AGENT);
      startPinging(); // begin RTT latency probes
    });

    conn.on('data', (raw) => handleHostMsg(raw as HostMsg));

    conn.on('close', () => {
      stopPinging();
      net.set({ status: 'error', error: 'Disconnected from host.' });
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

function handleHostMsg(msg: HostMsg): void {
  switch (msg.m) {
    case 'welcome':
      net.set({ me: msg.you, roster: msg.roster });
      break;
    case 'roster':
      net.set({ roster: msg.roster });
      break;
    case 'snapshot':
      // Approximate the uncompressed wire payload: JSON is ASCII-dominant here,
      // so string length ≈ byte count. This is the whole world sent every tick,
      // so it's what a compression/delta pass would target first.
      recordSnapshot(JSON.stringify(msg).length);
      onSnapshot(msg.world);
      actionLog.set(() => msg.actionLog); // replace (updater form: array, not a merge)
      break;
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
      });
      break;
    case 'aiEvent':
      aiEvents.set((s) => ({ agent: msg.agent, n: s.n + 1 }));
      // Keep the loaded history live (sidebar chat + any open window) without
      // waiting for the player to reopen anything.
      sendAiHistoryReq(msg.agent);
      break;
    case 'pong':
      recordLatency(Date.now() - msg.t); // round-trip time
      break;
  }
}

function onSnapshot(world: World): void {
  game.set({ world });
  // Re-center the camera whenever a NEW world arrives (id changed), honoring
  // the world's configured zoom. Ongoing snapshots of the same world leave the
  // player's pan/zoom alone.
  if (world.id !== lastWorldId) {
    lastWorldId = world.id;
    refreshViewportInfo(); // new world dims change the zoom cap
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
}

export function sendCommand(text: string): void {
  send({ m: 'command', text });
}

export function sendAiHistoryReq(agent: string): void {
  send({ m: 'aiHistoryReq', agent });
}

export function sendAiClear(agent: string): void {
  send({ m: 'aiClear', agent });
}

export function sendAiVoice(agent: string, voice: string): void {
  send({ m: 'aiVoice', agent, voice });
}

export function sendAiMemoryEdit(agent: string, ops: MemoryOp[]): void {
  if (ops.length) send({ m: 'aiMemoryEdit', agent, ops });
}
