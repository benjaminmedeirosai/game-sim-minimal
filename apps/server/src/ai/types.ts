// Host-side AI plumbing types. Kept separate from @game/shared's transport
// types: these describe how we TALK to Ollama, not what we ship to browsers.
import type { AiPromptMessage, AiStats } from '@game/shared';

export type ChatMessage = AiPromptMessage;

export interface ChatResult {
  /** The model's response text. */
  text: string;
  /** Exact JSON request and response bodies. Test Suite runs retain these for
   * audit; normal game turns deliberately do not persist them. */
  rawRequest: string;
  rawResponse: string;
  /** Round-trip latency in milliseconds. */
  ms: number;
  /** Model telemetry the daemon reported (tokens, per-stage timings). */
  stats?: AiStats;
}
