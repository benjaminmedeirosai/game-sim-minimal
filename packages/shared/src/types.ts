// The world model. Kept plain-data and serializable end-to-end: the host holds
// the authoritative World, ships it over the wire as JSON, and clients render
// it. No methods on the data — behavior lives in sim.ts as pure functions.

export interface Coord {
  x: number;
  y: number;
}

export type TerrainType = 'grass' | 'dirt' | 'stone' | 'water' | 'sand';

export type WorldObject =
  | { kind: 'tree'; type: string; hasFruit: boolean; hp: number }
  | { kind: 'rock'; type: string; hp: number }
  | { kind: 'ore'; type: string; hp: number };

export interface Tile {
  terrain: TerrainType;
  object?: WorldObject;
  /** Id of a building occupying this tile (blocks movement). Details live in
   *  world.buildings; this is the O(1) occupancy flag for pathfinding. */
  building?: string;
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

/** Crafting a tool in place: counts down each tick, then adds the tool. */
export interface CraftJob {
  recipe: string;
  remaining: number;
}

/** Raising a building: the unit walks adjacent to `at`, then works it down. */
export interface BuildJob {
  building: string;
  at: Coord;
  remaining: number;
}

export interface Unit {
  id: string;
  kind: 'human';
  pos: Coord;
  inventory: Record<string, number>;
  /** Tools the unit is carrying (gate/speed harvesting; see HARVEST_RULES). */
  tools: string[];
  /** Remaining tiles to walk (BFS result), excluding the current pos. */
  path?: Coord[];
  /** Ticks remaining until the next walk step (movement cadence). */
  moveCooldown?: number;
  /** Work to perform on arrival; cleared when the job finishes or is replaced. */
  job?: UnitJob;
  /** Active crafting job (mutually exclusive with job/buildJob). */
  craftJob?: CraftJob;
  /** Active building job (mutually exclusive with job/craftJob). */
  buildJob?: BuildJob;
}

export interface Building {
  id: string;
  type: string;
  pos: Coord;
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
