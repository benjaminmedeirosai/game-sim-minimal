// The always-on host. It claims the room id on the public PeerJS broker and
// becomes the authoritative peer. It handles the handshake + roster and owns
// the authoritative simulation (the tick loop lives in host.ts). Later
// milestones add the AI orchestrator and world persistence.
import './webrtc-polyfill.js';

import { createServer } from 'node:http';
import peerModule from 'peerjs';
import type { DataConnection } from 'peerjs';

// peerjs ships a CJS bundle with no `exports` map. Under Node's ESM interop the
// default import resolves to the whole module.exports object (the named `Peer`
// export isn't statically detectable), so we reach the class off it at runtime.
// The cast lines the value up with peerjs's typings, which declare the default
// export AS the Peer class.
const Peer = (peerModule as unknown as { Peer: typeof peerModule }).Peer;
import { ROOM_ID } from '@game/shared';
import type { ActionSource, ClientMsg, HostMsg, PeerInfo } from '@game/shared';
import { Roster } from './roster.js';
import { Host } from './host.js';

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

/** Send to one peer, tolerating a dead/closing channel. Returns success. */
function safeSend(conn: DataConnection, msg: HostMsg): boolean {
  if (!conn.open) return false;
  try {
    conn.send(msg);
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

/** Remove a peer (idempotent) and tell everyone still connected. */
function dropPeer(id: string, reason: string): void {
  if (!roster.has(id) && !conns.has(id)) return;
  roster.remove(id);
  conns.delete(id);
  console.log(`[server] peer left: ${id} (${reason})`);
  broadcast({ m: 'roster', roster: roster.list() });
}

// The authoritative simulation. It broadcasts snapshots (on world change) and
// stats (~1×/sec) through our resilient broadcast.
const host = new Host(broadcast);

// Local status/health endpoint. NOT the game transport (that's WebRTC) — it
// exists so the process binds a port the Servers UI can watch for readiness,
// and gives a quick way to eyeball the running world.
const STATUS_PORT = Number(process.env.GSM_STATUS_PORT ?? 5174);
createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      room: ROOM_ID,
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

const peer = new Peer(ROOM_ID, { debug: 2 });

peer.on('open', (id) => {
  console.log(`[server] hosting room "${id}" — waiting for peers…`);
});

peer.on('error', (err) => {
  const type = (err as { type?: string }).type ?? 'unknown';
  console.error(`[server] peer error (${type}):`, err.message ?? err);
  if (type === 'unavailable-id') {
    console.error('[server] room id is already taken — is another host running?');
  }
});

peer.on('connection', (conn) => {
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
      const info: PeerInfo = {
        id: conn.peer,
        name: msg.name,
        role: msg.role,
        serviceType: msg.serviceType,
        isHost: false,
      };
      roster.add(info);
      conns.set(conn.peer, conn);
      console.log(`[server] "${info.name}" joined as ${info.role} (${conns.size} peer(s))`);
      safeSend(conn, { m: 'welcome', you: info, roster: roster.list() });
      safeSend(conn, host.snapshotMsg()); // give the newcomer the current world
      broadcast({ m: 'roster', roster: roster.list() });
    } else if (msg.m === 'newWorld') {
      console.log(`[server] "${roster.list().find((p) => p.id === conn.peer)?.name ?? conn.peer}" requested a new world`);
      host.newWorld(msg.settings);
    } else if (msg.m === 'setSpeed') {
      host.setSpeed(msg.multiplier);
    } else if (msg.m === 'action') {
      host.dispatch(msg.action, playerSource(conn.peer));
    } else if (msg.m === 'command') {
      const players = roster.list().map((p) => p.name);
      void host.runCommand(msg.text, playerSource(conn.peer), players);
    } else if (msg.m === 'aiHistoryReq') {
      safeSend(conn, host.aiHistoryMsg(msg.agent));
    }
  });

  conn.on('close', () => dropPeer(conn.peer, 'closed'));
  conn.on('error', (err) => {
    console.error(`[server] connection error (${conn.peer}):`, (err as Error).message ?? err);
    dropPeer(conn.peer, 'error');
  });
});
