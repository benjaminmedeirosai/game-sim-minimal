// The pure simulation: world generation + the per-tick advance. No I/O, no
// networking, no rendering — the host, and later client-side prediction and
// tests, all run this same code.
import type { Action } from './actions.js';
import { mulberry32, pick } from './rng.js';
import {
  TREES,
  ROCKS,
  ORES,
  TREE_TYPES,
  ROCK_TYPES,
  ORE_TYPES,
} from './registry/objects.js';
import {
  RECIPES,
  BUILDINGS,
  HARVEST_RULES,
  HARVEST_POWER,
} from './registry/recipes.js';
import { tileAt } from './types.js';
import type { Coord, Tile, TerrainType, Unit, World, WorldObject, WorldSettings } from './types.js';
import { visibleTiles } from './vision.js';

const MIN_DIM = 8;
const MAX_DIM = 120;

// How many humans a fresh world starts with.
const SPAWN_UNITS = 4;
// Ticks between walk steps — units move 1 tile every this many ticks.
const UNIT_STEP_TICKS = 2;
// Global multiplier on how long manual work takes: object hit-points (chop/mine)
// and craft/build durations are all scaled by this. Bumping it makes harvesting
// and construction feel weighty rather than instant.
const WORK_SCALE = 10;
// Fruit picked in a single gather (non-destructive; leaves the tree standing).
const FRUIT_YIELD: Record<string, number> = { fruit: 3 };

// Cumulative "terrain the colony has ever seen", per world, kept OUT of the
// serialized World (it must never reach clients or the wire). A bit per tile;
// 1 = seen at least once. Travel planning trusts real walkability only on seen
// tiles and optimistically assumes unseen tiles are passable — that's what lets
// a unit walk toward an unknown spot and only discover blockers as it goes.
const exploredMemory = new WeakMap<World, Uint8Array>();

function exploredFor(world: World): Uint8Array {
  let e = exploredMemory.get(world);
  if (!e) {
    e = new Uint8Array(world.width * world.height);
    exploredMemory.set(world, e);
  }
  return e;
}

/** Union the colony's current sight into its cumulative terrain memory. */
function growExplored(world: World): void {
  const e = exploredFor(world);
  for (const key of visibleTiles(world)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    e[y * world.width + x] = 1;
  }
}

/** True only when the tile is out of bounds, or the colony has SEEN it and knows
 *  it can't be walked. Unseen tiles return false — optimistically passable. */
function knownBlocked(world: World, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return true;
  const e = exploredFor(world);
  return e[y * world.width + x] === 1 && !isWalkable(world, x, y);
}

/** Clamp user-supplied settings into a sane, renderable range. */
export function normalizeSettings(s: WorldSettings): WorldSettings {
  const width = clampInt(s.width, MIN_DIM, MAX_DIM, 48);
  const height = clampInt(s.height, MIN_DIM, MAX_DIM, 48);
  return {
    width,
    height,
    seed: Number.isFinite(s.seed) ? Math.floor(s.seed) : 1,
    zoom: clampInt(s.zoom, 4, Math.max(width, height), 20),
  };
}

export function generateWorld(settings: WorldSettings, id: string, name: string): World {
  const { width, height, seed } = settings;
  const rnd = mulberry32(seed);
  const tiles: Tile[] = new Array(width * height);

  // One lake blob with a sandy shore, sparse stone/dirt patches elsewhere.
  const lakeX = Math.floor(width * (0.3 + rnd() * 0.4));
  const lakeY = Math.floor(height * (0.3 + rnd() * 0.4));
  const lakeR = Math.min(width, height) * (0.1 + rnd() * 0.08);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.hypot(x - lakeX, y - lakeY);
      let terrain: TerrainType = 'grass';
      if (dist < lakeR) terrain = 'water';
      else if (dist < lakeR + 1.5) terrain = 'sand';
      else if (rnd() < 0.05) terrain = 'stone';
      else if (rnd() < 0.03) terrain = 'dirt';

      tiles[y * width + x] = { terrain, object: rollObject(terrain, rnd) };
    }
  }

  const world: World = {
    id,
    name,
    settings,
    width,
    height,
    tiles,
    units: {},
    buildings: {},
    buildingSeq: 0,
    tick: 0,
  };
  spawnUnits(world, rnd);
  return world;
}

/** Drop the starting humans on random walkable tiles. */
function spawnUnits(world: World, rnd: () => number): void {
  let placed = 0;
  let attempts = 0;
  while (placed < SPAWN_UNITS && attempts < 1000) {
    attempts++;
    const x = Math.floor(rnd() * world.width);
    const y = Math.floor(rnd() * world.height);
    if (!isWalkable(world, x, y)) continue;
    const id = `unit-${placed}`;
    world.units[id] = { id, kind: 'human', pos: { x, y }, inventory: {}, tools: [] };
    placed++;
  }
}

/** A unit can stand on a tile if it's in bounds, not water, and not blocked by
 *  an object (trees/rocks/ore occupy their tile; units work them from adjacent).
 *  Exported so the client can pre-check a move target before sending it. */
export function isWalkable(world: World, x: number, y: number): boolean {
  const t = tileAt(world, x, y);
  if (!t) return false;
  if (t.terrain === 'water') return false;
  if (t.object) return false;
  if (t.building) return false;
  return true;
}

/** Where a new building may be sited: an in-bounds, non-water tile that isn't
 *  already occupied by an object or another building. (Same rule as walkable,
 *  today — kept separate so building-only constraints can diverge later.)
 *  Exported so the client can pre-check placement before sending. */
export function isBuildable(world: World, x: number, y: number): boolean {
  return isWalkable(world, x, y);
}

function rollObject(terrain: TerrainType, rnd: () => number): WorldObject | undefined {
  if (terrain === 'grass') {
    if (rnd() < 0.1) {
      return { kind: 'tree', type: pick(TREE_TYPES, rnd), hasFruit: rnd() < 0.3, hp: 5 * WORK_SCALE };
    }
    if (rnd() < 0.02) {
      return { kind: 'rock', type: pick(ROCK_TYPES, rnd), hp: 4 * WORK_SCALE };
    }
  } else if (terrain === 'stone') {
    const r = rnd();
    if (r < 0.25) return { kind: 'ore', type: pick(ORE_TYPES, rnd), hp: 8 * WORK_SCALE };
    if (r < 0.6) return { kind: 'rock', type: pick(ROCK_TYPES, rnd), hp: 4 * WORK_SCALE };
  }
  return undefined;
}

/**
 * Advance the world one tick: bump the counter, then step every unit — walk one
 * step toward its destination, or (once adjacent) chip away at its work target.
 * Pure and deterministic, so the host, tests, and any future client-side
 * prediction all agree.
 */
export function tick(world: World): void {
  world.tick++;
  // Fold everything the colony can currently see into its cumulative terrain
  // memory BEFORE moving, so travel decisions this tick use up-to-date sight.
  growExplored(world);
  for (const id in world.units) stepUnit(world, world.units[id]!);
}

/** Validate + apply one command against the world. This is the single write
 *  path shared by the UI and the AI orchestrator. Invalid commands (unknown
 *  unit, unreachable/blocked target) are ignored rather than throwing. */
export function applyAction(world: World, action: Action): void {
  const unit = world.units[action.unitId];
  if (!unit) return;

  switch (action.type) {
    case 'move': {
      const { x, y } = action.to;
      if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
      // No walkability / reachability gate: we accept ANY in-bounds tile so a
      // click never reveals hidden terrain by being silently refused. The unit
      // sets off toward it and works out en route (via its own vision) whether
      // it can actually arrive — see stepTravel.
      clearJobs(unit);
      unit.moveGoal = { x, y };
      unit.moveCooldown = 0;
      return;
    }
    case 'harvest': {
      const tile = tileAt(world, action.target.x, action.target.y);
      if (!tile?.object) return;
      // Hard gate: some objects (ore) can't be worked without the right tool.
      const rule = HARVEST_RULES[tile.object.kind];
      if (rule?.require && !unit.tools.includes(rule.require)) return;
      const path = bfsPath(world, unit.pos, (cx, cy) =>
        isAdjacent(cx, cy, action.target.x, action.target.y),
      );
      if (!path) return; // no walkable tile borders the target
      clearJobs(unit);
      unit.path = path;
      unit.moveCooldown = 0;
      unit.job = { target: { ...action.target }, verb: verbFor(tile.object) };
      return;
    }
    case 'craft': {
      const recipe = RECIPES[action.recipe];
      if (!recipe) return;
      if (unit.tools.includes(action.recipe)) return; // already have it
      if (!canAfford(unit, recipe.inputs)) return;
      deductInputs(unit, recipe.inputs); // reserve the cost up front
      clearJobs(unit);
      unit.craftJob = { recipe: action.recipe, remaining: recipe.workTicks * WORK_SCALE };
      return;
    }
    case 'build': {
      const def = BUILDINGS[action.building];
      if (!def) return;
      if (!isBuildable(world, action.at.x, action.at.y)) return;
      if (!canAfford(unit, def.inputs)) return; // firm check now; re-checked on completion
      const path = bfsPath(world, unit.pos, (cx, cy) =>
        isAdjacent(cx, cy, action.at.x, action.at.y),
      );
      if (!path) return; // can't reach a tile next to the site
      clearJobs(unit);
      unit.path = path;
      unit.moveCooldown = 0;
      unit.buildJob = { building: action.building, at: { ...action.at }, remaining: def.workTicks * WORK_SCALE };
      return;
    }
  }
}

/** Cancel every kind of job/path a unit might be running, so a new command
 *  starts clean. (job/craftJob/buildJob are mutually exclusive.) */
function clearJobs(unit: Unit): void {
  unit.job = undefined;
  unit.craftJob = undefined;
  unit.buildJob = undefined;
  unit.path = undefined;
  unit.moveGoal = undefined;
}

function canAfford(unit: Unit, cost: Record<string, number>): boolean {
  for (const key in cost) {
    if ((unit.inventory[key] ?? 0) < cost[key]!) return false;
  }
  return true;
}

function deductInputs(unit: Unit, cost: Record<string, number>): void {
  for (const key in cost) {
    unit.inventory[key] = (unit.inventory[key] ?? 0) - cost[key]!;
    if (unit.inventory[key]! <= 0) delete unit.inventory[key];
  }
}

function stepUnit(world: World, unit: Unit): void {
  // Best-effort travel toward a clicked destination (fog-aware, may give up).
  if (unit.moveGoal) {
    stepTravel(world, unit);
    return;
  }

  // Walking takes priority: one tile per UNIT_STEP_TICKS ticks.
  if (unit.path && unit.path.length > 0) {
    unit.moveCooldown = (unit.moveCooldown ?? 0) - 1;
    if (unit.moveCooldown <= 0) {
      unit.pos = unit.path.shift()!;
      unit.moveCooldown = UNIT_STEP_TICKS;
    }
    return;
  }
  unit.path = undefined;

  // Crafting happens where the unit stands — just count down, then grant the tool.
  if (unit.craftJob) {
    stepCraft(unit);
    return;
  }

  // Building needs the unit adjacent to the site, then work down like harvesting.
  if (unit.buildJob) {
    stepBuild(world, unit);
    return;
  }

  if (!unit.job) return;
  const { target, verb } = unit.job;

  // Arrived? If not adjacent (path exhausted without reaching), try to re-path
  // once; give up if the target is now unreachable.
  if (!isAdjacent(unit.pos.x, unit.pos.y, target.x, target.y)) {
    const path = bfsPath(world, unit.pos, (cx, cy) => isAdjacent(cx, cy, target.x, target.y));
    if (path && path.length > 0) {
      unit.path = path;
      unit.moveCooldown = 0;
    } else {
      unit.job = undefined;
    }
    return;
  }

  const tile = tileAt(world, target.x, target.y);
  if (!tile?.object) {
    unit.job = undefined; // someone else finished it
    return;
  }
  workObject(unit, tile, verb);
}

/** One tick of crafting; on completion the tool lands in the unit's kit. Inputs
 *  were already deducted when the job was accepted. */
function stepCraft(unit: Unit): void {
  const job = unit.craftJob!;
  job.remaining -= 1;
  if (job.remaining <= 0) {
    if (!unit.tools.includes(job.recipe)) unit.tools.push(job.recipe);
    unit.craftJob = undefined;
  }
}

/** One tick of building. The unit must have reached a tile next to the site; if
 *  the path fell short, re-path once. On completion, re-check affordability and
 *  that the tile is still clear, then deduct and place the building. */
function stepBuild(world: World, unit: Unit): void {
  const job = unit.buildJob!;
  const { at } = job;

  if (!isAdjacent(unit.pos.x, unit.pos.y, at.x, at.y)) {
    const path = bfsPath(world, unit.pos, (cx, cy) => isAdjacent(cx, cy, at.x, at.y));
    if (path && path.length > 0) {
      unit.path = path;
      unit.moveCooldown = 0;
    } else {
      unit.buildJob = undefined; // can't reach it anymore
    }
    return;
  }

  job.remaining -= 1;
  if (job.remaining > 0) return;

  const def = BUILDINGS[job.building];
  // Someone may have used up the resources, or the tile got taken, while we
  // walked/worked — bail cleanly rather than building on credit.
  if (!def || !canAfford(unit, def.inputs) || !isBuildable(world, at.x, at.y)) {
    unit.buildJob = undefined;
    return;
  }
  deductInputs(unit, def.inputs);
  const id = `b-${world.buildingSeq++}`;
  world.buildings[id] = { id, type: job.building, pos: { x: at.x, y: at.y } };
  const tile = tileAt(world, at.x, at.y)!;
  tile.building = id;
  unit.buildJob = undefined;
}

/** Do one tick of work on the target object. Gather is instantaneous and leaves
 *  the tree; chop/mine chip 1 hp/tick and harvest the registry yields when the
 *  object is depleted. */
function workObject(unit: Unit, tile: Tile, verb: 'chop' | 'mine' | 'gather'): void {
  const obj = tile.object!;
  if (verb === 'gather') {
    if (obj.kind === 'tree' && obj.hasFruit) {
      addYield(unit, FRUIT_YIELD);
      obj.hasFruit = false;
    }
    unit.job = undefined;
    return;
  }
  const rule = HARVEST_RULES[obj.kind];
  // Lost the required tool since the job started? Abandon it.
  if (rule?.require && !unit.tools.includes(rule.require)) {
    unit.job = undefined;
    return;
  }
  // The matching tool chips faster; bare hands still work (except gated objects).
  const power = rule?.boost && unit.tools.includes(rule.boost) ? HARVEST_POWER.boosted : HARVEST_POWER.base;
  obj.hp -= power;
  if (obj.hp <= 0) {
    addYield(unit, yieldsFor(obj));
    tile.object = undefined;
    unit.job = undefined;
  }
}

function verbFor(obj: WorldObject): 'chop' | 'mine' | 'gather' {
  if (obj.kind === 'tree') return obj.hasFruit ? 'gather' : 'chop';
  return 'mine';
}

function yieldsFor(obj: WorldObject): Record<string, number> {
  if (obj.kind === 'tree') return TREES[obj.type]?.yields ?? {};
  if (obj.kind === 'rock') return ROCKS[obj.type]?.yields ?? {};
  return ORES[obj.type]?.yields ?? {};
}

function addYield(unit: Unit, yields: Record<string, number>): void {
  for (const key in yields) {
    unit.inventory[key] = (unit.inventory[key] ?? 0) + yields[key]!;
  }
}

function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

const BFS_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Breadth-first shortest path over walkable tiles (4-connected). Returns the
 *  steps AFTER `start` up to and including the first tile satisfying `isGoal`
 *  ([] if start already satisfies it), or null if unreachable. Small worlds
 *  (≤120²) make a full BFS cheap, and it's only run when a job is assigned. */
function bfsPath(
  world: World,
  start: Coord,
  isGoal: (x: number, y: number) => boolean,
): Coord[] | null {
  if (isGoal(start.x, start.y)) return [];
  const w = world.width;
  const h = world.height;
  const startIdx = start.y * w + start.x;
  const visited = new Uint8Array(w * h);
  const prev = new Int32Array(w * h).fill(-1);
  const queue = [startIdx];
  visited[startIdx] = 1;

  let goalIdx = -1;
  for (let head = 0; head < queue.length && goalIdx < 0; head++) {
    const idx = queue[head]!;
    const x = idx % w;
    const y = (idx / w) | 0;
    for (const [dx, dy] of BFS_DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nidx = ny * w + nx;
      if (visited[nidx] || !isWalkable(world, nx, ny)) continue;
      visited[nidx] = 1;
      prev[nidx] = idx;
      if (isGoal(nx, ny)) {
        goalIdx = nidx;
        break;
      }
      queue.push(nidx);
    }
  }
  if (goalIdx < 0) return null;

  const path: Coord[] = [];
  for (let cur = goalIdx; cur !== startIdx; cur = prev[cur]!) {
    path.push({ x: cur % w, y: (cur / w) | 0 });
  }
  path.reverse();
  return path;
}

/** One tick of best-effort travel toward unit.moveGoal. Follows an optimistic
 *  path (unseen tiles assumed passable), replanning the moment a step turns out
 *  to be known-blocked, and giving up once nothing reachable gets any closer to
 *  the goal — i.e. the colony has now seen enough to know it can't get there. */
function stepTravel(world: World, unit: Unit): void {
  const goal = unit.moveGoal!;
  if (unit.pos.x === goal.x && unit.pos.y === goal.y) {
    unit.moveGoal = undefined;
    unit.path = undefined;
    return;
  }

  // (Re)plan when we have no path, finished one, or the next step is now known
  // to be blocked (a barrier we've just laid eyes on).
  const next = unit.path?.[0];
  if (!unit.path || unit.path.length === 0 || (next && knownBlocked(world, next.x, next.y))) {
    const path = planTravel(world, unit.pos, goal);
    if (!path) {
      unit.moveGoal = undefined; // nothing reachable is nearer → give up
      unit.path = undefined;
      return;
    }
    unit.path = path;
    unit.moveCooldown = 0;
  }

  unit.moveCooldown = (unit.moveCooldown ?? 0) - 1;
  if (unit.moveCooldown <= 0) {
    const step = unit.path![0]!;
    if (knownBlocked(world, step.x, step.y)) {
      unit.path = undefined; // discovered blocked this tick; replan next tick
      unit.moveCooldown = 0;
      return;
    }
    unit.path!.shift();
    unit.pos = step;
    unit.moveCooldown = UNIT_STEP_TICKS;
  }
}

/** Optimistic BFS: shortest path to the reachable tile CLOSEST (Manhattan) to
 *  the goal, treating unseen tiles as passable and only known-blocked tiles as
 *  walls. Returns null when no reachable tile is nearer than `start` — the
 *  caller reads that as "can't make progress, give up". */
function planTravel(world: World, start: Coord, goal: Coord): Coord[] | null {
  const w = world.width;
  const h = world.height;
  const startIdx = start.y * w + start.x;
  const visited = new Uint8Array(w * h);
  const prev = new Int32Array(w * h).fill(-1);
  const queue = [startIdx];
  visited[startIdx] = 1;

  const distTo = (idx: number): number =>
    Math.abs((idx % w) - goal.x) + Math.abs(((idx / w) | 0) - goal.y);

  let bestIdx = startIdx;
  let bestDist = distTo(startIdx);

  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head]!;
    const x = idx % w;
    const y = (idx / w) | 0;
    for (const [dx, dy] of BFS_DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nidx = ny * w + nx;
      if (visited[nidx] || knownBlocked(world, nx, ny)) continue;
      visited[nidx] = 1;
      prev[nidx] = idx;
      const d = distTo(nidx);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = nidx;
      }
      queue.push(nidx);
    }
  }

  if (bestIdx === startIdx) return null;
  const path: Coord[] = [];
  for (let cur = bestIdx; cur !== startIdx; cur = prev[cur]!) {
    path.push({ x: cur % w, y: (cur / w) | 0 });
  }
  path.reverse();
  return path;
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
