// Prompt assembly for the game orchestrator. Ordered for Ollama's prompt cache:
// the STABLE prefix (role + action schema + registry ids) comes first and is
// byte-identical across calls; only the world snapshot and the user command —
// the LAST parts — change. That maximizes KV-cache reuse on a warm model.
import {
  BASE_TPS,
  BUILDINGS,
  DEFAULT_VISION_RADIUS,
  HARVEST_RULES,
  OBJECT_DEFENSE,
  OBJECT_HP,
  RECIPES,
  TERRAIN_COLORS,
  describeAction,
  toCell,
  toCellXY,
  effectiveSpeed,
  encumbrance,
  harvestDamage,
  unitCapacity,
  unitLoad,
  visibleTiles,
} from '@game/shared';
import type {
  AiPromptPart,
  Coord,
  ConversationTurn,
  PlayerCameraView,
  World,
} from '@game/shared';
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

/** Ticks to deplete `hp` at a given per-tick hp-loss `rate`, plus the wall-clock
 *  at normal (1×) game speed. Speeds > 1× shorten it proportionally. */
function workTime(hp: number, rate: number): string {
  const ticks = Math.ceil(hp / rate);
  const secs = Math.round((ticks / BASE_TPS) * 10) / 10;
  return `~${secs}s (${ticks} ticks)`;
}

// hp removed per tick = damage / defense (see the harvest damage model). The
// verb maps to which tool matters: chop→axe, mine→pickaxe.
function chipRate(verb: 'chop' | 'mine', kind: string, tools: string[]): number {
  return harvestDamage(verb, tools) / (OBJECT_DEFENSE[kind] ?? 1);
}

function harvestLines(): string {
  return Object.entries(HARVEST_RULES)
    .map(([kind, rule]) => {
      const verb: 'chop' | 'mine' = kind === 'tree' ? 'chop' : 'mine';
      const bits: string[] = [];
      const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'an' : 'a');
      if (rule.require) bits.push(`REQUIRES ${article(rule.require)} ${rule.require} (impossible without one)`);
      if (rule.boost && rule.boost !== rule.require) {
        const speedup = Math.round((chipRate(verb, kind, [rule.boost]) / chipRate(verb, kind, [])) * 10) / 10;
        bits.push(`${speedup}× faster with ${article(rule.boost)} ${rule.boost}`);
      }
      const def = OBJECT_DEFENSE[kind] ?? 1;
      bits.push(`defense ${def}`);
      return `  - ${kind}: ${bits.join('; ')}`;
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
  const treeHand = chipRate('chop', 'tree', []);
  const treeAxe = chipRate('chop', 'tree', ['axe']);
  const rockHand = chipRate('mine', 'rock', []);
  const rockPick = chipRate('mine', 'rock', ['pickaxe']);
  const orePick = chipRate('mine', 'ore', ['pickaxe']);
  return [
    `  - tree: chop for wood (tree removed) — ${OBJECT_HP.tree} HP, defense ${OBJECT_DEFENSE.tree}; ${workTime(OBJECT_HP.tree, treeHand)} by hand, ${workTime(OBJECT_HP.tree, treeAxe)} with an axe`,
    '  - fruit tree: a tree bearing fruit — gather for fruit/food, instant (1 tick); tree stays standing',
    `  - rock: mine for stone — ${OBJECT_HP.rock} HP, defense ${OBJECT_DEFENSE.rock}; ${workTime(OBJECT_HP.rock, rockHand)} by hand, ${workTime(OBJECT_HP.rock, rockPick)} with a pickaxe`,
    `  - ore: mine for metal ore (iron/copper/gold) — ${OBJECT_HP.ore} HP, high defense ${OBJECT_DEFENSE.ore}; REQUIRES a pickaxe, ${workTime(OBJECT_HP.ore, orePick)}`,
  ].join('\n');
}

// The system message is split into four labeled sections so the Config UI (View
// Pretty) shows — and can eventually let players tune — each concern on its own:
// governance (System), the action vocabulary (Actions), the map reference
// (World reference), and the craft/build registry (Recipes). assemble() joins
// them, IN THIS ORDER, into one deterministic (cache-stable) system message; the
// order is unchanging so Ollama's prefix KV-cache still holds across calls.

/** System: who the assistant is, the exact JSON it must return, and the
 *  always-on governance rules (fog, memory management, global constraints). The
 *  action/registry *reference* lives in its own sections below. */
function rolePrompt(): string {
  return [
    'You are the shared AI assistant for a real-time tile-world colony game.',
    'Multiple players share one colony and one you. Turn the current command',
    'into a plan the simulation can execute, and optionally reply to the players.',
    '',
    'Respond with ONE command per line — nothing else. NO JSON, no markdown, no',
    'code fences, no prose outside these lines. Each line begins with a keyword:',
    '',
    '  msg <text>           a SHORT one-line reply to the player',
    '  <action> <args...>   a plan step — the exact forms are in the "Actions" section',
    '  mem <op> <args...>   an OPTIONAL memory edit (rare — see "Memory")',
    '',
    'Order does not matter and any line may be omitted. Emit only the lines you',
    'need — often just an action line or two, sometimes a single msg. Emitting NO',
    'lines is a valid "nothing to do". Example response:',
    '  msg Sending two over for wood!',
    '  harvest unit0 AF29',
    '  harvest unit1 AB16',
    '',
    '  - msg: the rest of the line is the reply, spoken in the colony\'s voice when a',
    '    "Voice" section is given below (otherwise plain and direct). Include ONE',
    '    whenever you act on a PLAYER\'s command, or when you have something real to',
    '    say (a question, a refusal, a status note). Omit it on autonomous ticks with',
    '    no player, and never narrate every action or repeat a line you have used',
    '    before.',
    '  - mem: OPTIONAL and OFF BY DEFAULT. OMIT it on virtually every command. When',
    '    you DO change memory, emit only a few tiny ops, ONE per line — never the',
    '    whole list, and never lines that are staying the same:',
    '      mem add <new preference>        add a new standing preference',
    '      mem edit <n> <new text>         replace item #n',
    '      mem del <n>                     remove item #n',
    '    The id <n> is the number shown beside each line in the "Memory" section',
    '    below. A normal task = no mem line. See "Memory" below.',
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
    '    ...", "never ...", "stop ...", "forget ..." — change memory with mem lines',
    '    (see "mem" above): "mem add" a new line, "mem edit <id>" to reword one,',
    '    "mem del <id>" to drop one. Touch ONLY the lines the player asked about;',
    '    leave the rest alone (do NOT re-send them). Each line is a short imperative.',
    '  - Store ONLY durable preferences here. Do NOT store one-off commands, chat,',
    '    world state, or coordinates. If a command is a normal one-off task, emit',
    '    no mem line at all.',
    '',
    'Rules:',
    '  - Use only unit ids that exist in the world snapshot.',
    '  - Mining ore REQUIRES a pickaxe — craft one first if no unit has it.',
    '  - Coordinates must be inside the world bounds.',
    '  - To send a unit gathering, prefer handing it an AREA (a cell range like',
    '    "AU20:AZ28") rather than an exact tile: the sim routes it to the CLOSEST',
    '    matching resource in that box, so you never have to compute "nearest"',
    '    yourself. Give each unit an area near ITS position, and spread units across',
    '    different areas rather than sending several to the same tile.',
    '  - Watch each unit\'s bag. "enc" is how full it is by weight; a unit at or near',
    '    FULL (enc ≳ 80%) should be sent to DROP or DEPOSIT (at a depot) before you',
    '    give it more to harvest — a FULL unit cannot carry more and its extra',
    '    harvest spills onto the ground (wasted effort). When picking who gathers,',
    '    prefer the units with the EMPTIEST bags.',
    '  - Only ONE unit can work a given resource/target at a time, so never assign',
    '    two units to the same tile. When a player asks for resources ("get wood",',
    '    "gather stone"), typically dispatch SEVERAL idle units in parallel — each to',
    '    its OWN nearest target of that kind — so the work finishes faster.',
    '  - For broad commands ("everyone", "all units", "the whole colony", "keep',
    '    working"), give EVERY idle unit (see the idle-units line) a task — do',
    '    not leave any idle unit unassigned.',
    '  - Do not invent resource coordinates the snapshot does not list.',
  ].join('\n');
}

/** Actions: the full vocabulary of plan steps, grouped by what they affect —
 *  unit control (per-unit commands) vs. the player's own camera. Its own section
 *  because the action set is what grows most as new mechanics are added. */
function actionsPrompt(): string {
  return [
    'Actions — your plan is a list of command lines. ONE command per line, and ONE',
    'target per line: to work several tiles, emit several harvest lines (or hand one',
    'unit an area). Never list multiple cells on a single line.',
    '',
    'Args: <id> is a unit id from the snapshot (unit0, not 0). <cell> is like AF29.',
    '<area> is two cells joined by a colon (AU20:AZ28). [x] is optional.',
    '',
    'Unit commands (one example each):',
    '  move <id> <cell> — walk to a tile (scout/reposition). e.g. move unit0 AF29',
    '  harvest <id> <cell|area> [types] — chop/mine/gather. e.g. harvest unit0 AB16',
    '  craft <id> <recipe> — make a tool from carried items. e.g. craft unit0 pickaxe',
    '  build <id> <building> <cell> — raise a building. e.g. build unit0 storage J25',
    '  drop <id> <cell> [item] [qty] — set items down. e.g. drop unit0 J25 wood 10',
    '  dropnearby <id> [item] [qty] — drop at the unit\'s feet. e.g. dropnearby unit0',
    '  pickup <id> <cell|area> [item] [qty] — pick items up. e.g. pickup unit0 AV26 wood',
    '  cancel <id> — stop the unit\'s current job. e.g. cancel unit0',
    '',
    '  - harvest reads the tile: a fruit tree is GATHERED for food (tree stays), a',
    '    plain tree is CHOPPED for wood, rock/ore are MINED.',
    '  - Areas (harvest/pickup only): the unit goes to the CLOSEST match inside the',
    '    box, so you needn\'t pick the exact tile. harvest may add resource types to',
    '    filter — "harvest unit0 AU20:AZ28 tree ore". This is the preferred way to',
    '    assign gathering: one area per unit.',
    '  - harvest/build/drop/pickup walk to their tile on their own — do NOT put a',
    '    move before them.',
    '  - On drop/dropnearby/pickup, omit the item to move the WHOLE bag.',
    '  - A busy unit (chopping/mining/crafting/building) ignores every command but',
    '    cancel until it finishes; cancel refunds craft inputs, no-op when idle.',
    '  - Storage depot (type "storage"): drop onto its tile DEPOSITS, pickup from it',
    '    WITHDRAWS. Plain ground holds only one item stack per tile.',
    '',
    'Camera — changes ONLY what the asking player SEES on screen. It moves nothing',
    'in the world: it is NOT a way to send, patrol, guard, or scout a unit — there is',
    'no patrol/guard action, so to station a unit somewhere use move.',
    '  camera <cell> <tilesAcross> — pan/zoom the view (give either or both). e.g. camera AF29 40',
    '',
    'Coordinates: column letter + row number; A1 is TOP-LEFT. East = later column,',
    'west = earlier; south = larger row, north = smaller. Emit cells exactly (AF29)',
    '— never x/y numbers or a bare row/column. An area is two cells joined by a colon.',
  ].join('\n');
}

/** World reference: the ground types, what can sit on a tile, and the harvest
 *  cost/time for each — everything the model needs to reason about terrain and
 *  gathering. Kept apart from the craft/build registry (Recipes). */
function worldRefPrompt(): string {
  return [
    'Terrain types (the ground a tile is made of):',
    terrainLines(),
    'Object types (what can sit on a tile):',
    objectLines(),
    'Harvest rules:',
    harvestLines(),
    `  (Work times are at normal 1× game speed and exclude walking there; the`,
    `   sim runs ${BASE_TPS} ticks/second, and a higher speed setting shortens`,
    `   them proportionally.)`,
  ].join('\n');
}

/** Recipes: the craft + build registry (inputs → output). Its own section
 *  because it's the content most expected to grow. Craft turns carried items
 *  into an item; build consumes items to raise a structure on a tile. */
function recipesPrompt(): string {
  return [
    'Recipes (craft) — a unit turns inputs it is carrying into an item:',
    recipeLines(),
    'Buildings (build) — a unit spends inputs to raise a structure on a tile:',
    buildingLines(),
  ].join('\n');
}

/** The whole system message: the four sections joined in cache-stable order.
 *  Exported for callers wanting the entire text; the Config UI (View Pretty)
 *  instead renders each section separately — see `assemble`. */
export function systemPrompt(): string {
  return [rolePrompt(), actionsPrompt(), worldRefPrompt(), recipesPrompt()].join('\n\n');
}

// --- Dynamic tail --------------------------------------------------------

/** How a unit id is shown to the model: dash-free ("unit-3" → "unit3"), which
 *  saves a token per mention. The parser accepts either form (it reads the
 *  trailing digits), and every INTERNAL id keeps its canonical "unit-3" shape —
 *  this is purely how ids are rendered into the prompt. */
function promptId(id: string): string {
  return id.replace(/^unit-/, 'unit');
}

/** A job's completion as a percentage, from ticks remaining vs. the starting
 *  total (falls back to 0% if an older save's job lacks a total). */
function jobProgress(remaining: number, total?: number): string {
  if (!total || total <= 0) return '0%';
  const done = Math.max(0, Math.min(1, 1 - remaining / total));
  return `${Math.round(done * 100)}%`;
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

  // One compact DSL line per unit (cheaper than JSON — no braces/quotes):
  //   id @cell status | hp cur/max armor N bag load/cap enc P%[ FULL] spd S | inv … | tools …
  // Positions are cell strings ("AF29"), exactly the form actions must send back.
  // The model no longer gets a precomputed "nearest" per unit: it can hand a unit
  // an AREA (range) and the sim routes it to the closest matching resource.
  const units = Object.values(world.units).map((u) => {
    // status: idle, a job verb + its target cell ("chop AV18"), or craft/build
    // with a completion %.
    let status = 'idle';
    if (u.job) status = `${u.job.verb} ${toCell(u.job.target)}`;
    else if (u.craftJob) status = `craft ${u.craftJob.recipe} ${jobProgress(u.craftJob.remaining, u.craftJob.total)}`;
    else if (u.buildJob) status = `build ${u.buildJob.building} ${jobProgress(u.buildJob.remaining, u.buildJob.total)}`;

    // Stats: hp/maxHp, armor, bag load/capacity, encumbrance %, effective speed
    // (tiles/s after that load). A FULL bag (enc ≥ 100%) both stops the unit
    // picking up more AND spills any further harvest to the ground — flag it
    // loudly so the model reroutes the unit to drop/deposit first.
    const load = Math.round(unitLoad(u) * 10) / 10;
    const enc = Math.round(encumbrance(u) * 100);
    const stats =
      `hp ${Math.round(u.hp ?? 100)}/${Math.round(u.maxHp ?? 100)} armor ${u.armor ?? 0} ` +
      `bag ${load}/${unitCapacity(u)} enc ${enc}%${enc >= 100 ? ' FULL' : ''} ` +
      `spd ${Math.round(effectiveSpeed(u) * 100) / 100}`;

    const inv = Object.entries(u.inventory)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`);
    const invStr = inv.length ? inv.join(', ') : 'none';
    const toolsStr = u.tools.length ? u.tools.join(', ') : 'none';

    return `  ${promptId(u.id)} @${toCell(u.pos)} ${status} | ${stats} | inv ${invStr} | tools ${toolsStr}`;
  });

  const idleIds = Object.values(world.units).filter(isIdle).map((u) => promptId(u.id));

  const resources = Object.keys(cells).map((k) => {
    const list = cells[k]!;
    const at = list.map((c) => toCell(c)).join(' ');
    return `  ${k}: ${list.length} visible${list.length ? ` at ${at}` : ''}`;
  });

  // Loose resources dropped on the ground (overflow from full harvesters, or set
  // down via drop), grouped by item as "item: cell cell …" so the model can send
  // a unit to pick them up (or hand it an area). We deliberately DROP the pile
  // quantities — they're low-value for planning and cost tokens; the cells are
  // what a pickup needs. Fogged like objects: only piles in current sight appear.
  const pileCells: Record<string, string[]> = {};
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const items = world.tiles[y * world.width + x]?.items;
      if (!items) continue;
      for (const [k, n] of Object.entries(items)) {
        if (n > 0) (pileCells[k] ??= []).push(toCellXY(x, y));
      }
    }
  }
  const piles = Object.entries(pileCells).map(([k, cs]) => `  ${k}: ${cs.join(' ')}`);

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
    (terrainCells[terrain] ??= []).push(toCellXY(x, y));
  }
  const terrain = Object.keys(terrainCells).map(
    (k) => `  ${k}: ${terrainCells[k]!.length} tiles at ${terrainCells[k]!.join(' ')}`,
  );

  // Buildings grouped by type as "type: cell cell …" to save tokens. A storage
  // depot with a stash keeps its contents inline, attached to its own cell
  // ("AF12 (20 wood, 5 stone)"), so the model still knows what's stored (and how
  // full) before routing a deposit/withdraw; contentless buildings are just cells.
  const buildCells: Record<string, string[]> = {};
  for (const b of Object.values(world.buildings)) {
    const store = b.store && Object.entries(b.store).filter(([, n]) => n > 0);
    const contents = store && store.length ? ` (${store.map(([k, n]) => `${n} ${k}`).join(', ')})` : '';
    (buildCells[b.type] ??= []).push(`${toCell(b.pos)}${contents}`);
  }
  const builds = Object.entries(buildCells).map(([type, cs]) => `  ${type}: ${cs.join(' ')}`);

  // NB: the world dimensions are constant, but we deliberately DROP the tick
  // counter here. It advances every tick (BASE_TPS/sec), so including it would
  // change this block on every single call — busting Ollama's prefix KV-cache
  // even when the units haven't moved — for essentially no planning value (the
  // model reasons about durations from the rules, not the absolute clock).
  // Omitting it lets a stationary-world follow-up reuse the cache in full.
  return [
    `World ${world.width}x${world.height}.`,
    'Units — one per line, format:',
    '  id @cell status | hp cur/max armor N bag load/cap enc P%[ FULL] spd S | inv <item n, …> | tools <…>',
    'status is "idle", a job verb + its target cell ("chop AV18"), or "craft/build',
    '<what> <%done>". enc is how full the bag is by weight; FULL (enc ≥ 100%) means',
    'the unit CANNOT carry more — further harvest spills to the ground. spd is',
    'tiles/sec after that load. To gather, hand a unit an AREA (range) and it works',
    'the closest matching resource (see Actions) — no need to pick the exact tile.',
    ...units,
    `Idle units, free to assign right now: ${idleIds.length ? idleIds.join(', ') : 'none'}.`,
    'Resources your units can currently see (fog of war hides the rest):',
    ...resources,
    piles.length
      ? 'Loose ground piles you can pick up (item: cells):'
      : 'Loose ground piles: none in sight',
    ...piles,
    'Notable terrain in view (all other visible ground is ordinary grass):',
    ...(terrain.length ? terrain : ['  none — all visible ground is grass']),
    builds.length ? 'Buildings:' : 'Buildings: none',
    ...builds,
  ].join('\n');
}

/** What each player currently sees on screen, so the model can orient replies
 *  and setView moves relative to the human (e.g. "the ore to your south"). One
 *  line per reporting player: view center + the visible tile window. Players who
 *  haven't reported a camera yet are simply omitted; none → a stable placeholder
 *  so the section is always present (keeps the prompt shape steady). */
export function playerViewsContext(cameras: PlayerCameraView[]): string {
  if (cameras.length === 0) return '(no camera reports yet)';
  return cameras
    .map((c) => {
      const w = Math.max(1, Math.round(c.w));
      const h = Math.max(1, Math.round(c.h));
      const cx = Math.round(c.cx);
      const cy = Math.round(c.cy);
      const x0 = cx - Math.floor(w / 2);
      const y0 = cy - Math.floor(h / 2);
      return (
        `  ${c.name}: centered at ${toCellXY(cx, cy)}, showing a ${w}x${h} tile area ` +
        `(${toCellXY(x0, y0)}..${toCellXY(x0 + w - 1, y0 + h - 1)})`
      );
    })
    .join('\n');
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
  /** What each online player currently sees on screen (for orientation). */
  cameras?: PlayerCameraView[];
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
 *    Player views (changes when someone pans — small) → Conversation (grows by
 *    one turn on EVERY command) → Command (submitter + text; every call, tiny).
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
  const { command, submitter, roster = [], history = [], memory = [], cameras = [], voice } = input;
  // The system message is four labeled sections (see their definitions above),
  // shown separately in View Pretty but concatenated — in this fixed order — into
  // the one system message actually sent, so the KV-cache prefix stays stable.
  const role = rolePrompt();
  const actions = actionsPrompt();
  const worldRef = worldRefPrompt();
  const recipes = recipesPrompt();
  const sys = [role, actions, worldRef, recipes].join('\n\n');
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
  const views = playerViewsContext(cameras);
  const convo = historyContext(history);
  const cmd = commandContext(command ?? '<the player command goes here>', submitter);

  // Each part is tagged with how reliably it changes call-to-call — the same
  // property the ordering above is built on — so the Config UI can show a KV
  // badge per section and predict the cache boundary. 'stable' = never/rarely
  // changes (the cached prefix); 'occasional' = a discrete event (memory/roster);
  // 'live' = changes most turns.
  const parts: AiPromptPart[] = [
    { label: 'System', content: role, volatility: 'stable' },
    { label: 'Actions', content: actions, volatility: 'stable' },
    { label: 'World reference', content: worldRef, volatility: 'stable' },
    { label: 'Recipes', content: recipes, volatility: 'stable' },
    ...(voiceText ? [{ label: 'Voice', content: voiceText, volatility: 'stable' as const }] : []),
    { label: 'Memory', content: mem, volatility: 'occasional' },
    { label: 'Players', content: players, volatility: 'occasional' },
    { label: 'World context', content: ctx, volatility: 'live' },
    { label: 'Player views', content: views, volatility: 'live' },
    { label: 'Recent conversation', content: convo, volatility: 'live' },
    { label: 'Command', content: cmd, volatility: 'live' },
  ];

  const userContent = [
    'Memory (standing player preferences):',
    mem,
    '',
    players,
    '',
    ctx,
    '',
    'Player views (what each player currently sees on screen):',
    views,
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
