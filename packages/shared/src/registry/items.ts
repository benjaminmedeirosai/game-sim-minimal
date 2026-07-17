// Data-driven item catalogue: everything a unit can carry (harvested resources
// and crafted tools) with a per-item WEIGHT. Weight × quantity is what fills a
// unit's bag; the bag's capacity + how full it is drives encumbrance (see
// stats.ts). Adding a new item = an entry here; unknown items fall back to
// weight 1 via itemWeight() so nothing crashes if a yield isn't listed yet.

export interface ItemDef {
  label: string;
  /** Bag weight per unit of this item (resources) or per tool carried. */
  weight: number;
  /** Max quantity in ONE stack — on the ground or in a storage-depot slot. A
   *  bigger drop spills into further stacks/tiles. Tools don't stack (1). */
  stack: number;
  /** Flat fill for the ground-pile glyph. */
  color: string;
}

export const ITEMS: Record<string, ItemDef> = {
  // Harvested resources.
  wood: { label: 'Wood', weight: 1, stack: 50, color: '#a9743e' },
  stone: { label: 'Stone', weight: 2, stack: 40, color: '#8a8d94' },
  fruit: { label: 'Fruit', weight: 0.5, stack: 30, color: '#d64545' },
  ironOre: { label: 'Iron ore', weight: 3, stack: 30, color: '#b6b9c0' },
  copperOre: { label: 'Copper ore', weight: 3, stack: 30, color: '#c07a3c' },
  goldOre: { label: 'Gold ore', weight: 4, stack: 20, color: '#e3c34a' },
  // Craftable tools (carried in `tools`, still count toward the bag).
  axe: { label: 'Axe', weight: 4, stack: 1, color: '#9a9da4' },
  pickaxe: { label: 'Pickaxe', weight: 6, stack: 1, color: '#9a9da4' },
};

// How much a fresh unit can carry before it's fully encumbered (see stats.ts).
export const DEFAULT_BAG_CAPACITY = 50;

// How many stacks a storage depot holds. A partial stack still fills a whole
// slot (10 wood in a 50-stack still occupies one of the ten slots).
export const STORAGE_SLOTS = 10;

/** Weight of one unit of `id`. Unknown items weigh 1 so an unlisted yield still
 *  has a sane, non-zero footprint rather than being free to carry. */
export function itemWeight(id: string): number {
  return ITEMS[id]?.weight ?? 1;
}

/** Max stack size for `id` (ground pile / depot slot). Unknown items stack to
 *  50 — a sane default so an unlisted yield still piles rather than scattering. */
export function itemStack(id: string): number {
  return ITEMS[id]?.stack ?? 50;
}

/** Display fill for a ground pile of `id` (fallback muted grey). */
export function itemColor(id: string): string {
  return ITEMS[id]?.color ?? '#9aa0aa';
}
