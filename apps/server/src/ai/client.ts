// THE single Ollama instance for the whole host. Every AI agent (the game
// orchestrator today, others later) routes through this one client, so:
//   - we hold ONE warm, resident model (long keep_alive) — no cold reloads,
//     and Ollama's KV/prompt cache stays hot between calls when we keep the
//     prompt prefix byte-identical;
//   - all calls are SERIAL (a single promise chain), so a small local model is
//     never contended and latency stays predictable.
// We talk to the daemon's HTTP API (/api/chat). We never use `ollama run` —
// that's an interactive REPL we can't drive. If the daemon is down at startup
// we try to spawn `ollama serve` ONCE, then fall back to a clear warning.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiLoadedModel, AiSettings } from '@game/shared';
import type { ChatMessage, ChatResult } from './types.js';

// One-line config knobs. GSM_AI_MODEL sets the model tag used until a player
// picks another one from the Config tab.
export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
export const DEFAULT_MODEL = process.env.GSM_AI_MODEL ?? 'gemma4:e4b';
// Pin the model resident for an hour so it never cold-loads mid-command.
const KEEP_ALIVE = '60m';
// The model's context window (tokens). Ollama defaults gemma to 4096, but our
// prompt (system + world + up to ~40 conversation turns) runs ~3.7k tokens and
// grows with the chat — overflowing 4096 makes Ollama context-SHIFT, which both
// silently drops the head of the prompt (our system rules!) and throws away the
// KV cache. We pin a roomier window so the whole prompt fits with headroom and
// the prefix cache stays intact call-to-call. Must be set on EVERY request
// (incl. warm-up) so the slot isn't reloaded with a different size mid-session.
const NUM_CTX = 8192;

export interface ChatOptions {
  /** Sampling temperature. 0 = deterministic; the orchestrator runs a little
   *  warmer (see ORCHESTRATOR_OPTS) so the steward's replies vary. */
  temperature?: number;
  /** Enable the model's chain-of-thought. Defaults to false: thinking-capable
   *  models (gemma among them) otherwise reason on every call, which costs
   *  ~28× the latency for no benefit on our short action-planning prompts. If
   *  ever turned on, capture `message.thinking` from the response to show it. */
  think?: boolean;
}

/** The verbatim `options` object we send the daemon for a given call — the
 *  single source of truth for both the request and the Config-tab display.
 *  (`think` is a top-level /api/chat field, not an option, so it's separate.) */
function requestOptions(opts: ChatOptions): Record<string, unknown> {
  return { temperature: opts.temperature ?? 0, num_ctx: NUM_CTX };
}

/** The tuning knobs currently in effect, for the Config tab. Mirrors exactly
 *  what rawChat() sends so the view can never drift from reality. */
export function chatSettings(opts: ChatOptions = {}): AiSettings {
  return {
    model: ollama.model,
    keepAlive: KEEP_ALIVE,
    think: opts.think ?? false,
    options: requestOptions(opts),
  };
}

/** Ollama's non-streaming /api/chat response, incl. the telemetry fields we
 *  surface. Durations are nanoseconds; counts are whole tokens. */
interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/** One row of the daemon's `/api/ps` (resident models). Sizes are bytes;
 *  `expires_at` is an ISO timestamp for the keep-alive unload. */
interface OllamaPsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

const nsToMs = (ns?: number): number | undefined =>
  ns == null ? undefined : Math.round(ns / 1e6);

class OllamaClient {
  /** Set once init() confirms (or starts) a reachable daemon. */
  private available = false;
  /** The serial tail: each chat() awaits the previous one. */
  private queue: Promise<unknown> = Promise.resolve();
  private didSpawn = false;
  /** True while a warm-up request is in flight (a fresh switch or boot). The
   *  Config tab's status card reads this to show "loading…" before the model is
   *  resident. */
  private warming = false;
  /** The model tag every call currently runs against. Starts at DEFAULT_MODEL;
   *  init() may swap in a persisted pick, and setModel() changes it live. */
  private currentModel = DEFAULT_MODEL;
  /** Model tags installed on the daemon, snapshotted once at init (the daemon's
   *  `/api/tags`, i.e. what `ollama list` shows). Empty until a reachable init. */
  private models: string[] = [];

  get isAvailable(): boolean {
    return this.available;
  }

  /** A warm-up is in flight (model switching / booting into memory). */
  get isWarming(): boolean {
    return this.warming;
  }

  /** The model tag in effect right now. */
  get model(): string {
    return this.currentModel;
  }

  /** Every model tag the daemon has installed (for the Config-tab picker). */
  get availableModels(): string[] {
    return this.models;
  }

  /** Health-check the daemon; if it's down, try to start it once; snapshot the
   *  installed models; then warm the model. `preferred` (a persisted pick) is
   *  honored only if the daemon actually has it. Safe at startup — never throws. */
  async init(preferred?: string): Promise<void> {
    if (await this.ping()) {
      this.available = true;
    } else {
      this.spawnServeOnce();
      this.available = await this.waitForUp();
    }
    if (this.available) {
      this.models = await this.fetchModels();
      if (preferred && this.models.includes(preferred)) this.currentModel = preferred;
      console.log(
        `[ai] Ollama ready at ${OLLAMA_URL} (model ${this.currentModel}` +
          `; ${this.models.length} installed)`,
      );
      void this.warm();
    } else {
      console.warn(
        `[ai] Ollama not reachable at ${OLLAMA_URL}. Start it with \`ollama serve\` ` +
          `and \`ollama pull ${this.currentModel}\`. AI commands will report this until it's up.`,
      );
    }
  }

  /** Switch the active model to `name` (must be one the daemon has installed).
   *  Warms the new model so the next command isn't cold. Returns whether it
   *  actually changed — false for an unknown tag or a no-op reselect. */
  setModel(name: string): boolean {
    if (!this.models.includes(name) || name === this.currentModel) return false;
    this.currentModel = name;
    void this.warm();
    return true;
  }

  /** Live snapshot of the daemon's resident models (`ollama ps`) plus a fresh
   *  reachability check — the status card polls this while the Config tab is
   *  open. Unlike `isAvailable` (set once at init), `daemonUp` here reflects
   *  right now: if the daemon died after boot, this reports it. Never throws. */
  async runtime(): Promise<{ daemonUp: boolean; loaded: AiLoadedModel[] }> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/ps`, { method: 'GET' });
      if (!res.ok) return { daemonUp: false, loaded: [] };
      const data = (await res.json()) as { models?: OllamaPsModel[] };
      const now = Date.now();
      const loaded = (data.models ?? []).map((m) => {
        const expMs = m.expires_at ? Date.parse(m.expires_at) : NaN;
        return {
          name: m.name ?? m.model ?? '?',
          sizeMB: m.size != null ? Math.round(m.size / 1e6) : undefined,
          vramMB: m.size_vram != null ? Math.round(m.size_vram / 1e6) : undefined,
          expiresInSec: Number.isFinite(expMs)
            ? Math.max(0, Math.round((expMs - now) / 1000))
            : undefined,
        };
      });
      return { daemonUp: true, loaded };
    } catch {
      return { daemonUp: false, loaded: [] };
    }
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The daemon's installed model tags, sorted. Empty on any error — a missing
   *  list just means the Config picker shows only the current model. */
  private async fetchModels(): Promise<string[]> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name?: string }[] };
      return (data.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .sort();
    } catch {
      return [];
    }
  }

  private spawnServeOnce(): void {
    if (this.didSpawn) return;
    this.didSpawn = true;
    try {
      console.log('[ai] Ollama down — trying `ollama serve`…');
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn(`[ai] could not spawn ollama: ${err.message}`));
      child.unref();
    } catch (err) {
      console.warn(`[ai] could not spawn ollama: ${(err as Error).message}`);
    }
  }

  private async waitForUp(): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      await delay(500);
      if (await this.ping()) return true;
    }
    return false;
  }

  /** Load the model into memory with a throwaway request so the first real
   *  command is fast. Failures are non-fatal (logged, not thrown). */
  private async warm(): Promise<void> {
    this.warming = true;
    try {
      await this.rawChat([{ role: 'user', content: 'ok' }], { temperature: 0 });
      console.log('[ai] model warmed');
    } catch (err) {
      console.warn(`[ai] warm-up failed: ${(err as Error).message}`);
    } finally {
      this.warming = false;
    }
  }

  /** Serial chat: awaits any in-flight call first, so the model is never hit
   *  concurrently. Throws with a clear message if the daemon is unavailable. */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const run = this.queue.then(() => {
      if (!this.available) {
        throw new Error(`Ollama is not running. Start it with \`ollama serve\` (model ${this.currentModel}).`);
      }
      return this.rawChat(messages, opts);
    });
    // Keep the chain alive even if this call rejects, so one failure doesn't
    // wedge every later command.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Like chat(), but the messages are BUILT the moment this call reaches the
   *  front of the serial queue — not when it was enqueued. So a command that
   *  waits behind others assembles its prompt against the freshest world/
   *  conversation state right before it's sent.
   *
   *  `finish` runs INSIDE the same queue slot, right after the response arrives
   *  and BEFORE the next queued command's build() fires. This ordering is load-
   *  bearing: it lets the caller commit this exchange to conversation history so
   *  the FOLLOWING command's prompt reflects it. Without it, two commands queued
   *  back-to-back both build() before either exchange lands in history, so they
   *  assemble byte-identical prompts — no growing conversation, and the KV-cache
   *  "expected diff" reads a bogus 100%. Same rejection-safe chaining; the queue
   *  tail waits for finish() too, so the next build() always sees the commit. */
  chatDeferred<T>(
    build: () => ChatMessage[],
    opts: ChatOptions,
    finish: (result: ChatResult) => T | Promise<T>,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.available) {
        throw new Error(`Ollama is not running. Start it with \`ollama serve\` (model ${this.currentModel}).`);
      }
      const result = await this.rawChat(build(), opts);
      return finish(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async rawChat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.currentModel,
        messages,
        stream: false,
        keep_alive: KEEP_ALIVE,
        think: opts.think ?? false,
        options: requestOptions(opts),
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    const evalCount = data.eval_count;
    const evalDur = data.eval_duration; // ns
    return {
      text: data.message?.content ?? '',
      ms: Date.now() - started,
      stats: {
        model: data.model,
        promptTokens: data.prompt_eval_count,
        outputTokens: evalCount,
        totalMs: nsToMs(data.total_duration),
        loadMs: nsToMs(data.load_duration),
        promptMs: nsToMs(data.prompt_eval_duration),
        evalMs: nsToMs(data.eval_duration),
        tokensPerSec:
          evalCount && evalDur ? Math.round((evalCount / evalDur) * 1e9) : undefined,
        doneReason: data.done_reason,
      },
    };
  }
}

// The shared singleton every agent imports.
export const ollama = new OllamaClient();
