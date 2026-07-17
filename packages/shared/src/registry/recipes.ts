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
  house: { label: 'House', color: '#a8895c', roofColor: '#7a4a3a', inputs: { wood: 6, stone: 2 }, workTicks: 20 },
};

// How the object under a harvest job responds to tools, keyed by object.kind:
//   • boost   — holding this tool speeds work up (its TOOL_DAMAGE applies)
//   • require — the job is impossible without this tool (hard gate)
export const HARVEST_RULES: Record<string, { require?: string; boost?: string }> = {
  tree: { boost: 'axe' },
  rock: { boost: 'pickaxe' },
  ore: { require: 'pickaxe', boost: 'pickaxe' },
};

// --- Harvest damage model -------------------------------------------------
// Harvesting is damage-vs-defense: each work tick a unit deals `damage` and the
// object loses `damage / defense` hit-points. So `defense` is how much damage it
// takes to remove ONE hp — high-defense ore barely budges by hand, which is why
// the pickaxe (higher damage + a mining multiplier) makes such a difference.
// Numbers live here so sim, prompt durations, and the UI all read one source.

// Per-object-kind defense (the divisor on incoming damage).
export const OBJECT_DEFENSE: Record<string, number> = { tree: 1, rock: 2, ore: 4 };

// Damage a unit deals per work tick with nothing in hand.
export const HAND_DAMAGE = 1;

// Damage each tool deals per work tick when it's the matching tool for the job.
export const TOOL_DAMAGE: Record<string, number> = { axe: 4, pickaxe: 3 };

// A pickaxe hits rock/ore especially hard: its damage is multiplied by this
// when mining (so the pickaxe's edge is largest on high-defense ore).
export const MINING_TOOL_MODIFIER = 2;

export const RECIPE_IDS = Object.keys(RECIPES);
export const BUILDING_IDS = Object.keys(BUILDINGS);
