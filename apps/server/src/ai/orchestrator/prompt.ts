// Prompt assembly for the game orchestrator. Ordered for Ollama's prompt cache:
// the STABLE prefix (role + action schema + registry ids) comes first and is
// byte-identical across calls; only the world snapshot and the user command —
// the LAST parts — change. That maximizes KV-cache reuse on a warm model.
import {
  BUILDINGS,
  DEFAULT_VISION_RADIUS,
  HARVEST_RULES,
  RECIPES,
  describeAction,
} from '@game/shared';
import type { AiPromptPart, ConversationTurn, World } from '@game/shared';
import type { ChatMessage } from '../types.js';

// --- Stable prefix -------------------------------------------------------

function recipeLines(): string {
  return Object.entries(RECIPES)
    .map(([id, r]) => {
      const cost = Object.entries(r.inputs)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return `  - ${id} (${r.label}): needs ${cost}`;
    })
    .join('\n');
}

function buildingLines(): string {
  return Object.entries(BUILDINGS)
    .map(([id, b]) => {
      const cost = Object.entries(b.inputs)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return `  - ${id} (${b.label}): needs ${cost}`;
    })
    .join('\n');
}

function harvestLines(): string {
  return Object.entries(HARVEST_RULES)
    .map(([kind, rule]) => {
      const bits: string[] = [];
      if (rule.require) bits.push(`requires ${rule.require}`);
      if (rule.boost) bits.push(`faster with ${rule.boost}`);
      return `  - ${kind}: ${bits.length ? bits.join('; ') : 'bare hands OK'}`;
    })
    .join('\n');
}

/** The system prompt: role, output contract, and the full action + registry
 *  reference. Deterministic given the registries, so it's cache-stable. */
export function systemPrompt(): string {
  return [
    'You are the shared AI assistant for a real-time tile-world colony game.',
    'Multiple players share one colony and one you. Turn the current command',
    'into a plan the simulation can execute, and optionally reply to the players.',
    '',
    'Respond with ONLY one JSON object, no markdown or code fences:',
    '  {"actions": [ ...action objects... ], "msg": "..."}',
    '',
    '  - "actions": the plan (may be [] when there is nothing to do).',
    '  - "msg": OPTIONAL short line to the players. Omit it (or use "") for',
    '    routine commands — most need no words. Include it only when useful:',
    '    to ask a clarifying question, report you could not do something, or',
    '    note something worth flagging. Do not narrate every action. Address a',
    '    player by name when replying to them.',
    '',
    'Action shapes:',
    '  {"type":"move","unitId":"<id>","to":{"x":<int>,"y":<int>}}',
    '  {"type":"harvest","unitId":"<id>","target":{"x":<int>,"y":<int>}}',
    '  {"type":"craft","unitId":"<id>","recipe":"<id>"}',
    '  {"type":"build","unitId":"<id>","building":"<id>","at":{"x":<int>,"y":<int>}}',
    '',
    'harvest works the object on the target tile (chop tree / mine rock or ore /',
    'gather fruit); the verb is inferred from what is there.',
    '',
    'Recipes (craft):',
    recipeLines(),
    'Buildings (build):',
    buildingLines(),
    'Harvest rules:',
    harvestLines(),
    '',
    'Fog of war:',
    `  - Each unit only sees tiles within ${DEFAULT_VISION_RADIUS} tiles of itself.`,
    '  - The resource lists show ONLY objects currently in some unit\'s sight.',
    '    Anything beyond that is unknown — it may exist but is not listed.',
    '  - To find more resources, move a unit to scout unexplored ground first.',
    '',
    'Rules:',
    '  - Use only unit ids that exist in the world snapshot.',
    '  - Mining ore REQUIRES a pickaxe — craft one first if no unit has it.',
    '  - Coordinates must be inside the world bounds.',
    '  - Prefer the nearest suitable unit/target when the command is vague.',
    '  - Do not invent resource coordinates the snapshot does not list.',
  ].join('\n');
}

// --- Dynamic tail --------------------------------------------------------

/** A compact, model-friendly snapshot of the world: every unit in full, plus
 *  EVERY harvestable target currently in vision, listed by coordinate. The fog
 *  already bounds this to what units can see, so the list stays small; if it
 *  ever grows too large we'll sample/summarize then, not pre-emptively. */
export function worldContext(world: World): string {
  const units = Object.values(world.units).map((u) => {
    const inv = Object.entries(u.inventory)
      .map(([k, n]) => `${k}:${n}`)
      .join(',') || 'empty';
    const tools = u.tools.length ? u.tools.join(',') : 'none';
    const busy = u.job
      ? `${u.job.verb}@(${u.job.target.x},${u.job.target.y})`
      : u.craftJob
        ? `craft ${u.craftJob.recipe}`
        : u.buildJob
          ? `build ${u.buildJob.building}`
          : 'idle';
    return `  ${u.id} at (${u.pos.x},${u.pos.y}) inv[${inv}] tools[${tools}] ${busy}`;
  });

  const coords: Record<string, string[]> = { tree: [], rock: [], ore: [] };
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const obj = world.tiles[y * world.width + x]?.object;
      if (!obj) continue;
      coords[obj.kind]?.push(`(${x},${y})`);
    }
  }
  const resources = Object.keys(coords).map(
    (k) => `  ${k}: ${coords[k]!.length} visible${coords[k]!.length ? ` at ${coords[k]!.join(' ')}` : ''}`,
  );

  const builds = Object.values(world.buildings).map(
    (b) => `  ${b.type}@(${b.pos.x},${b.pos.y})`,
  );

  return [
    `World ${world.width}x${world.height}, tick ${world.tick}.`,
    'Units:',
    ...units,
    'Resources your units can currently see (fog of war hides the rest):',
    ...resources,
    builds.length ? 'Buildings:' : 'Buildings: none',
    ...builds,
  ].join('\n');
}

/** The players sharing the colony, and who issued the current command. */
export function rosterContext(roster: string[], submitter?: string): string {
  const online = roster.length ? roster.join(', ') : '(none listed)';
  const from = submitter
    ? `This command is from ${submitter}.`
    : 'This command is autonomous (no player).';
  return [`Players online: ${online}.`, from].join('\n');
}

/** The last few conversation turns so the model has short-term memory (a player
 *  can say "do that again" or "the one I mentioned"). */
export function historyContext(history: ConversationTurn[]): string {
  if (history.length === 0) return '(no earlier messages)';
  return history.map((t) => `${t.who}: ${t.text}`).join('\n');
}

export interface AssembleInput {
  /** The live command; omitted for the Config-tab template. */
  command?: string;
  /** Player name who issued it. */
  submitter?: string;
  /** Names of players currently online. */
  roster?: string[];
  /** Recent conversation turns (oldest first). */
  history?: ConversationTurn[];
}

/** Assemble the full prompt, returning the messages to send, the exact raw
 *  string (for View Raw), and the labeled sections (View Pretty). Ordered for
 *  the prompt cache: the stable System prefix first, then the dynamic world /
 *  players / conversation / command tail. When `command` is omitted this yields
 *  the Config-tab template. */
export function assemble(
  world: World,
  input: AssembleInput = {},
): { messages: ChatMessage[]; raw: string; parts: AiPromptPart[] } {
  const { command, submitter, roster = [], history = [] } = input;
  const sys = systemPrompt();
  const ctx = worldContext(world);
  const players = rosterContext(roster, submitter);
  const convo = historyContext(history);
  const cmd = command ?? '<the player command goes here>';

  const parts: AiPromptPart[] = [
    { label: 'System', content: sys },
    { label: 'World context', content: ctx },
    { label: 'Players', content: players },
    { label: 'Recent conversation', content: convo },
    { label: 'Command', content: cmd },
  ];

  const userContent = [
    ctx,
    '',
    players,
    '',
    'Recent conversation:',
    convo,
    '',
    `Command: ${cmd}`,
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: userContent },
  ];

  const raw = parts.map((p) => `### ${p.label}\n${p.content}`).join('\n\n');
  return { messages, raw, parts };
}

// Re-export so the parser and callers phrase actions consistently.
export { describeAction };
