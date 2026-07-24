// The authoritative simulation host: owns the one true World, runs the tick
// loop, measures tick timing, and exposes speed control. It knows nothing
// about connections — index.ts hands it a `broadcast` function and forwards
// client messages to its methods.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  BASE_TPS,
  BUILDINGS,
  HARVEST_RULES,
  RECIPES,
  STATS_INTERVAL_MS,
  TickStats,
  applyAction,
  fogWorld,
  generateWorld,
  normalizeGroundItems,
  normalizeSettings,
  OBJECT_HP,
  tick,
  tileAt,
} from '@game/shared';
import type {
  Action,
  ActionRecord,
  ActionSource,
  ActionStatus,
  Coord,
  AiExchange,
  AiPending,
  AiTestResult,
  AiTestSettings,
  HostResources,
  HostMsg,
  MemoryOp,
  MemoryRevision,
  PlayerCameraView,
  Unit,
  World,
  WorldSettings,
} from '@game/shared';
import { ollama } from './ai/client.js';
import {
  ORCHESTRATOR_AGENT,
  orchestratorConfig,
  runOrchestrator,
} from './ai/orchestrator/index.js';
import { replayMessages } from './ai/orchestrator/prompt.js';
import { parseResponse } from './ai/orchestrator/parse.js';
import type { RunResult } from './ai/orchestrator/index.js';
import { applyMemoryOps, memoryChanged } from './ai/orchestrator/memory.js';
import { DEFAULT_VOICE, isVoiceId } from './ai/orchestrator/voice.js';
import { loadSave, savePath, writeSave } from './persist.js';

/** Bytes of genuinely-available RAM. On macOS `os.freemem()` counts only
 *  truly-idle pages (it excludes reclaimable file cache), so it reads ~99% used
 *  forever — useless as a pressure gauge. There we parse `vm_stat` and treat
 *  free + inactive + speculative + purgeable as available (what the OS can hand
 *  back before it starts swapping), matching Activity Monitor's sense of
 *  pressure. Everything else (and any parse failure) falls back to freemem(). */
async function availableMemBytes(): Promise<number> {
  if (os.platform() !== 'darwin') return os.freemem();
  try {
    const { stdout } = await execFileAsync('vm_stat', [], { timeout: 1500 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]) || 4096;
    const pages = (label: string): number =>
      Number(new RegExp(`${label}:\\s+(\\d+)\\.`).exec(stdout)?.[1] ?? 0);
    const reclaimable =
      pages('Pages free') +
      pages('Pages inactive') +
      pages('Pages speculative') +
      pages('Pages purgeable');
    return reclaimable > 0 ? reclaimable * pageSize : os.freemem();
  } catch {
    return os.freemem();
  }
}

/** Sample the host machine's memory + CPU for the AI status card. The model runs
 *  here, so this is where its memory footprint shows up. Memory uses a real
 *  availability read (see availableMemBytes) so the gauge tracks actual
 *  pressure, not macOS's misleading free-page count. CPU is the 1-min load
 *  average as a percent of cores. */
async function hostResources(): Promise<HostResources> {
  const total = os.totalmem();
  const avail = await availableMemBytes();
  const cores = os.cpus().length;
  const load1 = os.loadavg()[0];
  return {
    memTotalMB: Math.round(total / 1e6),
    memUsedMB: Math.round((total - avail) / 1e6),
    memFreePct: total > 0 ? Math.round((avail / total) * 100) : 0,
    cpuPct: cores > 0 ? Math.round((load1 / cores) * 100) : undefined,
    cores,
  };
}

// How many recent conversation turns to feed back to the model as short-term
// memory (a player referring to "that" or "the one I mentioned"). A "turn" is a
// single line (one command OR one AI reply), so this is roughly half as many
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
const AI_TEST_RESULTS_MAX = 100;
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
  // The action each unit is currently executing (record id + info needed to
  // resolve its outcome), so a job finishing/aborting can be attributed back to
  // the action that started it. A unit has at most one in-flight action; a new
  // command supersedes (interrupts) the old one. Rebuilt from scratch each
  // session — not persisted (a resume shows loaded actions as-is).
  private unitAction = new Map<string, { recId: string; type: Action['type']; verb?: string; moveTotal?: number }>();
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
  // Single host-wide sequence for real AI requests. It deliberately survives a
  // history clear (and a new world) so a short request number never repeats.
  private aiRequestSeq = 0;
  // Shared Test Suite history. Unlike an individual browser's UI state, this is
  // colony/server-owned so every player sees the same comparison runs.
  private aiTestResults: AiTestResult[] = [];
  // Set whenever persisted state changes; the autosave loop only writes when
  // it's true, so a paused/idle world isn't rewritten every interval.
  private dirty = false;
  // What each connected player currently sees on screen, keyed by peerId. Pure
  // view-state (never in World, never through applyAction) — reported by clients
  // via `camera` messages and fed into the prompt so the model can orient
  // replies/moves relative to each human. Cleared on disconnect (forgetPlayer).
  private playerCameras = new Map<string, PlayerCameraView>();

  constructor(
    private readonly broadcast: (msg: HostMsg) => void,
    // Deliver a message to ONE peer (the host doesn't own connections; index.ts
    // supplies this from its conns map). Used to move only the submitter's
    // camera in response to a setView the model produced.
    private readonly sendTo: (peerId: string, msg: HostMsg) => void,
  ) {
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
      this.aiTestResults = save.aiTestResults ?? [];
      this.aiRequestSeq = save.aiRequestSeq ?? 0;
      this.migrateAiRequestIds();
      this.actionLog = save.actionLog;
      // Heal legacy saves made before the one-resource-per-tile rule: split any
      // mixed ground tiles so nothing sits stacked with a different resource.
      const healed = normalizeGroundItems(this.world);
      if (healed > 0) {
        this.dirty = true; // persist the cleaned world on the next autosave
        console.log(`[save] normalized ${healed} mixed ground tile(s) to one resource each`);
      }
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
    const rec: ActionRecord = { id: randomUUID(), action, source, tick: this.world.tick, status: 'ongoing' };
    this.actionLog.push(rec);
    if (this.actionLog.length > ACTION_LOG_MAX) {
      this.actionLog.splice(0, this.actionLog.length - ACTION_LOG_MAX);
    }
    applyAction(this.world, action);
    this.resolveInitialStatus(rec);
    this.dirty = true;
  }

  /** Find a live record by id (the log is short, so a scan is fine). */
  private recordById(id: string): ActionRecord | undefined {
    return this.actionLog.find((r) => r.id === id);
  }

  private static coordEq(a: Coord, b: Coord): boolean {
    return a.x === b.x && a.y === b.y;
  }

  /** Did a hauling unit reach its drop/pickup target? On-tile for a ground
   *  transfer; adjacent for a storage depot (whose own tile is unwalkable, so the
   *  unit works it from next door — see sim.haulArrived). */
  private haulArrived(unit: Unit, at: Coord): boolean {
    const bid = tileAt(this.world, at.x, at.y)?.building;
    const depot = bid ? this.world.buildings[bid]?.type === 'storage' : false;
    if (depot) return Math.abs(unit.pos.x - at.x) + Math.abs(unit.pos.y - at.y) === 1;
    return Host.coordEq(unit.pos, at);
  }

  /** Set an action's status just after it was applied: cancel resolves instantly
   *  (and interrupts whatever the unit was doing); a job-creating action starts
   *  'ongoing' and becomes the unit's in-flight action (superseding any prior
   *  one), or 'error'/'done' if no job actually took hold. */
  private resolveInitialStatus(rec: ActionRecord): void {
    const a = rec.action;
    const unit = this.world.units[a.unitId];
    if (a.type === 'cancel') {
      const prev = this.unitAction.get(a.unitId);
      if (prev) {
        const pr = this.recordById(prev.recId);
        if (pr && pr.status === 'ongoing') pr.status = 'interrupted';
        this.unitAction.delete(a.unitId);
      }
      rec.status = 'done';
      return;
    }
    if (!unit) {
      rec.status = 'error';
      rec.failureReason = 'Unit no longer exists.';
      return;
    }
    // A plain move onto the tile the unit already occupies does nothing to walk.
    if (a.type === 'move' && Host.coordEq(unit.pos, a.to) && !unit.moveGoal) {
      rec.status = 'done';
      return;
    }
    // Instant transfers with no walk resolve immediately: dropNearby always,
    // and a drop/pickup that had no tile to walk to (done on the spot, or a
    // harmless no-op). A drop/pickup that DID start a walk falls through to the
    // ongoing path below.
    if (a.type === 'dropNearby') {
      rec.status = 'done';
      return;
    }
    if ((a.type === 'drop' || a.type === 'pickup') && !unit.haulJob) {
      rec.status = 'done';
      return;
    }
    const started =
      a.type === 'move'
        ? !!unit.moveGoal
        : a.type === 'harvest'
          ? !!unit.job
          : a.type === 'craft'
            ? !!unit.craftJob
            : a.type === 'build'
              ? !!unit.buildJob
              : a.type === 'drop' || a.type === 'pickup'
                ? !!unit.haulJob
                : false;
    if (!started) {
      // The busy-guard rejected it, or there was nothing to do (empty target,
      // unreachable). Nothing will run, so it's a no-op failure.
      rec.status = 'error';
      rec.failureReason = this.initialFailureReason(a, unit);
      return;
    }
    // A new command supersedes whatever this unit was doing (only a plain move is
    // interruptible this way — the busy-guard blocks new work on a busy unit).
    const prev = this.unitAction.get(a.unitId);
    if (prev && prev.recId !== rec.id) {
      const pr = this.recordById(prev.recId);
      if (pr && pr.status === 'ongoing') pr.status = 'interrupted';
    }
    const info = {
      recId: rec.id,
      type: a.type,
      verb: unit.job?.verb,
      ...(a.type === 'move'
        ? { moveTotal: Math.max(1, Math.abs(unit.pos.x - a.to.x) + Math.abs(unit.pos.y - a.to.y)) }
        : {}),
    };
    this.unitAction.set(a.unitId, info);
    rec.status = 'ongoing';
    rec.progress = Host.jobProgress(this.world, unit, a, info);
  }

  /** Explain an action that applyAction rejected without starting a job. This
   *  runs immediately after application, while the world still contains the
   *  evidence needed to make the reason useful to a player. */
  private initialFailureReason(action: Action, unit: Unit): string {
    if (unit.job || unit.craftJob || unit.buildJob) return 'Unit is busy with another task.';
    switch (action.type) {
      case 'move':
        return 'Destination is outside the world.';
      case 'harvest': {
        const object = tileAt(this.world, action.target.x, action.target.y)?.object;
        if (!object) return 'There is no resource to harvest there.';
        const required = HARVEST_RULES[object.kind]?.require;
        return required && !unit.tools.includes(required)
          ? `Requires a ${required}.`
          : 'No reachable tile is adjacent to the resource.';
      }
      case 'craft': {
        const recipe = RECIPES[action.recipe];
        if (!recipe) return 'Unknown recipe.';
        if (unit.tools.includes(action.recipe)) return `Unit already has a ${action.recipe}.`;
        return 'Missing required crafting materials.';
      }
      case 'build': {
        if (!BUILDINGS[action.building]) return 'Unknown building type.';
        const tile = tileAt(this.world, action.at.x, action.at.y);
        if (!tile || tile.object || tile.building) return 'Build site is not clear.';
        return 'Missing materials or no reachable tile is adjacent to the build site.';
      }
      case 'drop':
        return action.item ? `Unit has no ${action.item} to drop.` : 'Unit has nothing to drop, or the target is unreachable.';
      case 'pickup':
        return 'Nothing can be picked up there, or the target is unreachable.';
      case 'dropNearby':
      case 'cancel':
        return 'Action could not be completed.';
    }
  }

  /** After a tick, resolve any in-flight action whose job has ended: match the
   *  unit's current state against the action's intent. Called once per tick, so
   *  a job that completed or aborted this tick is attributed immediately. */
  private reconcileActionStatus(): void {
    for (const [unitId, info] of [...this.unitAction]) {
      const rec = this.recordById(info.recId);
      if (!rec || rec.status !== 'ongoing') {
        this.unitAction.delete(unitId);
        continue;
      }
      const unit = this.world.units[unitId];
      if (!unit) {
        rec.status = 'error';
        rec.failureReason = 'Unit no longer exists.';
        this.unitAction.delete(unitId);
        continue;
      }
      const a = rec.action;
      let outcome: ActionStatus | null = null; // null = still ongoing
      if (a.type === 'move') {
        if (unit.moveGoal && Host.coordEq(unit.moveGoal, a.to)) outcome = null;
        else {
          // The goal cleared: the unit either arrived or settled at the closest
          // reachable tile. A commanded tile is often unwalkable (a tree/rock the
          // player clicked toward), so stopping orthogonally adjacent counts as
          // arrived; only giving up two or more tiles away is a real failure.
          const dist = Math.abs(unit.pos.x - a.to.x) + Math.abs(unit.pos.y - a.to.y);
          outcome = dist <= 1 ? 'done' : 'error';
        }
      } else if (a.type === 'harvest') {
        if (unit.job && Host.coordEq(unit.job.target, a.target)) outcome = null;
        else if (info.verb === 'gather') outcome = 'done'; // fruit taken (tree stays)
        else {
          const obj = tileAt(this.world, a.target.x, a.target.y)?.object;
          outcome = !obj || (obj.hp ?? 1) <= 0 ? 'done' : 'error'; // depleted vs abandoned
        }
      } else if (a.type === 'craft') {
        // Non-interruptible; cancel is handled at cancel time, so a cleared job
        // means it ran to completion.
        outcome = unit.craftJob ? null : 'done';
      } else if (a.type === 'build') {
        if (unit.buildJob) outcome = null;
        else outcome = tileAt(this.world, a.at.x, a.at.y)?.building ? 'done' : 'error';
      } else if (a.type === 'drop' || a.type === 'pickup') {
        // Still walking to the tile? ongoing. Otherwise the transfer ran when it
        // reached the tile (done); if the job was dropped mid-walk (unreachable)
        // the unit never got there → error.
        if (unit.haulJob) outcome = null;
        else outcome = this.haulArrived(unit, a.at) ? 'done' : 'error';
      }
      if (outcome) {
        rec.status = outcome;
        if (outcome === 'error') rec.failureReason = this.completionFailureReason(a, unit);
        rec.progress = undefined; // finished — drop the bar
        this.unitAction.delete(unitId);
      } else {
        rec.progress = Host.jobProgress(this.world, unit, a, info); // still running
      }
    }
  }

  /** Explain a job that began successfully but later lost the ability to
   *  complete. */
  private completionFailureReason(action: Action, unit: Unit): string {
    switch (action.type) {
      case 'move': return 'Unit could not reach the destination.';
      case 'harvest': {
        const object = tileAt(this.world, action.target.x, action.target.y)?.object;
        if (!object) return 'Resource was removed before harvest could finish.';
        const required = HARVEST_RULES[object.kind]?.require;
        return required && !unit.tools.includes(required)
          ? `Unit no longer has the required ${required}.`
          : 'Unit could no longer reach the resource.';
      }
      case 'build': return 'Build site became unavailable or could no longer be reached.';
      case 'drop': return 'Unit could not reach the drop target.';
      case 'pickup': return 'Unit could not reach the pickup target.';
      case 'craft': return 'Crafting did not complete.';
      case 'dropNearby':
      case 'cancel': return 'Action could not be completed.';
    }
  }

  /** Current progress of the job an ongoing action is running, for the Actions
   *  panel's bar. Harvest measures the target object's remaining hp against its
   *  starting hp; craft/build read the job's own tick counter. A plain move has
   *  no measurable duration → undefined (no bar). */
  private static jobProgress(
    world: World,
    unit: Unit,
    a: Action,
    info: { moveTotal?: number },
  ): { remaining: number; total: number } | undefined {
    if (a.type === 'move') {
      const remaining = Math.abs(unit.pos.x - a.to.x) + Math.abs(unit.pos.y - a.to.y);
      return { remaining, total: info.moveTotal ?? Math.max(1, remaining) };
    }
    if (a.type === 'harvest') {
      const obj = tileAt(world, a.target.x, a.target.y)?.object;
      if (!obj) return undefined;
      const total = OBJECT_HP[obj.kind] ?? obj.hp;
      return { remaining: Math.max(0, obj.hp), total };
    }
    if (a.type === 'craft' && unit.craftJob) {
      const j = unit.craftJob;
      return { remaining: j.remaining, total: j.total ?? j.remaining };
    }
    if (a.type === 'build' && unit.buildJob) {
      const j = unit.buildJob;
      return { remaining: j.remaining, total: j.total ?? j.remaining };
    }
    return undefined;
  }

  /** Upgrade pre-counter UUID request IDs from older saves. The old IDs are
   * mapped consistently into this host's integer sequence, including saved Test
   * Suite rows that reference them. */
  private migrateAiRequestIds(): void {
    const remap = new Map<string, number>();
    let next = this.aiRequestSeq;
    for (const exchanges of this.aiHistory.values()) {
      for (const exchange of exchanges) {
        const raw = (exchange as unknown as { id: unknown }).id;
        const id = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : ++next;
        next = Math.max(next, id);
        remap.set(String(raw), id);
        exchange.id = id;
      }
    }
    for (const result of this.aiTestResults) {
      const raw = (result as unknown as { exchangeId: unknown }).exchangeId;
      const known = remap.get(String(raw));
      const id = known ?? (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : ++next);
      next = Math.max(next, id);
      result.exchangeId = id;
    }
    this.aiRequestSeq = next;
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
        aiTestResults: this.aiTestResults,
        aiRequestSeq: this.aiRequestSeq,
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

  /** Complete prior model exchanges become real user/assistant messages. The
   * newest user turn alone carries the current world snapshot. */
  private recentConversation(): AiExchange[] {
    const list = this.aiHistory.get(ORCHESTRATOR_AGENT) ?? [];
    return list.slice(-12);
  }

  /** Record what a player currently sees on screen, from their `camera` report.
   *  Pure view-state (kept off the World). Sanitizes to finite numbers and
   *  clamps the center into world bounds; a report with any non-finite field is
   *  ignored. Keyed by peerId so a reconnecting/renaming player overwrites their
   *  own entry, and dropped on disconnect (forgetPlayer). */
  setPlayerCamera(peerId: string, name: string, cam: { cx: number; cy: number; w: number; h: number }): void {
    const { cx, cy, w, h } = cam;
    if (![cx, cy, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    this.playerCameras.set(peerId, {
      name,
      cx: Math.max(0, Math.min(this.world.width - 1, cx)),
      cy: Math.max(0, Math.min(this.world.height - 1, cy)),
      w: Math.max(0, w),
      h: Math.max(0, h),
    });
  }

  /** Forget a disconnected player's camera so it stops feeding the prompt. */
  forgetPlayer(peerId: string): void {
    this.playerCameras.delete(peerId);
  }

  /** The camera reports to feed the prompt, limited to players currently on the
   *  roster (a stale entry can't leak a departed player's view into context). */
  private camerasFor(roster: string[]): PlayerCameraView[] {
    const online = new Set(roster);
    return [...this.playerCameras.values()].filter((c) => online.has(c.name));
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
    const requestId = ++this.aiRequestSeq;
    this.dirty = true; // retain the sequence even if history is cleared later.

    const pending: AiPending = {
      id: requestId,
      agent: ORCHESTRATOR_AGENT,
      command: text,
      submitter: onBehalfOf,
      tick: this.world.tick,
    };
    this.pendingList().push(pending);
    this.broadcast({ m: 'aiEvent', agent: ORCHESTRATOR_AGENT });

    await runOrchestrator({
      command: text,
      submitter: onBehalfOf,
      context: () => ({
        world: fogWorld(this.world), // the AI plans over only what units can see
        roster,
        history: this.recentConversation(),
        memory: this.aiMemory,
        cameras: this.camerasFor(roster),
        voice: this.aiVoice,
      }),
      // Runs INSIDE the AI queue slot, before the next queued command builds its
      // prompt — so everything this command changed (memory, conversation
      // history, the world) is visible to the following command. Committing this
      // after the await instead would let a back-to-back command build against
      // stale state and emit a byte-identical prompt (blowing the KV-cache).
      commit: (result) => this.commitExchange(source, onBehalfOf, pending, result),
    });
  }

  /** File a finished orchestrator exchange: apply its memory ops, drop it from
   *  pending, record it in history, dispatch its actions, and nudge the asking
   *  player's camera. Called from within the AI queue slot (see runCommand's
   *  `commit`) so it fully lands before the next queued command assembles. */
  private commitExchange(
    source: ActionSource,
    onBehalfOf: string | undefined,
    pending: AiPending,
    result: RunResult,
  ): void {
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
      id: pending.id,
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

    // A setView moves ONLY the requesting player's on-screen camera, and only
    // when a real player issued the command (an autonomous/AI-triggered command
    // has no peer to move). This never touches the World — it's a targeted view
    // nudge delivered to that one peer. If the model emitted several, the last
    // one wins (its final intent).
    if (source.kind === 'player' && result.viewCommands.length) {
      const v = result.viewCommands[result.viewCommands.length - 1];
      const msg: HostMsg = { m: 'setCamera' };
      if (v.center) {
        msg.cx = v.center.x;
        msg.cy = v.center.y;
      }
      if (v.tilesAcross != null) msg.tilesAcross = v.tilesAcross;
      this.sendTo(source.peerId, msg);
    }
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

  /** Replay a saved prompt with temporary settings. Deliberately does not parse
   * the response, mutate history/memory, persist, or dispatch any actions. */
  async runAiTest(agent: string, exchangeId: number, settings: AiTestSettings): Promise<AiTestResult> {
    const submittedAt = Date.now();
    const exchange = (this.aiHistory.get(agent) ?? []).find((x) => x.id === exchangeId);
    const fail = (error: string): AiTestResult => ({ exchangeId, submittedAt, settings, text: '', ms: 0, error, status: 'complete' });
    if (agent !== ORCHESTRATOR_AGENT || !exchange) return this.recordAiTest(agent, fail('Recorded test data was not found.'));
    if (settings.model !== ollama.model && !ollama.availableModels.includes(settings.model)) return this.recordAiTest(agent, fail('Selected model is not installed.'));
    if (!/^(0|[1-9][0-9]*[smh])$/.test(settings.keepAlive)) return this.recordAiTest(agent, fail('Invalid keep-alive duration.'));
    const limits: Record<string, [number, number]> = {
      temperature: [0, 2], top_k: [1, 200], top_p: [0, 1], min_p: [0, 1],
      repeat_penalty: [0, 2], repeat_last_n: [-1, 32768], seed: [0, 2147483647],
      num_predict: [-1, 4096], num_ctx: [512, 32768],
    };
    const options = Object.fromEntries(
      Object.entries(settings.options).filter(([key, value]) => {
        const limit = limits[key];
        return limit !== undefined && Number.isFinite(value) && value >= limit[0] && value <= limit[1];
      }),
    );
    const result: AiTestResult = {
      exchangeId, submittedAt, settings: { ...settings, options }, text: '', ms: 0, status: 'queued',
    };
    this.recordAiTest(agent, result);
    try {
      const { text, ms, stats, rawRequest, rawResponse } = await ollama.chat(replayMessages(exchange.input), {
        model: settings.model,
        keepAlive: settings.keepAlive,
        think: settings.think,
        options,
        onStart: () => {
          result.status = 'running';
          this.updateAiTest(agent, result);
        },
      });
      const parsed = exchange.input.validationWorld
        ? parseResponse(text, exchange.input.validationWorld)
        : undefined;
      Object.assign(result, {
        text, ms, rawRequest, rawResponse, stats,
        ...(parsed ? { validation: { actions: parsed.actions.length, views: parsed.viewCommands.length, rejected: parsed.rejected } } : {}),
        status: 'complete' as const,
      });
      return this.updateAiTest(agent, result);
    } catch (err) {
      Object.assign(result, { error: (err as Error).message, status: 'complete' as const });
      return this.updateAiTest(agent, result);
    }
  }

  /** Append the selected history exchange as a fixed comparison baseline. */
  addAiTestOriginal(agent: string, exchangeId: number): void {
    const exchange = (this.aiHistory.get(agent) ?? []).find((x) => x.id === exchangeId);
    if (agent !== ORCHESTRATOR_AGENT || !exchange) return;
    this.recordAiTest(agent, {
      exchangeId,
      original: true,
      status: 'complete',
      submittedAt: Date.now(),
      settings: { model: exchange.output.stats?.model ?? ollama.model, keepAlive: '—', think: false, options: {} },
      text: exchange.output.raw,
      ms: exchange.ms,
      validation: {
        actions: exchange.output.actions.length,
        views: exchange.output.viewCommands?.length ?? 0,
        rejected: exchange.output.warnings ?? [],
      },
      stats: exchange.output.stats,
    });
  }

  private recordAiTest(agent: string, result: AiTestResult): AiTestResult {
    this.aiTestResults.push(result);
    if (this.aiTestResults.length > AI_TEST_RESULTS_MAX) {
      this.aiTestResults.splice(0, this.aiTestResults.length - AI_TEST_RESULTS_MAX);
    }
    return this.updateAiTest(agent, result);
  }

  private updateAiTest(agent: string, result: AiTestResult): AiTestResult {
    this.dirty = true;
    this.save(); // Test Suite runs are deliberate audit data; persist at once.
    this.broadcast({ m: 'aiEvent', agent });
    return result;
  }

  clearAiTests(agent: string): void {
    if (agent !== ORCHESTRATOR_AGENT || this.aiTestResults.length === 0) return;
    this.aiTestResults = [];
    this.dirty = true;
    this.save();
    this.broadcast({ m: 'aiEvent', agent });
  }

  /** Build the aiHistory reply for a requested agent (history + prompt config
   *  + the roster of known agents for the window's selector). */
  aiHistoryMsg(agent: string, roster: string[] = []): HostMsg {
    // Keep full validation worlds on the host/save, not in every browser's
    // History payload.
    const exchanges = (this.aiHistory.get(agent) ?? []).map(({ input, ...exchange }) => {
      const { validationWorld: _validationWorld, ...publicInput } = input;
      return { ...exchange, input: publicInput };
    });
    return {
      m: 'aiHistory',
      agent,
      agents: [ORCHESTRATOR_AGENT],
      exchanges,
      // Preview matches what the AI actually sees: same fogged world, live
      // roster, recent conversation, and saved memory the real call assembles.
      config: orchestratorConfig(fogWorld(this.world), {
        memory: this.aiMemory,
        roster,
        history: this.recentConversation(),
        cameras: this.camerasFor(roster),
        voice: this.aiVoice,
      }),
      pending: this.aiPending.get(agent) ?? [],
      memory: this.aiMemory,
      memoryLog: this.aiMemoryLog,
      testResults: this.aiTestResults,
    };
  }

  /** Build the live AI runtime status: a fresh `ollama ps` (resident models +
   *  daemon reachability), whether the active model is among them or still
   *  warming, and the host's memory/CPU. Async — it probes the daemon live. */
  async aiStatusMsg(agent: string): Promise<HostMsg> {
    const [{ daemonUp, loaded }, host] = await Promise.all([ollama.runtime(), hostResources()]);
    const active = ollama.model;
    return {
      m: 'aiStatus',
      agent,
      status: {
        daemonUp,
        activeModel: active,
        activeLoaded: loaded.some((l) => l.name === active),
        warming: ollama.isWarming,
        loaded,
        host,
      },
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
    this.aiTestResults = [];
    this.memoryRev = 0;
    this.actionLog = [];
    this.unitAction.clear();
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
    this.reconcileActionStatus(); // attribute any job that finished/aborted this tick
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
