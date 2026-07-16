// The authoritative simulation host: owns the one true World, runs the tick
// loop, measures tick timing, and exposes speed control. It knows nothing
// about connections — index.ts hands it a `broadcast` function and forwards
// client messages to its methods.
import { randomUUID } from 'node:crypto';
import {
  BASE_TPS,
  STATS_INTERVAL_MS,
  TickStats,
  applyAction,
  fogWorld,
  generateWorld,
  normalizeSettings,
  tick,
} from '@game/shared';
import type {
  Action,
  ActionRecord,
  ActionSource,
  AiExchange,
  AiPending,
  HostMsg,
  World,
  WorldSettings,
} from '@game/shared';
import type { ConversationTurn } from '@game/shared';
import { ollama } from './ai/client.js';
import {
  ORCHESTRATOR_AGENT,
  orchestratorConfig,
  runOrchestrator,
} from './ai/orchestrator/index.js';

// How many recent conversation turns to feed back to the model as short-term
// memory (a player referring to "that" or "the one I mentioned").
const CONVERSATION_TURNS = 6;

const DEFAULT_SETTINGS: WorldSettings = { width: 48, height: 48, seed: 1337, zoom: 20 };

// When a tick's real work exceeds this multiple of its budget we stop trying
// to catch up and reset the schedule, so a slow tick can't spiral.
const BACKLOG_RESET_FACTOR = 3;

// Full-world snapshots go out at this cadence (~10/s) regardless of tick rate,
// decoupling render updates from sim speed. Deltas are a later optimization.
const SNAPSHOT_INTERVAL_MS = 100;

// The Actions panel only needs recent history; cap the tail we keep + ship.
const ACTION_LOG_MAX = 120;
// Per-agent AI exchange history cap (the window can show a lot, but not forever).
const AI_HISTORY_MAX = 50;

export class Host {
  world: World;
  private speed = 1;
  private readonly stats = new TickStats();
  private ticksSinceStats = 0;
  private lastStatsAt = performance.now();
  private nextDeadline = performance.now();
  // Attributed record of recent actions (any submitter), newest last.
  private actionLog: ActionRecord[] = [];
  // Full request/response audit per AI agent, newest last.
  private aiHistory = new Map<string, AiExchange[]>();
  // Commands accepted but not yet answered, per agent (running + queued),
  // oldest first — the live tail shown in the chat before the model replies.
  private aiPending = new Map<string, AiPending[]>();

  constructor(private readonly broadcast: (msg: HostMsg) => void) {
    this.world = generateWorld(DEFAULT_SETTINGS, randomUUID(), 'World');
    this.scheduleTick();
    setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    setInterval(() => this.broadcast(this.snapshotMsg()), SNAPSHOT_INTERVAL_MS);
    // Bring up the shared Ollama client (health-check, spawn-once, warm).
    void ollama.init();
  }

  /** The message a freshly-connected peer needs to render the world, including
   *  the recent action tail for the Actions panel. */
  snapshotMsg(): HostMsg {
    // Ship the fogged view: objects outside the colony's vision are withheld,
    // so a client can only render (and remember) what its units have seen.
    return { m: 'snapshot', world: fogWorld(this.world), actionLog: this.actionLog };
  }

  /** Apply a validated command from a UI or the AI, recording who submitted it.
   *  All world writes funnel through here; the next snapshot carries the
   *  result and the updated action log. */
  dispatch(action: Action, source: ActionSource): void {
    this.actionLog.push({ id: randomUUID(), action, source, tick: this.world.tick });
    if (this.actionLog.length > ACTION_LOG_MAX) {
      this.actionLog.splice(0, this.actionLog.length - ACTION_LOG_MAX);
    }
    applyAction(this.world, action);
  }

  /** The recent shared-chat turns for the model: each exchange contributes the
   *  submitter's command and the AI's reply (when it made one), oldest first. */
  private recentConversation(): ConversationTurn[] {
    const list = this.aiHistory.get(ORCHESTRATOR_AGENT) ?? [];
    const turns: ConversationTurn[] = [];
    for (const x of list) {
      turns.push({ who: x.input.onBehalfOf ?? 'someone', text: x.input.command });
      if (x.output.msg) turns.push({ who: 'AI', text: x.output.msg });
    }
    return turns.slice(-CONVERSATION_TURNS);
  }

  /** Route a natural-language command through the orchestrator, record the full
   *  exchange, then dispatch each resulting action attributed to the AI (with
   *  the requesting player noted). Serial by virtue of the AI client's queue.
   *
   *  The command is registered as "pending" and broadcast immediately, so every
   *  client sees it land (and queue up behind others) before the model replies.
   *  The prompt itself is assembled at send-time via the context callback, so a
   *  queued command reflects the world as it is when it actually runs. */
  async runCommand(text: string, source: ActionSource, roster: string[] = []): Promise<void> {
    const onBehalfOf = source.kind === 'player' ? source.name : undefined;

    const pending: AiPending = {
      id: randomUUID(),
      agent: ORCHESTRATOR_AGENT,
      command: text,
      submitter: onBehalfOf,
      tick: this.world.tick,
    };
    this.pendingList().push(pending);
    this.broadcast({ m: 'aiEvent', agent: ORCHESTRATOR_AGENT });

    const result = await runOrchestrator({
      command: text,
      submitter: onBehalfOf,
      context: () => ({
        world: fogWorld(this.world), // the AI plans over only what units can see
        roster,
        history: this.recentConversation(),
      }),
    });

    // Done: drop it from pending and file the finished exchange.
    const queue = this.pendingList();
    const idx = queue.findIndex((p) => p.id === pending.id);
    if (idx >= 0) queue.splice(idx, 1);

    const exchange: AiExchange = {
      id: randomUUID(),
      agent: ORCHESTRATOR_AGENT,
      tick: this.world.tick,
      input: result.input,
      output: result.output,
      ms: result.ms,
    };
    const list = this.aiHistory.get(ORCHESTRATOR_AGENT) ?? [];
    list.push(exchange);
    if (list.length > AI_HISTORY_MAX) list.splice(0, list.length - AI_HISTORY_MAX);
    this.aiHistory.set(ORCHESTRATOR_AGENT, list);
    this.broadcast({ m: 'aiEvent', agent: ORCHESTRATOR_AGENT });

    const aiSource: ActionSource = { kind: 'ai', agent: ORCHESTRATOR_AGENT, onBehalfOf };
    for (const action of result.actions) this.dispatch(action, aiSource);
  }

  /** The (mutable) pending queue for the orchestrator, created on first use. */
  private pendingList(): AiPending[] {
    let list = this.aiPending.get(ORCHESTRATOR_AGENT);
    if (!list) {
      list = [];
      this.aiPending.set(ORCHESTRATOR_AGENT, list);
    }
    return list;
  }

  /** Build the aiHistory reply for a requested agent (history + prompt config
   *  + the roster of known agents for the window's selector). */
  aiHistoryMsg(agent: string): HostMsg {
    return {
      m: 'aiHistory',
      agent,
      agents: [ORCHESTRATOR_AGENT],
      exchanges: this.aiHistory.get(agent) ?? [],
      config: orchestratorConfig(fogWorld(this.world)), // preview matches what the AI actually sees
      pending: this.aiPending.get(agent) ?? [],
    };
  }

  /** Small, human-readable status for the local health endpoint. */
  getStatus(): { worldId: string; size: string; tick: number; speed: number } {
    return {
      worldId: this.world.id,
      size: `${this.world.width}x${this.world.height}`,
      tick: this.world.tick,
      speed: this.speed,
    };
  }

  setSpeed(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return;
    this.speed = Math.min(8, Math.max(0, multiplier));
  }

  newWorld(settings: WorldSettings): void {
    this.world = generateWorld(normalizeSettings(settings), randomUUID(), 'World');
    this.broadcast(this.snapshotMsg());
  }

  private scheduleTick(): void {
    const delay = Math.max(0, this.nextDeadline - performance.now());
    setTimeout(() => this.runTick(), delay);
  }

  private runTick(): void {
    // Paused: don't advance the sim, just keep the timer alive so unpausing is
    // smooth and the deadline doesn't accumulate a huge backlog.
    if (this.speed <= 0) {
      this.nextDeadline = performance.now() + 100;
      this.scheduleTick();
      return;
    }

    const budgetMs = 1000 / (BASE_TPS * this.speed);
    const start = performance.now();
    tick(this.world);
    const durationMs = performance.now() - start;

    this.stats.push(durationMs, budgetMs);
    this.ticksSinceStats++;

    // Advance the deadline by exactly one budget (drift correction). If real
    // work has fallen far behind, snap forward instead of bursting.
    this.nextDeadline += budgetMs;
    const now = performance.now();
    if (now - this.nextDeadline > budgetMs * BACKLOG_RESET_FACTOR) {
      this.nextDeadline = now;
    }
    this.scheduleTick();
  }

  private emitStats(): void {
    const now = performance.now();
    const elapsedSec = (now - this.lastStatsAt) / 1000;
    this.stats.actualTps = elapsedSec > 0 ? this.ticksSinceStats / elapsedSec : 0;
    this.stats.targetTps = this.speed > 0 ? BASE_TPS * this.speed : 0;
    this.ticksSinceStats = 0;
    this.lastStatsAt = now;

    this.broadcast({
      m: 'stats',
      stats: this.stats.snapshot(),
      tick: this.world.tick,
      speed: this.speed,
    });
  }
}
