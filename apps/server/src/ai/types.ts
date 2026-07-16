// Host-side AI plumbing types. Kept separate from @game/shared's transport
// types: these describe how we TALK to Ollama, not what we ship to browsers.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  /** The model's response text. */
  text: string;
  /** Round-trip latency in milliseconds. */
  ms: number;
}
