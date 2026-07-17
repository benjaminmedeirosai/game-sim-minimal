// Data-driven item catalogue: everything a unit can carry (harvested resources
// and crafted tools) with a per-item WEIGHT. Weight × quantity is what fills a
// unit's bag; the bag's capacity + how full it is drives encumbrance (see
// stats.ts). Adding a new item = an entry here; unknown items fall back to
// weight 1 via itemWeight() so nothing crashes if a yield isn't listed yet.

export interface ItemDef {
  label: string;
  /** Bag weight per unit of this item (resources) or per tool carried. */
  weight: number;
}

export const ITEMS: Record<string, ItemDef> = {
  // Harvested resources.
  wood: { label: 'Wood', weight: 1 },
  stone: { label: 'Stone', weight: 2 },
  fruit: { label: 'Fruit', weight: 0.5 },
  ironOre: { label: 'Iron ore', weight: 3 },
  copperOre: { label: 'Copper ore', weight: 3 },
  goldOre: { label: 'Gold ore', weight: 4 },
  // Craftable tools (carried in `tools`, still count toward the bag).
  axe: { label: 'Axe', weight: 4 },
  pickaxe: { label: 'Pickaxe', weight: 6 },
};

// How much a fresh unit can carry before it's fully encumbered (see stats.ts).
export const DEFAULT_BAG_CAPACITY = 50;

/** Weight of one unit of `id`. Unknown items weigh 1 so an unlisted yield still
 *  has a sane, non-zero footprint rather than being free to carry. */
export function itemWeight(id: string): number {
  return ITEMS[id]?.weight ?? 1;
}
