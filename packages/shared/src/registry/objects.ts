// Data-driven content registry. Adding a new tree/rock/ore type = adding an
// entry here; worldgen and rendering read from these maps, no logic changes.
// `color` is the flat-SVG fill we render now; later we swap in image sprites
// keyed by the same type ids.

export interface TreeDef {
  color: string;
  fruitColor: string;
  /** Resources yielded when chopped (used from M2). */
  yields: Record<string, number>;
}

export interface RockDef {
  color: string;
  yields: Record<string, number>;
}

export interface OreDef {
  color: string;
  fleckColor: string;
  yields: Record<string, number>;
}

export const TREES: Record<string, TreeDef> = {
  oak: { color: '#4a8b3a', fruitColor: '#d64545', yields: { wood: 4 } },
  pine: { color: '#2f6f47', fruitColor: '#c9553d', yields: { wood: 5 } },
  birch: { color: '#7cb356', fruitColor: '#e0803a', yields: { wood: 3 } },
};

export const ROCKS: Record<string, RockDef> = {
  granite: { color: '#8a8d94', yields: { stone: 3 } },
  basalt: { color: '#565a63', yields: { stone: 4 } },
};

export const ORES: Record<string, OreDef> = {
  iron: { color: '#7c7f86', fleckColor: '#c98a5a', yields: { ironOre: 3 } },
  copper: { color: '#7c7f86', fleckColor: '#d1863c', yields: { copperOre: 3 } },
  gold: { color: '#7c7f86', fleckColor: '#e3c34a', yields: { goldOre: 2 } },
};

export const TERRAIN_COLORS: Record<string, string> = {
  grass: '#3f6b34',
  dirt: '#6b5433',
  stone: '#63666d',
  water: '#2f5e8f',
  sand: '#c2ab6a',
};

export const TREE_TYPES = Object.keys(TREES);
export const ROCK_TYPES = Object.keys(ROCKS);
export const ORE_TYPES = Object.keys(ORES);
