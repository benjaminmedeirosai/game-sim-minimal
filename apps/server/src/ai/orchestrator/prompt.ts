// Prompt assembly for the game orchestrator. Ordered for Ollama's prompt cache:
// the STABLE prefix (role + action schema + registry ids) comes first and is
// byte-identical across calls; only the world snapshot and the user command —
// the LAST parts — change. That maximizes KV-cache reuse on a warm model.
import {
  BASE_TPS,
  BUILDINGS,
  DEFAULT_VISION_RADIUS,
  HARVEST_POWER,
  HARVEST_RULES,
  OBJECT_HP,
  RECIPES,
  TERRAIN_COLORS,
  describeAction,
  visibleTiles,
} from '@game/shared';
import type { AiPromptPart, Coord, ConversationTurn, World } from '@game/shared';
import type { ChatMessage } from '../types.js';
import { voicePrompt } from './voice.js';

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

// How much the matching tool speeds a harvest up (boosted vs. bare-handed
// chip rate) — 3× today. Derived so it tracks HARVEST_POWER automatically.
const TOOL_SPEEDUP = HARVEST_POWER.boosted / HARVEST_POWER.base;

/** Ticks to deplete `hp` at a given per-tick chip `power`, plus the wall-clock
 *  that is at normal (1×) game speed. Speeds > 1× shorten it proportionally. */
function workTime(hp: number, power: number): string {
  const ticks = Math.ceil(hp / power);
  const secs = Math.round((ticks / BASE_TPS) * 10) / 10;
  return `~${secs}s (${ticks} ticks)`;
}

function harvestLines(): string {
  return Object.entries(HARVEST_RULES)
    .map(([kind, rule]) => {
      const bits: string[] = [];
      const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'an' : 'a');
      if (rule.require) bits.push(`REQUIRES ${article(rule.require)} ${rule.require} (impossible without one)`);
      if (rule.boost && rule.boost !== rule.require) {
        bits.push(`${TOOL_SPEEDUP}× faster with ${article(rule.boost)} ${rule.boost}`);
      }
      return `  - ${kind}: ${bits.length ? bits.join('; ') : 'bare hands OK'}`;
    })
    .join('\n');
}

// One-line notes on each terrain type. Only water blocks movement; everything
// else is ordinary walkable ground. Keyed by TerrainType so a new terrain shows
// up automatically (with a generic note) rather than silently missing.
const TERRAIN_NOTES: Record<string, string> = {
  grass: 'plains — the default walkable land',
  dirt: 'bare earth — walkable',
  stone: 'rocky ground — walkable',
  sand: 'beach/shore, usually rings water — walkable',
  water: 'lake/river — BLOCKS movement; units cannot enter or cross it',
};

function terrainLines(): string {
  return Object.keys(TERRAIN_COLORS)
    .map((t) => `  - ${t}: ${TERRAIN_NOTES[t] ?? 'walkable'}`)
    .join('\n');
}

/** The object kinds a tile can hold, what harvesting each yields, and how long
 *  it takes (HP + work time by hand vs. with the matching tool) so the model can
 *  reason about durations. "fruit tree" isn't a distinct kind (it's a tree
 *  carrying fruit) but is listed so the model connects the label to a behavior.
 *  Work times exclude travel and are at normal (1×) game speed. */
function objectLines(): string {
  const base = HARVEST_POWER.base;
  const boosted = HARVEST_POWER.boosted;
  return [
    `  - tree: chop for wood (tree removed) — ${OBJECT_HP.tree} HP; ${workTime(OBJECT_HP.tree, base)} by hand, ${workTime(OBJECT_HP.tree, boosted)} with an axe`,
    '  - fruit tree: a tree bearing fruit — gather for fruit/food, instant (1 tick); tree stays standing',
    `  - rock: mine for stone — ${OBJECT_HP.rock} HP; ${workTime(OBJECT_HP.rock, base)} by hand, ${workTime(OBJECT_HP.rock, boosted)} with a pickaxe`,
    `  - ore: mine for metal ore (iron/copper/gold) — ${OBJECT_HP.ore} HP; REQUIRES a pickaxe, ${workTime(OBJECT_HP.ore, boosted)}`,
  ].join('\n');
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
    '  {"actions": [ ...action objects... ], "msg": "...", "memory": [ ...ops... ]}',
    '',
    '  - "actions": the plan (may be [] when there is nothing to do).',
    '  - "msg": a SHORT reply to the player — one brief line, spoken in the',
    '    colony\'s voice when a "Voice" section is given below (otherwise plain and',
    '    direct). Include one whenever you act on a PLAYER\'s command, or when you',
    '    have something real to say (a question, a refusal, a status note). Omit it',
    '    on autonomous ticks with no player, and never narrate every action or',
    '    repeat a line you have used before.',
    '  - "memory": OPTIONAL and OFF BY DEFAULT. OMIT this field on virtually every',
    '    command. When you DO change memory, send only a few tiny EDIT OPS — never',
    '    the whole list, and never lines that are staying the same. Each op is one',
    '    of:',
    '      {"op":"add","text":"<new preference>"}   add a new standing preference',
    '      {"op":"edit","id":<n>,"text":"<new text>"}   replace item #n',
    '      {"op":"del","id":<n>}   remove item #n',
    '    The id is the number shown beside each line in the "Memory" section below.',
    '    A normal task = no "memory" field. See "Memory" below.',
    '',
    'Action shapes:',
    '  {"type":"move","unitId":"<id>","to":{"x":<int>,"y":<int>}}',
    '  {"type":"harvest","unitId":"<id>","target":{"x":<int>,"y":<int>}}',
    '  {"type":"craft","unitId":"<id>","recipe":"<id>"}',
    '  {"type":"build","unitId":"<id>","building":"<id>","at":{"x":<int>,"y":<int>}}',
    '',
    'harvest works the object on the target tile; the verb is inferred from what',
    'is there:',
    '  - a "fruit tree" is GATHERED for fruit (food) and stays standing;',
    '  - a plain "tree" is CHOPPED for wood (removed);',
    '  - rock and ore are MINED.',
    'So harvest a fruit tree for food, a plain tree for wood.',
    '',
    'Terrain types (the ground a tile is made of):',
    terrainLines(),
    'Object types (what can sit on a tile):',
    objectLines(),
    '',
    'Recipes (craft):',
    recipeLines(),
    'Buildings (build):',
    buildingLines(),
    'Harvest rules:',
    harvestLines(),
    `  (Work times are at normal 1× game speed and exclude walking there; the`,
    `   sim runs ${BASE_TPS} ticks/second, and a higher speed setting shortens`,
    `   them proportionally.)`,
    '',
    'Fog of war:',
    `  - Each unit only sees tiles within ${DEFAULT_VISION_RADIUS} tiles of itself.`,
    '  - The resource lists show ONLY objects currently in some unit\'s sight.',
    '    Anything beyond that is unknown — it may exist but is not listed.',
    '  - To find more resources, move a unit to scout unexplored ground first.',
    '',
    'Memory (standing player preferences):',
    '  - The "Memory" section below the world holds durable instructions players',
    '    have told you to remember (e.g. "always keep one unit scouting", "prefer',
    '    axes over pickaxes"), each shown with a number (its id). Treat it as',
    '    always-on: obey every line on EVERY command unless the current command',
    '    overrides it.',
    '  - When a player states a lasting preference — "always ...", "from now on',
    '    ...", "never ...", "stop ...", "forget ..." — change memory with edit ops',
    '    (see "memory" above): "add" a new line, "edit" the id of a line to reword,',
    '    "del" the id of one to drop. Touch ONLY the lines the player asked about;',
    '    leave the rest alone (do NOT re-send them). Each line is a short imperative.',
    '  - Store ONLY durable preferences here. Do NOT store one-off commands, chat,',
    '    world state, or coordinates. If a command is a normal one-off task, omit',
    '    "memory" entirely.',
    '',
    'Rules:',
    '  - Use only unit ids that exist in the world snapshot.',
    '  - Mining ore REQUIRES a pickaxe — craft one first if no unit has it.',
    '  - Coordinates must be inside the world bounds.',
    '  - Each idle unit line lists its NEAREST target of each kind ("nearest →").',
    '    Assign a unit to its own nearest suitable target so units do not cross',
    '    the map when a closer one exists. Spread units across different targets',
    '    rather than sending several to the same tile.',
    '  - For broad commands ("everyone", "all units", "the whole colony", "keep',
    '    working"), give EVERY idle unit (see the idle-units line) a task — do',
    '    not leave any idle unit unassigned.',
    '  - Do not invent resource coordinates the snapshot does not list.',
  ].join('\n');
}

// --- Dynamic tail --------------------------------------------------------

/** The closest cell to `from` by Manhattan distance (a good proxy — movement is
 *  4-connected; the sim does the real fog-aware routing). Undefined for an empty
 *  list. */
function nearestCell(from: Coord, cells: Coord[]): { cell: Coord; dist: number } | undefined {
  let best: { cell: Coord; dist: number } | undefined;
  for (const cell of cells) {
    const dist = Math.abs(cell.x - from.x) + Math.abs(cell.y - from.y);
    if (!best || dist < best.dist) best = { cell, dist };
  }
  return best;
}

/** A compact, model-friendly snapshot of the world: every unit in full (idle
 *  ones annotated with their nearest target of each kind), plus EVERY
 *  harvestable target currently in vision, listed by coordinate. The fog already
 *  bounds this to what units can see, so the list stays small; if it ever grows
 *  too large we'll sample/summarize then, not pre-emptively. */
export function worldContext(world: World): string {
  // Harvestable targets by category, kept as numeric cells so we can both list
  // them AND compute each unit's nearest one. Fruit trees are split from plain
  // trees: harvesting a fruit tree GATHERS its fruit (the tree stays) while a
  // bare tree is CHOPPED for wood — "get food" vs "get wood".
  const cells: Record<string, Coord[]> = {
    'fruit tree': [],
    tree: [],
    rock: [],
    ore: [],
  };
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const obj = world.tiles[y * world.width + x]?.object;
      if (!obj) continue;
      const key = obj.kind === 'tree' && obj.hasFruit ? 'fruit tree' : obj.kind;
      cells[key]?.push({ x, y });
    }
  }

  const isIdle = (u: (typeof world.units)[string]): boolean =>
    !u.job && !u.craftJob && !u.buildJob;

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
    const line = `  ${u.id} at (${u.pos.x},${u.pos.y}) inv[${inv}] tools[${tools}] ${busy}`;
    if (!isIdle(u)) return line;
    // Hand each idle unit its nearest target of each kind (Manhattan distance —
    // movement is 4-connected). Models pick "nearest" badly from a raw coord
    // list, so we precompute it; this is what stops a unit crossing the map to
    // a far tree when a closer one exists.
    const hints = Object.entries(cells)
      .map(([kind, list]) => {
        const near = nearestCell(u.pos, list);
        return near ? `${kind} (${near.cell.x},${near.cell.y}) d${near.dist}` : null;
      })
      .filter((h): h is string => h !== null);
    return hints.length ? `${line}\n    nearest → ${hints.join(', ')}` : line;
  });

  const idleIds = Object.values(world.units).filter(isIdle).map((u) => u.id);

  const resources = Object.keys(cells).map((k) => {
    const list = cells[k]!;
    const at = list.map((c) => `(${c.x},${c.y})`).join(' ');
    return `  ${k}: ${list.length} visible${list.length ? ` at ${at}` : ''}`;
  });

  // Notable terrain in view. Terrain isn't fogged in the snapshot (only objects
  // are), so unlike the resource scan above we gate on visibleTiles() by hand —
  // the model should only learn about ground its units have actually seen. Grass
  // is the ordinary default and omitted; we list the rest (water, sand, dirt,
  // stone) by coordinate so the model knows where the water/shore/etc. are.
  const terrainCells: Record<string, string[]> = {};
  for (const key of visibleTiles(world)) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const terrain = world.tiles[y * world.width + x]?.terrain;
    if (!terrain || terrain === 'grass') continue;
    (terrainCells[terrain] ??= []).push(`(${x},${y})`);
  }
  const terrain = Object.keys(terrainCells).map(
    (k) => `  ${k}: ${terrainCells[k]!.length} tiles at ${terrainCells[k]!.join(' ')}`,
  );

  const builds = Object.values(world.buildings).map(
    (b) => `  ${b.type}@(${b.pos.x},${b.pos.y})`,
  );

  // NB: the world dimensions are constant, but we deliberately DROP the tick
  // counter here. It advances every tick (BASE_TPS/sec), so including it would
  // change this block on every single call — busting Ollama's prefix KV-cache
  // even when the units haven't moved — for essentially no planning value (the
  // model reasons about durations from the rules, not the absolute clock).
  // Omitting it lets a stationary-world follow-up reuse the cache in full.
  return [
    `World ${world.width}x${world.height}.`,
    'Units:',
    ...units,
    `Idle units, free to assign right now: ${idleIds.length ? idleIds.join(', ') : 'none'}.`,
    'Resources your units can currently see (fog of war hides the rest):',
    ...resources,
    'Notable terrain in view (all other visible ground is ordinary grass):',
    ...(terrain.length ? terrain : ['  none — all visible ground is grass']),
    builds.length ? 'Buildings:' : 'Buildings: none',
    ...builds,
  ].join('\n');
}

/** The players sharing the colony. This is the STABLE roster only — it changes
 *  just when someone joins or leaves. Who issued the CURRENT command lives with
 *  the command in the volatile tail (see `assemble`), so a new command from a
 *  different player doesn't invalidate the cached roster line. */
export function rosterContext(roster: string[]): string {
  const online = roster.length ? roster.join(', ') : '(none listed)';
  return `Players online: ${online}.`;
}

/** The volatile command tail: who issued it (changes per command) plus the
 *  command text itself. Kept together at the very end of the prompt so it's the
 *  only thing that must re-evaluate on a same-world follow-up. */
export function commandContext(command: string, submitter?: string): string {
  const from = submitter
    ? `This command is from ${submitter}.`
    : 'This command is autonomous (no player).';
  return [from, `Command: ${command}`].join('\n');
}

/** The last few conversation turns so the model has short-term memory (a player
 *  can say "do that again" or "the one I mentioned"). */
export function historyContext(history: ConversationTurn[]): string {
  if (history.length === 0) return '(no earlier messages)';
  return history.map((t) => `${t.who}: ${t.text}`).join('\n');
}

/** The persistent memory: standing player preferences the model chose to keep,
 *  more stable than the per-call world/conversation tail but editable (unlike
 *  the fixed system prompt). Rendered as a NUMBERED list — the number is each
 *  line's 1-based id, which the model uses to target it with edit/del ops (so it
 *  never has to re-send the list). */
export function memoryContext(memory: string[]): string {
  if (memory.length === 0) return '(nothing saved yet)';
  return memory.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
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
  /** Standing player preferences saved across calls (the model amends these). */
  memory?: string[];
  /** Which voice style the "msg" reply should use (a VOICES id, or 'off' /
   *  undefined for no Voice section — the model then replies plainly). */
  voice?: string;
}

/** Assemble the full prompt, returning the messages to send, the exact raw
 *  string (for View Raw), and the labeled sections (View Pretty). When `command`
 *  is omitted this yields the Config-tab template.
 *
 *  Ordering is tuned for Ollama's prefix KV-cache, which reuses the longest
 *  IDENTICAL token prefix across calls and re-evaluates everything from the
 *  first changed token onward. So sections are laid out by how RELIABLY each
 *  changes between two consecutive commands, least-changing first:
 *    System (never) → Voice (only when the player switches style, rare) →
 *    Memory (rare) → Players (roster only, rare) → World
 *    (only when units actually move/harvest — often identical at rest) →
 *    Conversation (grows by one turn on EVERY command) → Command (submitter +
 *    text; every call, tiny).
 *  The subtlety: the conversation is the more reliable cache-buster — it gains a
 *  turn on every command — whereas the world is frequently unchanged between
 *  commands. So the world goes AHEAD of the conversation: when units are idle,
 *  the whole (large) world block stays cached and only the new chat turn +
 *  command re-evaluate (measured ~150ms vs ~2700ms for the reverse order). When
 *  units are moving both orders re-evaluate the world anyway, so this is never
 *  worse. The per-command submitter line rides with the command in the tail. */
export function assemble(
  world: World,
  input: AssembleInput = {},
): { messages: ChatMessage[]; raw: string; parts: AiPromptPart[] } {
  const { command, submitter, roster = [], history = [], memory = [], voice } = input;
  const sys = systemPrompt();
  // The Voice section (persona for "msg") is toggleable/switchable at runtime,
  // so it lives outside the fixed system rules. When active we fold it into the
  // system message (it IS an instruction) AND surface it as its own labeled part
  // so the Config tab can show exactly what the current voice adds. Empty = the
  // player turned voice off (or picked an unknown id): no section, plain replies.
  const voiceText = voicePrompt(voice ?? '');
  const sysContent = voiceText ? `${sys}\n\n${voiceText}` : sys;
  const mem = memoryContext(memory);
  const ctx = worldContext(world);
  const players = rosterContext(roster);
  const convo = historyContext(history);
  const cmd = commandContext(command ?? '<the player command goes here>', submitter);

  const parts: AiPromptPart[] = [
    { label: 'System', content: sys },
    ...(voiceText ? [{ label: 'Voice', content: voiceText }] : []),
    { label: 'Memory', content: mem },
    { label: 'Players', content: players },
    { label: 'World context', content: ctx },
    { label: 'Recent conversation', content: convo },
    { label: 'Command', content: cmd },
  ];

  const userContent = [
    'Memory (standing player preferences):',
    mem,
    '',
    players,
    '',
    ctx,
    '',
    'Recent conversation:',
    convo,
    '',
    cmd,
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: sysContent },
    { role: 'user', content: userContent },
  ];

  const raw = parts.map((p) => `### ${p.label}\n${p.content}`).join('\n\n');
  return { messages, raw, parts };
}

// Re-export so the parser and callers phrase actions consistently.
export { describeAction };
