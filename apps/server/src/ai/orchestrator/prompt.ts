// Prompt assembly for the game orchestrator. Ordered for Ollama's prompt cache:
// the STABLE prefix (role + action schema + registry ids) comes first and is
// byte-identical across calls; only the world snapshot and the user command —
// the LAST parts — change. That maximizes KV-cache reuse on a warm model.
import {
  BUILDINGS,
  DEFAULT_VISION_RADIUS,
  HARVEST_RULES,
  RECIPES,
  TERRAIN_COLORS,
  describeAction,
  visibleTiles,
} from '@game/shared';
import type { AiPromptPart, Coord, ConversationTurn, World } from '@game/shared';
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

/** The object kinds a tile can hold, and what harvesting each yields. "fruit
 *  tree" isn't a distinct kind (it's a tree carrying fruit) but is listed so the
 *  model connects the world-context label to a behavior. */
function objectLines(): string {
  return [
    '  - tree: chop for wood (the tree is felled/removed)',
    '  - fruit tree: a tree bearing fruit — gather for fruit/food (stays standing)',
    '  - rock: mine for stone',
    '  - ore: mine for metal ore (iron/copper/gold); REQUIRES a pickaxe',
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

  return [
    `World ${world.width}x${world.height}, tick ${world.tick}.`,
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
