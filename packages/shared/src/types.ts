// The world model. Kept plain-data and serializable end-to-end: the host holds
// the authoritative World, ships it over the wire as JSON, and clients render
// it. No methods on the data — behavior lives in sim.ts as pure functions.

export interface Coord {
  x: number;
  y: number;
}

export type TerrainType = 'grass' | 'dirt' | 'stone' | 'water' | 'sand';

// `hp` is remaining hit-points; harvesting removes `damage / defense` per tick.
// `defense` is optional so older saves (which lack it) fall back to the
// per-kind default via stats.objectDefense().
export type WorldObject =
  | { kind: 'tree'; type: string; hasFruit: boolean; hp: number; defense?: number }
  | { kind: 'rock'; type: string; hp: number; defense?: number }
  | { kind: 'ore'; type: string; hp: number; defense?: number };

export interface Tile {
  terrain: TerrainType;
  object?: WorldObject;
  /** Id of a building occupying this tile (blocks movement). Details live in
   *  world.buildings; this is the O(1) occupancy flag for pathfinding. */
  building?: string;
  /** Loose resources lying on the ground here (item id → quantity), dropped when
   *  a full unit keeps harvesting or via a drop command. Each item is capped at
   *  its stack max (see itemStack); a bigger pile spills to neighbouring tiles.
   *  Absent when the tile is bare. Doesn't block movement — units walk over and
   *  pick up. */
  items?: Record<string, number>;
}

export interface WorldSettings {
  width: number;
  height: number;
  seed: number;
  /** Tiles visible across the viewport initially (the "zoom" setting). */
  zoom: number;
}

/** What a unit is doing when it reaches its destination. Absent while a unit
 *  is idle or on a plain move. The verb is chosen from the target object. */
export interface UnitJob {
  /** The object tile being worked (the unit stands on an adjacent tile). */
  target: Coord;
  verb: 'chop' | 'mine' | 'gather';
}

/** Crafting a tool in place: counts down each tick, then adds the tool.
 *  `total` is the starting tick count, kept so the UI can show progress
 *  (optional for older saves mid-craft — defaults to `remaining`). */
export interface CraftJob {
  recipe: string;
  remaining: number;
  total?: number;
}

/** Raising a building: the unit walks adjacent to `at`, then works it down.
 *  `total` mirrors CraftJob.total for the progress bar. */
export interface BuildJob {
  building: string;
  at: Coord;
  remaining: number;
  total?: number;
}

/** Carrying resources to/from a spot: the unit walks ONTO `at` (a ground tile),
 *  then transfers in one tick. `drop` moves `item`×`qty` from bag to ground;
 *  `pickup` loads ground items into the bag (all of `item`, or every item on
 *  the tile when `item` is absent) up to what the bag can still carry. Mutually
 *  exclusive with the other jobs. */
export interface HaulJob {
  op: 'drop' | 'pickup';
  at: Coord;
  item?: string;
  qty?: number;
}

export interface Unit {
  id: string;
  kind: 'human';
  pos: Coord;
  inventory: Record<string, number>;
  /** Tools the unit is carrying (gate/speed harvesting; see HARVEST_RULES). */
  tools: string[];
  /** Combat/vitals stats. Display-only for now (nothing damages units yet);
   *  all optional so older saves default gracefully via stats.ts helpers.
   *  hp/maxHp = hit-points, armor = future damage reduction, capacity = bag
   *  weight the unit can carry before it's fully encumbered. */
  maxHp?: number;
  hp?: number;
  armor?: number;
  capacity?: number;
  /** How far this unit sees, in tiles. Absent → DEFAULT_VISION_RADIUS. */
  visionRadius?: number;
  /** Remaining tiles to walk (BFS result), excluding the current pos. */
  path?: Coord[];
  /** A best-effort travel destination from a plain move command. The unit heads
   *  here using only terrain it has seen (fog-aware), routing around known
   *  obstacles and giving up once nothing reachable gets any closer. Cleared on
   *  arrival, on giving up, or when another job replaces it. */
  moveGoal?: Coord;
  /** Ticks remaining until the next walk step (movement cadence). */
  moveCooldown?: number;
  /** Work to perform on arrival; cleared when the job finishes or is replaced. */
  job?: UnitJob;
  /** Active crafting job (mutually exclusive with job/buildJob). */
  craftJob?: CraftJob;
  /** Active building job (mutually exclusive with job/craftJob). */
  buildJob?: BuildJob;
  /** Active haul job — carrying resources to/from a tile (mutually exclusive
   *  with the other jobs). */
  haulJob?: HaulJob;
}

export interface Building {
  id: string;
  type: string;
  pos: Coord;
  /** Stored resources (item id → quantity) for a storage depot. Capacity is
   *  measured in STACKS: Σ ceil(qty / itemStack) must stay ≤ STORAGE_SLOTS, so a
   *  partial stack still occupies a whole slot. Absent on non-storage buildings
   *  and empty depots. Units deposit/withdraw by dropping/picking up at the
   *  depot tile. */
  store?: Record<string, number>;
}

export interface World {
  id: string;
  name: string;
  settings: WorldSettings;
  width: number;
  height: number;
  /** Row-major, length = width * height. */
  tiles: Tile[];
  units: Record<string, Unit>;
  buildings: Record<string, Building>;
  /** Monotonic counter for minting unique building ids deterministically. */
  buildingSeq: number;
  tick: number;
}

export function tileIndex(world: World, x: number, y: number): number {
  return y * world.width + x;
}

export function tileAt(world: World, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return undefined;
  return world.tiles[tileIndex(world, x, y)];
}
