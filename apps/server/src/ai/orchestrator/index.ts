// The main game orchestrator agent: player command -> Ollama -> Action[].
// It only PRODUCES actions and an audit record; the host is what dispatches
// them through applyAction (same path as UI clicks) and stamps id/tick.
import { MODEL, ollama } from '../client.js';
import { assemble } from './prompt.js';
import { parseResponse } from './parse.js';
import { ORCHESTRATOR_AGENT } from '@game/shared';
import type {
  Action,
  AiConfigView,
  AiExchange,
  ConversationTurn,
  World,
} from '@game/shared';

export { ORCHESTRATOR_AGENT };

export interface RunResult {
  actions: Action[];
  input: AiExchange['input'];
  output: AiExchange['output'];
  ms: number;
}

/** The live inputs a command needs to build its prompt. Resolved LAZILY (right
 *  before the request is sent) so a queued command sees fresh state. */
export interface OrchestratorContext {
  world: World;
  /** Names of players currently online (for the model's context). */
  roster?: string[];
  /** Recent conversation turns so the model has short-term memory. */
  history?: ConversationTurn[];
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
    const { world, roster = [], history = [] } = context();
    worldAtSend = world;
    const { messages, raw, parts } = assemble(world, { command, submitter, roster, history });
    record = { command, onBehalfOf: submitter, raw, parts };
    return messages;
  };

  try {
    const { text, ms } = await ollama.chatDeferred(build, { temperature: 0 });
    const { actions, msg } = parseResponse(text, worldAtSend!);
    return { actions, input: record!, output: { raw: text, actions, msg }, ms };
  } catch (err) {
    // If we failed before assembling (e.g. daemon down), build a record now so
    // the exchange is still auditable.
    if (!record) {
      const { world, roster = [], history = [] } = context();
      const { raw, parts } = assemble(world, { command, submitter, roster, history });
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

/** The Config-tab view: the current prompt template (command left as a
 *  placeholder) shown raw and sectioned. */
export function orchestratorConfig(world: World): AiConfigView {
  const { raw, parts } = assemble(world);
  return { agent: ORCHESTRATOR_AGENT, model: MODEL, raw, parts };
}
