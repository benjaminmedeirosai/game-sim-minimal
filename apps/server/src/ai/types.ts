// Host-side AI plumbing types. Kept separate from @game/shared's transport
// types: these describe how we TALK to Ollama, not what we ship to browsers.
import type { AiStats } from '@game/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  /** The model's response text. */
  text: string;
  /** Round-trip latency in milliseconds. */
  ms: number;
  /** Model telemetry the daemon reported (tokens, per-stage timings). */
  stats?: AiStats;
}
