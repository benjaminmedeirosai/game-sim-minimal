// Client-side fog of war. The host sends only what the colony can currently
// see (objects outside vision are stripped from the snapshot), so this module
// keeps the client's *memory* of the map: which tiles have ever been seen, and
// the last object observed on each. Three states drive the renderer:
//   • visible   — a unit sees it now → draw live, full brightness.
//   • explored  — seen before, not now → draw the remembered object, dimmed.
//   • unseen    — never seen → undiscovered land, drawn near-black.
// Memory is per-session: a reload re-fogs the map, which is fine.
import { tileKey, visibleTiles } from '@game/shared';
import type { World, WorldObject } from '@game/shared';

let visible = new Set<string>(); // tiles a unit can see right now
const explored = new Set<string>(); // tiles ever seen (sticky)
const remembered = new Map<string, WorldObject>(); // last object seen per tile

/** Fold a fresh snapshot into memory: recompute what's visible now, mark those
 *  tiles explored, and refresh the remembered object for each (clearing it when
 *  a now-visible tile turned out to be empty). Non-visible tiles are left as
 *  they were — that's the stale memory. Call once per snapshot. */
export function updateFog(world: World): void {
  visible = visibleTiles(world);
  for (const key of visible) {
    explored.add(key);
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    const obj = world.tiles[y * world.width + x]?.object;
    if (obj) remembered.set(key, obj);
    else remembered.delete(key);
  }
}

/** Wipe all memory — a new world (id change) starts fully undiscovered. */
export function resetFog(): void {
  visible = new Set();
  explored.clear();
  remembered.clear();
}

export function isVisible(x: number, y: number): boolean {
  return visible.has(tileKey(x, y));
}

export function isExplored(x: number, y: number): boolean {
  return explored.has(tileKey(x, y));
}

/** The last object seen on a tile, if any — used to draw explored-but-not-
 *  visible tiles from memory. */
export function rememberedObject(x: number, y: number): WorldObject | undefined {
  return remembered.get(tileKey(x, y));
}
