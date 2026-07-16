// Wire protocol between the host (Node server) and connected peers.
//
// Two roles connect over the SAME mesh:
//  - 'player'  : a human at a browser
//  - 'service' : a non-player peer providing a capability (e.g. the AI
//                orchestrator). Kept in the model now so future services
//                (spectators, metrics) slot in without protocol changes.
import type { Action, ActionRecord } from './actions.js';
import type { AiConfigView, AiExchange, AiPending, MemoryOp, MemoryRevision } from './ai.js';
import type { TickStatsSnapshot } from './perf.js';
import type { World, WorldSettings } from './types.js';

export type Role = 'player' | 'service';

export interface PeerInfo {
  id: string;
  name: string;
  role: Role;
  serviceType?: string; // e.g. 'ai-orchestrator' when role === 'service'
  isHost: boolean;
}

/** Messages a connecting peer sends TO the host. */
export type ClientMsg =
  | { m: 'hello'; name: string; role: Role; serviceType?: string }
  | { m: 'newWorld'; settings: WorldSettings }
  | { m: 'setSpeed'; multiplier: number }
  | { m: 'action'; action: Action }
  // A natural-language command for the AI orchestrator to turn into actions.
  | { m: 'command'; text: string }
  // Ask the host for an agent's full history + current prompt config.
  | { m: 'aiHistoryReq'; agent: string }
  // Wipe an agent's conversation/exchange history (e.g. to clear context
  // poisoning). Does not touch the world or saved memory — just the chat log.
  | { m: 'aiClear'; agent: string }
  // Switch an agent's voice style (a Config-tab AiVoiceOption id, or 'off' to
  // drop the Voice section). Colony-wide + persisted; changes the live prompt.
  | { m: 'aiVoice'; agent: string; voice: string }
  // Switch the model an agent runs on (a tag from AiConfigView.models). Colony-
  // wide + persisted; the host warms the new model so the next command is fast.
  | { m: 'aiModel'; agent: string; model: string }
  // Manually edit the colony's standing memory from the Memory tab, as the same
  // add/edit/del ops the model uses (ids are the 1-based positions shown there).
  | { m: 'aiMemoryEdit'; agent: string; ops: MemoryOp[] }
  // Round-trip latency probe: `t` is the client's own send time, echoed back
  // in `pong` so the client can measure RTT without any host/client clock sync.
  | { m: 'ping'; t: number };

/** Messages the host sends TO peers. */
export type HostMsg =
  | { m: 'welcome'; you: PeerInfo; roster: PeerInfo[] }
  | { m: 'roster'; roster: PeerInfo[] }
  // `actionLog` is a capped tail of recent attributed actions for the Actions
  // panel; it rides with the world so the panel stays in sync with the sim.
  | { m: 'snapshot'; world: World; actionLog: ActionRecord[] }
  | { m: 'stats'; stats: TickStatsSnapshot; tick: number; speed: number }
  // Reply to aiHistoryReq: the agent's exchanges + prompt config, plus the
  // list of known agents so the window's selector can populate.
  | {
      m: 'aiHistory';
      agent: string;
      agents: string[];
      exchanges: AiExchange[];
      config: AiConfigView;
      // Commands accepted but not yet answered (running + queued), oldest first.
      pending: AiPending[];
      // The colony's current standing memory (numbered in the Memory tab) and
      // its append-only change log, so the tab can show + audit both.
      memory: string[];
      memoryLog: MemoryRevision[];
    }
  // A lightweight nudge that a new exchange was recorded, so an open history
  // window can refetch. Kept payload-free to stay cheap on the broadcast path.
  | { m: 'aiEvent'; agent: string }
  // Reply to a client `ping`, echoing back its send time `t` unchanged.
  | { m: 'pong'; t: number };
