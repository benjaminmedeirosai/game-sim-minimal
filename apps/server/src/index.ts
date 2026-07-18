// The always-on host. It claims the room id on the public PeerJS broker and
// becomes the authoritative peer. It handles the handshake + roster and owns
// the authoritative simulation (the tick loop lives in host.ts). Later
// milestones add the AI orchestrator and world persistence.
import './webrtc-polyfill.js';

import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import peerModule from 'peerjs';
import type { DataConnection } from 'peerjs';

// peerjs ships a CJS bundle with no `exports` map. Under Node's ESM interop the
// default import resolves to the whole module.exports object (the named `Peer`
// export isn't statically detectable), so we reach the class off it at runtime.
// The cast lines the value up with peerjs's typings, which declare the default
// export AS the Peer class.
const Peer = (peerModule as unknown as { Peer: typeof peerModule }).Peer;
import { ROOM_ID } from '@game/shared';
import type { ActionSource, CameraState, ClientMsg, HostMsg, PeerInfo } from '@game/shared';
import { Roster } from './roster.js';
import { Host } from './host.js';
import { Accounts } from './accounts.js';

// The player identity registry (device-token accounts). Separate from the world
// save so it survives New World and never rides in a snapshot.
const accounts = new Accounts();

const HOST_ID = ROOM_ID; // the host's peer id IS the room id
const roster = new Roster();

// The host lists itself as the AI-orchestrator service and the room host.
roster.add({
  id: HOST_ID,
  name: 'AI Server',
  role: 'service',
  serviceType: 'ai-orchestrator',
  isHost: true,
});

const conns = new Map<string, DataConnection>();

/** Attribution for an action/command from a connected player. */
function playerSource(peerId: string): ActionSource {
  const name = roster.list().find((p) => p.id === peerId)?.name ?? peerId;
  return { kind: 'player', peerId, name };
}

// Above this JSON size (bytes), gzip the payload before sending. WebRTC data
// channels don't compress (unlike HTTP), and the full-world snapshot is ~300KB
// of highly repetitive JSON sent ~10×/s — raw, that floods the channel's send
// buffer and the big message never reassembles on the far side. gzip cuts it
// ~20× so it drains easily. Small control messages stay plain objects (PeerJS
// msgpacks those) — not worth the CPU or the binary framing.
const COMPRESS_OVER_BYTES = 8192;

/** Send to one peer, tolerating a dead/closing channel. Large messages go out
 *  gzipped (as bytes); the client detects a binary frame and inflates it.
 *  Returns success. */
function safeSend(conn: DataConnection, msg: HostMsg): boolean {
  if (!conn.open) return false;
  try {
    const json = JSON.stringify(msg);
    conn.send(json.length > COMPRESS_OVER_BYTES ? gzipSync(json) : msg);
    return true;
  } catch {
    return false;
  }
}

/** Broadcast to every peer, pruning any connection that has gone dead. A
 *  single bad connection must never stop healthy peers from receiving — the
 *  old version threw mid-loop and silently dropped later recipients. */
function broadcast(msg: HostMsg): void {
  const dead: string[] = [];
  for (const [id, conn] of conns) {
    if (!safeSend(conn, msg)) dead.push(id);
  }
  if (dead.length > 0) {
    for (const id of dead) {
      roster.remove(id);
      conns.delete(id);
    }
    console.log(`[server] pruned ${dead.length} dead connection(s)`);
    // Non-recursive refresh so survivors see the corrected roster.
    const refresh: HostMsg = { m: 'roster', roster: roster.list() };
    for (const conn of conns.values()) safeSend(conn, refresh);
  }
}

/** Send to one peer by id, tolerating an unknown/dead channel. Lets the host
 *  target a single player (e.g. a setCamera nudge) without owning connections. */
function sendTo(peerId: string, msg: HostMsg): void {
  const conn = conns.get(peerId);
  if (conn) safeSend(conn, msg);
}

/** Add an admitted peer to the roster + conns, greet it, and refresh everyone.
 *  `lastCamera` is the account's saved camera (players only) so the client can
 *  restore the newer of its local vs. host camera. */
function seat(conn: DataConnection, info: PeerInfo, lastCamera?: CameraState): void {
  roster.add(info);
  conns.set(conn.peer, conn);
  console.log(`[server] "${info.name}" joined as ${info.role} (${conns.size} peer(s))`);
  safeSend(conn, { m: 'welcome', you: info, roster: roster.list(), lastCamera });
  safeSend(conn, host.snapshotMsg()); // give the newcomer the current world
  broadcast({ m: 'roster', roster: roster.list() });
}

/** Handle a `hello`: players go through account auth (device-token identity,
 *  single live session); a service peer joins directly with no account. */
function admit(conn: DataConnection, msg: Extract<ClientMsg, { m: 'hello' }>): void {
  if (msg.role !== 'player') {
    seat(conn, { id: conn.peer, name: msg.name, role: msg.role, serviceType: msg.serviceType, isHost: false });
    return;
  }
  const res = accounts.authenticate(msg.name, msg.deviceToken, !!msg.allowOthers, conn.peer);
  if (!res.ok) {
    safeSend(conn, { m: 'rejected', reason: res.reason });
    return; // not seated — never added to the roster/conns
  }
  // A newer login supersedes any live session for this account: tell the old
  // peer why, then drop it (accounts already points the slot at the new peer).
  if (res.takeover) {
    const old = conns.get(res.takeover);
    if (old) safeSend(old, { m: 'rejected', reason: 'Your session was opened on another device.' });
    dropPeer(res.takeover, 'superseded');
  }
  seat(
    conn,
    { id: conn.peer, name: res.account.displayName, role: 'player', isHost: false },
    accounts.cameraFor(res.nameKey),
  );
}

/** Remove a peer (idempotent) and tell everyone still connected. */
function dropPeer(id: string, reason: string): void {
  if (!roster.has(id) && !conns.has(id)) return;
  roster.remove(id);
  conns.delete(id);
  host.forgetPlayer(id); // stop reporting a gone player's camera to the model
  accounts.release(id); // free the account's single live-session slot
  console.log(`[server] peer left: ${id} (${reason})`);
  broadcast({ m: 'roster', roster: roster.list() });
}

// The authoritative simulation. It broadcasts snapshots (on world change) and
// stats (~1×/sec) through our resilient broadcast; sendTo lets it nudge one
// player's camera (setView) without owning the connection map.
const host = new Host(broadcast, sendTo);

// Persist the session on the way out so a graceful stop — Ctrl-C, or tsx's
// SIGTERM when it restarts on a file change — resumes exactly where it left
// off. Idempotent + synchronous, so a double signal can't double-write.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — saving session before exit`);
  host.save();
  accounts.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Flush the accounts registry periodically if it changed (new accounts, enrolled
// devices, camera moves). The world save has its own loop inside the host; this
// is the sidecar's equivalent.
const ACCOUNTS_FLUSH_MS = 5000;
setInterval(() => accounts.flush(), ACCOUNTS_FLUSH_MS);

// --- Broker link resilience ------------------------------------------------
// PeerJS keeps a WebSocket to the signalling broker that is SEPARATE from the
// WebRTC data channels. If that socket drops (laptop sleeps, Wi-Fi blips) the
// peer goes 'disconnected': the process stays up and existing data channels may
// linger, but the broker can no longer route NEW joiners to us — so nobody can
// connect, which is exactly the "server's up but I can't join" symptom. PeerJS
// does not self-heal, so we reconnect with capped exponential backoff: reuse the
// same id via reconnect() while the peer is only disconnected, and rebuild it
// from scratch on the same id if it was fully destroyed.
let peer: InstanceType<typeof Peer>;
let everOpened = false;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function linkState(): 'init' | 'open' | 'disconnected' | 'destroyed' {
  if (!peer) return 'init';
  if (peer.destroyed) return 'destroyed';
  if (peer.disconnected) return 'disconnected';
  return 'open';
}

function scheduleReconnect(reason: string): void {
  if (shuttingDown || reconnectTimer) return; // shutting down, or already queued
  console.warn(`[server] broker link lost (${reason}); retrying in ${reconnectDelay}ms`);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      if (peer.destroyed) {
        console.warn('[server] peer was destroyed — rebuilding on the same id');
        peer = wirePeer(new Peer(ROOM_ID, { debug: 2 }));
      } else if (peer.disconnected) {
        peer.reconnect(); // re-opens the broker socket, keeps id + live channels
      }
    } catch (err) {
      console.error('[server] reconnect attempt failed:', (err as Error).message ?? err);
      scheduleReconnect('retry-failed');
    }
  }, delay);
}

/** Attach every handler to a Peer. Factored out so a destroyed peer can be
 *  rebuilt (new Peer, same id) and re-wired identically. */
function wirePeer(p: InstanceType<typeof Peer>): InstanceType<typeof Peer> {
  p.on('open', (id) => {
    everOpened = true;
    reconnectDelay = RECONNECT_MIN_MS; // healthy again — reset backoff
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`[server] hosting room "${id}" — waiting for peers…`);
  });

  // The broker socket dropped (recoverable) or the peer was closed/destroyed.
  p.on('disconnected', () => scheduleReconnect('disconnected'));
  p.on('close', () => scheduleReconnect('closed'));

  p.on('error', (err) => {
    const type = (err as { type?: string }).type ?? 'unknown';
    console.error(`[server] peer error (${type}):`, err.message ?? err);
    if (type === 'unavailable-id') {
      // The id is taken. If we'd already been hosting, it's almost always our
      // own ghost lingering on the broker after a drop — it frees on the broker
      // timeout, so keep retrying. On a cold start it may be a second host.
      if (!everOpened) console.error('[server] room id is already taken — is another host running?');
      scheduleReconnect('unavailable-id');
    } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      // Broker/transport failures that aren't always followed by a disconnect.
      scheduleReconnect(`error:${type}`);
    }
  });

  p.on('connection', (conn) => {
    conn.on('open', () => {
      console.log(`[server] connection opened: ${conn.peer}`);
      // WebRTC 'close' is unreliable on abrupt tab close, so also watch the ICE
      // state — a terminal state means the peer is gone even if 'close' never
      // fires. ('disconnected' is transient and deliberately ignored.)
      const pc = conn.peerConnection;
      pc?.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        if (state === 'failed' || state === 'closed') {
          dropPeer(conn.peer, `ice-${state}`);
        }
      });
    });

    conn.on('data', (raw) => {
      const msg = raw as ClientMsg;
      if (msg.m === 'hello') {
        admit(conn, msg);
      } else if (msg.m === 'newWorld') {
        console.log(`[server] "${roster.list().find((p2) => p2.id === conn.peer)?.name ?? conn.peer}" requested a new world`);
        host.newWorld(msg.settings);
      } else if (msg.m === 'setSpeed') {
        host.setSpeed(msg.multiplier);
      } else if (msg.m === 'action') {
        host.dispatch(msg.action, playerSource(conn.peer));
      } else if (msg.m === 'command') {
        const players = roster.list().map((p2) => p2.name);
        void host.runCommand(msg.text, playerSource(conn.peer), players);
      } else if (msg.m === 'aiHistoryReq') {
        safeSend(conn, host.aiHistoryMsg(msg.agent, roster.list().map((p2) => p2.name)));
      } else if (msg.m === 'aiStatusReq') {
        void host.aiStatusMsg(msg.agent).then((m) => safeSend(conn, m));
      } else if (msg.m === 'aiClear') {
        host.clearAi(msg.agent);
      } else if (msg.m === 'aiVoice') {
        host.setAiVoice(msg.agent, msg.voice);
      } else if (msg.m === 'aiModel') {
        host.setAiModel(msg.agent, msg.model);
      } else if (msg.m === 'aiMemoryEdit') {
        const by = roster.list().find((p2) => p2.id === conn.peer)?.name ?? conn.peer;
        host.editMemory(msg.agent, msg.ops, by);
      } else if (msg.m === 'camera') {
        const name = roster.list().find((p2) => p2.id === conn.peer)?.name ?? conn.peer;
        host.setPlayerCamera(conn.peer, name, msg);
        // Also persist it to the account for cross-device restore. The reported
        // width in tiles IS the zoom (tilesAcross); stamp it so newer wins on load.
        accounts.updateCamera(conn.peer, {
          worldId: host.world.id,
          cx: msg.cx,
          cy: msg.cy,
          tilesAcross: msg.w,
          ts: Date.now(),
        });
      } else if (msg.m === 'ping') {
        safeSend(conn, { m: 'pong', t: msg.t }); // echo for RTT measurement
      }
    });

    conn.on('close', () => dropPeer(conn.peer, 'closed'));
    conn.on('error', (err) => {
      console.error(`[server] connection error (${conn.peer}):`, (err as Error).message ?? err);
      dropPeer(conn.peer, 'error');
    });
  });

  return p;
}

// Local status/health endpoint. NOT the game transport (that's WebRTC) — it
// exists so the process binds a port the Servers UI can watch for readiness,
// and gives a quick way to eyeball the running world.
const STATUS_PORT = Number(process.env.GSM_STATUS_PORT ?? 5174);
createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      room: ROOM_ID,
      link: linkState(), // broker socket health — 'open' means joinable
      peers: conns.size,
      players: roster.list().filter((p) => !p.isHost).length,
      ...host.getStatus(),
    }),
  );
})
  .on('error', (err) => console.error('[server] status endpoint error:', err.message))
  .listen(STATUS_PORT, () => {
    console.log(`[server] status endpoint on http://localhost:${STATUS_PORT}`);
  });

// Claim the room id on the broker and wire up the (self-healing) peer.
peer = wirePeer(new Peer(ROOM_ID, { debug: 2 }));
