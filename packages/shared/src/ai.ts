// Shapes shared with clients so the AI History window can render everything we
// sent to a model and everything it returned. These are transport/inspection
// types — the host produces them, browsers only display them. Prompt assembly
// itself lives host-side in apps/server/src/ai.
import type { Action } from './actions.js';

/** The one built-in agent id. Lives here (not server-only) so the web client
 *  can request/auto-refresh its history without duplicating the string. */
export const ORCHESTRATOR_AGENT = 'orchestrator';

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
  };
  /** Round-trip latency in milliseconds. */
  ms: number;
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
}
