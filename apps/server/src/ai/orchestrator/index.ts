// The main game orchestrator agent: player command -> Ollama -> Action[].
// It only PRODUCES actions and an audit record; the host is what dispatches
// them through applyAction (same path as UI clicks) and stamps id/tick.
import { MODEL, chatSettings, ollama } from '../client.js';
import type { ChatOptions } from '../client.js';
import { assemble } from './prompt.js';
import { parseResponse } from './parse.js';
import { DEFAULT_VOICE, voiceOptions } from './voice.js';
import { ORCHESTRATOR_AGENT } from '@game/shared';
import type {
  Action,
  AiConfigView,
  AiExchange,
  ConversationTurn,
  MemoryOp,
  World,
} from '@game/shared';

export { ORCHESTRATOR_AGENT };

// The tuning for orchestrator calls, in one place so the request and the
// Config-tab display can't disagree. A modest temperature (0.6, not 0) so the
// steward's in-character "msg" replies stay VARIED instead of collapsing to the
// same sentence every time; the JSON action shapes are constrained enough by
// the prompt that this bit of heat doesn't hurt obedience. Thinking OFF — gemma
// reasons on every call otherwise, ~28× slower for no gain on these short prompts.
const ORCHESTRATOR_OPTS: ChatOptions = { temperature: 0.6, think: false };

export interface RunResult {
  actions: Action[];
  input: AiExchange['input'];
  output: AiExchange['output'];
  ms: number;
  /** The memory edit ops the model committed this call, or undefined if it left
   *  memory alone. The host applies them against the colony's saved memory. */
  memoryOps?: MemoryOp[];
}

/** The live inputs a command needs to build its prompt. Resolved LAZILY (right
 *  before the request is sent) so a queued command sees fresh state. */
export interface OrchestratorContext {
  world: World;
  /** Names of players currently online (for the model's context). */
  roster?: string[];
  /** Recent conversation turns so the model has short-term memory. */
  history?: ConversationTurn[];
  /** The colony's saved memory (standing player preferences) at send-time. */
  memory?: string[];
  /** The active voice style id (or 'off') at send-time. */
  voice?: string;
}

export interface RunOrchestratorInput {
  /** The natural-language command to run. */
  command: string;
  /** Player who issued it, if any. */
  submitter?: string;
  /** Called when the command reaches the front of the AI queue, to snapshot the
   *  world/roster/conversation at send-time rather than submit-time. */
  context: () => OrchestratorContext;
}

/** Run one command through the model and return the planned actions plus a
 *  fully-populated audit payload (never throws — errors land in output.error).
 *  The prompt is assembled inside the AI queue (see `context`), so a command
 *  that waited behind others reflects the world as it is when actually sent. */
export async function runOrchestrator(input: RunOrchestratorInput): Promise<RunResult> {
  const { command, submitter, context } = input;

  // Populated when the deferred build runs; captured for the audit record and
  // for validating the response against the exact world we sent.
  let record: AiExchange['input'] | undefined;
  let worldAtSend: World | undefined;

  const build = (): ReturnType<typeof assemble>['messages'] => {
    const { world, roster = [], history = [], memory = [], voice } = context();
    worldAtSend = world;
    const { messages, raw, parts } = assemble(world, {
      command,
      submitter,
      roster,
      history,
      memory,
      voice,
    });
    record = { command, onBehalfOf: submitter, raw, parts };
    return messages;
  };

  try {
    const { text, ms, stats } = await ollama.chatDeferred(build, ORCHESTRATOR_OPTS);
    const { actions, msg, memoryOps } = parseResponse(text, worldAtSend!);
    const output: AiExchange['output'] = { raw: text, actions, stats };
    if (msg) output.msg = msg;
    if (memoryOps !== undefined) output.memoryOps = memoryOps;
    return { actions, input: record!, output, ms, memoryOps };
  } catch (err) {
    // If we failed before assembling (e.g. daemon down), build a record now so
    // the exchange is still auditable.
    if (!record) {
      const { world, roster = [], history = [], memory = [], voice } = context();
      const { raw, parts } = assemble(world, { command, submitter, roster, history, memory, voice });
      record = { command, onBehalfOf: submitter, raw, parts };
    }
    return {
      actions: [],
      input: record,
      output: { raw: '', actions: [], error: (err as Error).message },
      ms: 0,
    };
  }
}

/** The Config-tab view: exactly what we'd send RIGHT NOW, with the command left
 *  as a placeholder. Takes the same live roster/history/memory the real call
 *  does so the preview reflects reality (roster, recent conversation, saved
 *  memory) rather than an empty template. */
export function orchestratorConfig(
  world: World,
  ctx: {
    memory?: string[];
    roster?: string[];
    history?: ConversationTurn[];
    voice?: string;
  } = {},
): AiConfigView {
  const { memory = [], roster = [], history = [], voice = DEFAULT_VOICE } = ctx;
  const { raw, parts } = assemble(world, { memory, roster, history, voice });
  return {
    agent: ORCHESTRATOR_AGENT,
    model: MODEL,
    raw,
    parts,
    settings: chatSettings(ORCHESTRATOR_OPTS),
    voices: voiceOptions(),
    voice,
  };
}
