// Data-driven crafting content for M3: the tools a unit can make, the buildings
// it can raise, and how tools gate/accelerate harvesting. Adding content = an
// entry here; the sim reads costs/work from these maps and the UI reads labels,
// so no logic changes when the catalogue grows.

/** A tool a unit carries. Tools gate and/or speed up harvesting (see
 *  HARVEST_RULES). Crafting one consumes `inputs` over `workTicks`. */
export interface ToolRecipe {
  label: string;
  /** Resources consumed to craft (deducted from the unit's inventory). */
  inputs: Record<string, number>;
  /** Ticks of work to finish crafting (unit stands still meanwhile). */
  workTicks: number;
}

export interface BuildingDef {
  label: string;
  /** Body/roof fills for the flat-SVG sprite (swapped for images later). */
  color: string;
  roofColor: string;
  inputs: Record<string, number>;
  workTicks: number;
}

// Bare hands can chop trees and mine rock (slowly), which yields the wood +
// stone needed for the first tools — so there's no chicken-and-egg lock. Ore,
// though, is gated on a pickaxe (see HARVEST_RULES).
export const RECIPES: Record<string, ToolRecipe> = {
  axe: { label: 'Axe', inputs: { wood: 2, stone: 1 }, workTicks: 6 },
  pickaxe: { label: 'Pickaxe', inputs: { wood: 3, stone: 2 }, workTicks: 8 },
};

export const BUILDINGS: Record<string, BuildingDef> = {
  campfire: { label: 'Campfire', color: '#8a4b2a', roofColor: '#e08a3c', inputs: { wood: 3 }, workTicks: 10 },
  workbench: { label: 'Workbench', color: '#7a5a34', roofColor: '#a8804a', inputs: { wood: 5, stone: 2 }, workTicks: 14 },
  storage: { label: 'Storage', color: '#5a6068', roofColor: '#8a5a34', inputs: { wood: 4, stone: 3 }, workTicks: 16 },
};

// How the object under a harvest job responds to tools, keyed by object.kind:
//   • boost   — holding this tool multiplies work speed (HARVEST_POWER.boosted)
//   • require — the job is impossible without this tool (hard gate)
export const HARVEST_RULES: Record<string, { require?: string; boost?: string }> = {
  tree: { boost: 'axe' },
  rock: { boost: 'pickaxe' },
  ore: { require: 'pickaxe', boost: 'pickaxe' },
};

// hp chipped per work tick: bare-handed vs. with the matching tool.
export const HARVEST_POWER = { base: 1, boosted: 3 } as const;

export const RECIPE_IDS = Object.keys(RECIPES);
export const BUILDING_IDS = Object.keys(BUILDINGS);
