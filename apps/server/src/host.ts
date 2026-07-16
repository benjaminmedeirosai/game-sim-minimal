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
  MemoryOp,
  MemoryRevision,
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
import { applyMemoryOps, memoryChanged } from './ai/orchestrator/memory.js';
import { DEFAULT_VOICE, isVoiceId } from './ai/orchestrator/voice.js';
import { loadSave, savePath, writeSave } from './persist.js';

// How many recent conversation turns to feed back to the model as short-term
// memory (a player referring to "that" or "the one I mentioned"). A "turn" is a
// single line (one command OR one AI reply), so this is roughly half as many
// exchanges. Kept generous — these models have plenty of context headroom and
// the turns are short, so a longer window costs little and lets players refer
// back across a real conversation rather than just the last couple of messages.
const CONVERSATION_TURNS = 40;

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
// How many memory revisions we keep for the audit log. The `rev` counter is
// monotonic and independent of this, so trimming the tail never renumbers the
// entries that remain.
const MEMORY_LOG_MAX = 100;
// How often the autosave loop flushes, IF the session changed since the last
// write. A hard kill loses at most this much; graceful exits save immediately.
const AUTOSAVE_INTERVAL_MS = 5000;

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
  // The orchestrator's persistent memory: standing player preferences it chose
  // to keep ("always ..."), more stable than the per-call world/conversation
  // context but editable by the model. Colony-level (one orchestrator), and —
  // like conversation history and the world — in-memory, so it resets on a
  // server restart.
  private aiMemory: string[] = [];
  // Append-only audit log of every memory change (model- or player-driven), so
  // players can review what was remembered/forgotten and when. Capped at
  // MEMORY_LOG_MAX entries; `memoryRev` is the monotonic revision counter, kept
  // separately so trimming the log tail never renumbers surviving entries.
  private aiMemoryLog: MemoryRevision[] = [];
  private memoryRev = 0;
  // Which voice style the orchestrator's "msg" replies use (a VOICES id, or
  // 'off' for no persona). Colony-level and persisted, editable at runtime from
  // the AI Config tab; flows into every prompt via the runCommand context.
  private aiVoice: string = DEFAULT_VOICE;
  // The model tag the orchestrator should run on, if a player picked one. The
  // live source of truth is the Ollama client (ollama.model); this mirrors it
  // for persistence and is fed back to ollama.init() on resume (applied only if
  // the daemon has it). Undefined = use the client's default.
  private aiModel?: string;
  // Set whenever persisted state changes; the autosave loop only writes when
  // it's true, so a paused/idle world isn't rewritten every interval.
  private dirty = false;

  constructor(private readonly broadcast: (msg: HostMsg) => void) {
    // Resume the previous session if one is on disk; otherwise seed a fresh
    // world. This is what stops the world from reseeding on every restart —
    // it only regenerates on an explicit New World (or when no save exists).
    const save = loadSave();
    if (save) {
      this.world = save.world;
      this.aiHistory = new Map(Object.entries(save.aiHistory));
      this.aiMemory = save.aiMemory;
      // Restore the audit log; the rev counter continues from its last entry so
      // new revisions never collide with old ones (even across a trim/restart).
      this.aiMemoryLog = save.aiMemoryLog ?? [];
      this.memoryRev = this.aiMemoryLog.at(-1)?.rev ?? 0;
      // Pre-voice saves have no aiVoice; fall back to the default persona.
      this.aiVoice = save.aiVoice && isVoiceId(save.aiVoice) ? save.aiVoice : DEFAULT_VOICE;
      this.aiModel = save.aiModel;
      this.actionLog = save.actionLog;
      console.log(
        `[save] resumed world ${this.world.id} at tick ${this.world.tick} from ${savePath()}`,
      );
    } else {
      this.world = generateWorld(DEFAULT_SETTINGS, randomUUID(), 'World');
    }
    this.scheduleTick();
    setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    setInterval(() => this.broadcast(this.snapshotMsg()), SNAPSHOT_INTERVAL_MS);
    setInterval(() => this.autosave(), AUTOSAVE_INTERVAL_MS);
    // Bring up the shared Ollama client (health-check, spawn-once, warm). Pass
    // the persisted model pick so it's restored if the daemon still has it.
    void ollama.init(this.aiModel);
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
    this.dirty = true;
  }

  /** Write the full session to disk durably. Used by the autosave loop and by
   *  the process shutdown hook (so a graceful exit — including tsx's restart on
   *  file change — never loses progress). Never throws: a failed write logs and
   *  leaves the session marked dirty so the next attempt retries. */
  save(): void {
    try {
      writeSave({
        world: this.world,
        aiHistory: Object.fromEntries(this.aiHistory),
        aiMemory: this.aiMemory,
        aiMemoryLog: this.aiMemoryLog,
        aiVoice: this.aiVoice,
        aiModel: this.aiModel,
        actionLog: this.actionLog,
      });
      this.dirty = false;
    } catch (err) {
      console.error('[save] write failed:', (err as Error).message);
    }
  }

  /** The interval-driven autosave: only writes when something actually changed. */
  private autosave(): void {
    if (this.dirty) this.save();
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
        memory: this.aiMemory,
        voice: this.aiVoice,
      }),
    });

    // Apply any memory edit ops the model committed (add/edit/del by id — see
    // the op contract in the prompt). Absent = leave memory as-is. Ops that
    // amount to no net change (e.g. a stray out-of-range del) are treated as a
    // no-op: we neither record a revision nor flag a bogus "memory updated" in
    // the audit log (drop them from the exchange's output).
    if (result.memoryOps !== undefined) {
      if (!this.commitMemory(result.memoryOps, 'AI', onBehalfOf)) result.output.memoryOps = undefined;
    }

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
    this.dirty = true; // new exchange (+ any memory change) — persist chat/history
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

  /** Wipe an agent's exchange history (the shared chat log the model replays as
   *  short-term memory). Used to clear context poisoning. Leaves the world and
   *  saved memory untouched; persists so the wipe survives a restart, and
   *  broadcasts so every client's chat empties. In-flight commands are left
   *  alone — they'll file into the fresh log when they finish. */
  clearAi(agent: string): void {
    this.aiHistory.set(agent, []);
    this.dirty = true;
    this.broadcast({ m: 'aiEvent', agent });
  }

  /** Apply a batch of memory edit ops to the colony's standing memory, recording
   *  an audit revision when (and only when) the net result actually changed.
   *  Returns whether anything changed. Shared by the model path (runCommand) and
   *  the manual Memory-tab path (editMemory). Does NOT broadcast — callers decide
   *  (runCommand folds it into its own aiEvent). */
  private commitMemory(ops: MemoryOp[], by: string, via?: string): boolean {
    const next = applyMemoryOps(this.aiMemory, ops);
    if (!memoryChanged(this.aiMemory, next)) return false;
    this.aiMemory = next;
    this.memoryRev += 1;
    this.aiMemoryLog.push({
      rev: this.memoryRev,
      at: Date.now(),
      tick: this.world.tick,
      by,
      ...(via ? { via } : {}),
      ops,
      after: next,
    });
    if (this.aiMemoryLog.length > MEMORY_LOG_MAX) {
      this.aiMemoryLog.splice(0, this.aiMemoryLog.length - MEMORY_LOG_MAX);
    }
    this.dirty = true;
    return true;
  }

  /** Manually edit the colony's standing memory from the Memory tab, using the
   *  same add/edit/del ops the model uses (ids are the 1-based positions shown
   *  there). Records an audit revision attributed to the editing player, and
   *  broadcasts an aiEvent so every open Memory/Config tab refetches. No-op on a
   *  bad agent, an empty op list, or ops that change nothing. */
  editMemory(agent: string, ops: MemoryOp[], by: string): void {
    if (agent !== ORCHESTRATOR_AGENT || ops.length === 0) return;
    if (this.commitMemory(ops, by)) this.broadcast({ m: 'aiEvent', agent });
  }

  /** Switch the orchestrator's voice style (colony-wide). Validated against the
   *  known styles ('off' included) so a bad id can't disable replies silently.
   *  Persists and broadcasts an aiEvent so every open Config tab refetches and
   *  shows the new Voice section (or its removal) in the live prompt. No-op if
   *  the id is unknown or already active. */
  setAiVoice(agent: string, voice: string): void {
    if (agent !== ORCHESTRATOR_AGENT || !isVoiceId(voice) || voice === this.aiVoice) return;
    this.aiVoice = voice;
    this.dirty = true;
    this.broadcast({ m: 'aiEvent', agent });
  }

  /** Switch the model the orchestrator runs on (colony-wide). The Ollama client
   *  validates the tag against what the daemon has installed and warms it;
   *  we only persist + broadcast on a real change, so an unknown or no-op tag is
   *  ignored. Broadcasting an aiEvent refreshes every open Config tab. */
  setAiModel(agent: string, model: string): void {
    if (agent !== ORCHESTRATOR_AGENT || !ollama.setModel(model)) return;
    this.aiModel = model;
    this.dirty = true;
    this.broadcast({ m: 'aiEvent', agent });
  }

  /** Build the aiHistory reply for a requested agent (history + prompt config
   *  + the roster of known agents for the window's selector). */
  aiHistoryMsg(agent: string, roster: string[] = []): HostMsg {
    return {
      m: 'aiHistory',
      agent,
      agents: [ORCHESTRATOR_AGENT],
      exchanges: this.aiHistory.get(agent) ?? [],
      // Preview matches what the AI actually sees: same fogged world, live
      // roster, recent conversation, and saved memory the real call assembles.
      config: orchestratorConfig(fogWorld(this.world), {
        memory: this.aiMemory,
        roster,
        history: this.recentConversation(),
        voice: this.aiVoice,
      }),
      pending: this.aiPending.get(agent) ?? [],
      memory: this.aiMemory,
      memoryLog: this.aiMemoryLog,
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
    // A brand-new world starts a clean session: drop the old colony's chat,
    // memory, and action log so a resume doesn't carry them into the new map.
    this.aiHistory.clear();
    this.aiMemory = [];
    this.aiMemoryLog = [];
    this.memoryRev = 0;
    this.actionLog = [];
    this.broadcast(this.snapshotMsg());
    // Persist immediately so a restart right after New World resumes the NEW
    // world, not the replaced one.
    this.save();
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
    this.dirty = true; // the sim advanced; the next autosave should persist it
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
