// Vision / fog-of-war math, shared so the host and every client agree exactly
// on what the colony can see. Vision is a colony-level property: the union of
// each unit's sight disk. The host uses it to strip hidden objects from the
// snapshot and the AI context (you can't act on what you can't see); the client
// uses the same computation to decide which tiles to draw bright vs. dimmed.
import type { World } from './types.js';

/** How far a unit sees, in tiles, when it carries no explicit radius. */
export const DEFAULT_VISION_RADIUS = 5;

/** Stable "x,y" key for the visible/explored sets. */
export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Set of tile keys visible to the colony right now: the union of every unit's
 *  sight disk (Euclidean, so vision is round, not square). */
export function visibleTiles(world: World): Set<string> {
  const seen = new Set<string>();
  for (const id in world.units) {
    const u = world.units[id]!;
    const r = u.visionRadius ?? DEFAULT_VISION_RADIUS;
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      const y = u.pos.y + dy;
      if (y < 0 || y >= world.height) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = u.pos.x + dx;
        if (x < 0 || x >= world.width) continue;
        seen.add(tileKey(x, y));
      }
    }
  }
  return seen;
}

/** A view of the world with tile objects AND loose ground items removed
 *  everywhere the colony can't currently see — the fog applied at the source.
 *  Units and buildings are the colony's own, so they're left intact. Tiles that
 *  are unchanged keep their original reference (and the whole world is returned
 *  as-is when nothing is hidden), so this is cheap to call every tick. */
export function fogWorld(world: World): World {
  const visible = visibleTiles(world);
  let hidAny = false;
  const tiles = world.tiles.map((tile, i) => {
    if (!tile.object && !tile.items) return tile;
    const x = i % world.width;
    const y = (i / world.width) | 0;
    if (visible.has(tileKey(x, y))) return tile;
    hidAny = true;
    return { ...tile, object: undefined, items: undefined };
  });
  return hidAny ? { ...world, tiles } : world;
}
