// Shapes shared with clients so the AI History window can render everything we
// sent to a model and everything it returned. These are transport/inspection
// types — the host produces them, browsers only display them. Prompt assembly
// itself lives host-side in apps/server/src/ai.
import type { Action } from './actions.js';

/** The one built-in agent id. Lives here (not server-only) so the web client
 *  can request/auto-refresh its history without duplicating the string. */
export const ORCHESTRATOR_AGENT = 'orchestrator';

/** A single edit to the colony's standing memory. The model (and the Memory
 *  tab) address existing items by their 1-based `id` — the number shown in the
 *  prompt's Memory list — so a change is a few tiny ops instead of re-sending
 *  the whole list (which, once memory is large, would dominate output tokens).
 *   - add:  append a new standing preference
 *   - edit: replace item `id`'s text
 *   - del:  remove item `id` */
export type MemoryOp =
  | { op: 'add'; text: string }
  | { op: 'edit'; id: number; text: string }
  | { op: 'del'; id: number };

/** One entry in the memory audit log: what changed, when, by whom, and the full
 *  resulting list. Append-only + persisted, so memory edits can be reviewed
 *  over time in the Memory tab. */
export interface MemoryRevision {
  /** Monotonic revision number (1-based), stable even as the log is capped. */
  rev: number;
  /** Epoch ms the change was applied (host clock; informational). */
  at: number;
  /** World tick at the change. */
  tick: number;
  /** Who caused it: a player name, or 'AI' for a model-driven change. */
  by?: string;
  /** For an AI change (`by === 'AI'`), the player whose command prompted it.
   *  Absent for manual edits (the player is already in `by`). */
  via?: string;
  /** The ops applied in this revision (the ones that actually took effect). */
  ops: MemoryOp[];
  /** The complete memory list AFTER applying this revision. */
  after: string[];
}

/** One turn of the shared colony conversation, fed back to the model as recent
 *  context so players can reference what was just said. `who` is a player name
 *  or 'AI'. */
export interface ConversationTurn {
  who: string;
  text: string;
}

/** A command that's been accepted by the host but not yet answered by the
 *  model — either running (front of the queue) or waiting behind others. Shown
 *  live in the chat so submitters see their command land immediately and can
 *  watch the queue drain. Becomes an `AiExchange` once the model responds. */
export interface AiPending {
  id: string;
  agent: string;
  /** The natural-language command as submitted. */
  command: string;
  /** Player who issued it, if any. */
  submitter?: string;
  /** World tick when it was accepted. */
  tick: number;
}

/** One labeled section of a prompt (e.g. "System", "Action schema", "World",
 *  "Command"). The "pretty" config/history view renders these as cards; the
 *  raw view concatenates their `content` in order. */
export interface AiPromptPart {
  label: string;
  content: string;
}

/** Per-call model telemetry, lifted from the daemon's response. All optional:
 *  a failed call (or a backend that doesn't report a field) simply omits it.
 *  Durations are milliseconds; token counts are whole tokens. */
export interface AiStats {
  /** The model tag the daemon actually ran (may differ from the requested one). */
  model?: string;
  /** Prompt/input tokens the model read (Ollama `prompt_eval_count`). */
  promptTokens?: number;
  /** Generated/output tokens (Ollama `eval_count`). */
  outputTokens?: number;
  /** Wall-clock the daemon reported for the whole request (`total_duration`). */
  totalMs?: number;
  /** Time spent loading the model into memory (`load_duration`); ~0 when warm. */
  loadMs?: number;
  /** Time evaluating the prompt / filling the KV cache (`prompt_eval_duration`). */
  promptMs?: number;
  /** Time generating the response (`eval_duration`). */
  evalMs?: number;
  /** Output tokens per second during generation (eval_count / eval_duration). */
  tokensPerSec?: number;
  /** Why generation stopped (`done_reason`: "stop", "length", …). */
  doneReason?: string;
}

/** The exact request knobs we hand the model backend for a call — surfaced in
 *  the Config tab so players can see (not guess) how the AI is tuned. `options`
 *  is the verbatim options object sent to the daemon (temperature, and any
 *  future num_ctx / think / etc.). */
export interface AiSettings {
  model: string;
  /** How long the backend keeps the model resident between calls. */
  keepAlive: string;
  /** Whether the model's chain-of-thought is enabled. Off by default — see the
   *  note in the Config UI: if turned on, the response's thinking text must be
   *  captured to be shown. */
  think: boolean;
  /** The verbatim `options` payload sent per request. */
  options: Record<string, unknown>;
}

/** A single request/response round-trip with an AI agent, for the History tab.
 *  Captures exactly what went out and came back so a run is fully auditable. */
export interface AiExchange {
  id: string;
  agent: string;
  /** World tick when the command was issued. */
  tick: number;
  input: {
    /** The player command, or '(autonomous)' when self-directed. */
    command: string;
    /** Player who issued it, if any. */
    onBehalfOf?: string;
    /** The exact prompt string sent to the model (View Raw). */
    raw: string;
    /** The same prompt, broken into labeled sections (View Pretty). */
    parts: AiPromptPart[];
  };
  output: {
    /** Verbatim model response text. */
    raw: string;
    /** Actions parsed + accepted from the response. */
    actions: Action[];
    /** Optional natural-language reply to the players (the model may omit it
     *  when a command needs no words). Shown in the chat + history. */
    msg?: string;
    /** Set when the call or parse failed. */
    error?: string;
    /** Model telemetry for this call (tokens, per-stage timings). Absent on a
     *  failure that never reached the model. */
    stats?: AiStats;
    /** The memory edit ops the model committed on this call, if it changed
     *  memory. Absent when memory was left unchanged — the common case. */
    memoryOps?: MemoryOp[];
  };
  /** Round-trip latency in milliseconds. */
  ms: number;
}

/** One selectable voice style for the Config tab's Voice picker. `id` is what
 *  the client sends back to switch to it ('off' disables the Voice section). */
export interface AiVoiceOption {
  id: string;
  label: string;
}

/** The Config tab payload for an agent: the current prompt template shown two
 *  ways. `raw` is exactly what we assemble and send (minus the live command);
 *  `parts` is the same content sectioned for the friendly view. */
export interface AiConfigView {
  agent: string;
  model: string;
  raw: string;
  parts: AiPromptPart[];
  /** The request knobs currently in effect for this agent's calls. */
  settings: AiSettings;
  /** Model tags the daemon has installed, for the Config-tab model picker
   *  (snapshotted once at host boot). The active one is `settings.model`. May be
   *  empty if the daemon was unreachable at boot — then no picker is shown. */
  models: string[];
  /** Every voice style the player can pick (incl. an 'off' entry), for the
   *  Config tab's Voice picker. */
  voices: AiVoiceOption[];
  /** The voice style currently active (an `voices[].id`, 'off' when disabled).
   *  Determines whether a "Voice" part appears above and what it contains. */
  voice: string;
}
