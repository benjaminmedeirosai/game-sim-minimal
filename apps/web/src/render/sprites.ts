// Flat-SVG glyph for each world object, drawn in unit tile-space (0..1). Later
// milestones swap these string builders for <image> sprites keyed by the same
// type ids — nothing else needs to change.
import { BUILDINGS, ORES, ROCKS, TREES, itemColor } from '@game/shared';
import type { WorldObject } from '@game/shared';

export function objectSvg(obj: WorldObject): string {
  switch (obj.kind) {
    case 'tree':
      return tree(obj.type, obj.hasFruit);
    case 'rock':
      return rock(obj.type);
    case 'ore':
      return ore(obj.type);
  }
}

function tree(type: string, hasFruit: boolean): string {
  const def = TREES[type] ?? TREES.oak!;
  const trunk = `<rect x="0.44" y="0.55" width="0.12" height="0.34" rx="0.03" fill="#5a3d22"/>`;
  const canopy = `<circle cx="0.5" cy="0.42" r="0.3" fill="${def.color}"/>`;
  const fruit = hasFruit
    ? `<circle cx="0.38" cy="0.36" r="0.05" fill="${def.fruitColor}"/>` +
      `<circle cx="0.6" cy="0.48" r="0.05" fill="${def.fruitColor}"/>` +
      `<circle cx="0.56" cy="0.3" r="0.05" fill="${def.fruitColor}"/>`
    : '';
  return trunk + canopy + fruit;
}

function rock(type: string): string {
  const def = ROCKS[type] ?? ROCKS.granite!;
  return (
    `<path d="M0.2 0.72 L0.34 0.4 L0.56 0.34 L0.76 0.5 L0.82 0.72 Z" ` +
    `fill="${def.color}" stroke="#00000033" stroke-width="0.02"/>`
  );
}

/** A human unit, drawn in unit tile-space like the objects. A gold ring marks
 *  the current selection. */
export function unitSvg(selected: boolean): string {
  const ring = selected
    ? `<circle cx="0.5" cy="0.5" r="0.46" fill="none" stroke="#ffd54a" stroke-width="0.07"/>`
    : '';
  return (
    ring +
    `<ellipse cx="0.5" cy="0.84" rx="0.22" ry="0.07" fill="#00000038"/>` +
    `<rect x="0.34" y="0.44" width="0.32" height="0.36" rx="0.13" fill="#4a6fa5"/>` +
    `<circle cx="0.5" cy="0.34" r="0.16" fill="#f0c9a0"/>`
  );
}

/** A placed building, drawn in unit tile-space. Each type has its own glyph so
 *  they read at a glance — a fire, a workbench, a warehouse, a house. `ghost`
 *  dims it for the placement preview. */
export function buildingSvg(type: string, ghost = false): string {
  const def = BUILDINGS[type] ?? BUILDINGS.campfire!;
  const op = ghost ? 0.5 : 1;
  const glyph =
    type === 'campfire'
      ? campfire()
      : type === 'workbench'
        ? workbench(def.color)
        : type === 'storage'
          ? storage(def.color, def.roofColor)
          : house(def.color, def.roofColor); // house + any unknown type
  return `<g opacity="${op}">${BUILDING_SHADOW}${glyph}</g>`;
}

const BUILDING_SHADOW = `<ellipse cx="0.5" cy="0.86" rx="0.32" ry="0.08" fill="#00000038"/>`;

/** A campfire: two crossed logs with a flame — no walls, it sits on the ground. */
function campfire(): string {
  return (
    `<rect x="0.2" y="0.63" width="0.6" height="0.1" rx="0.05" fill="#7a5433" stroke="#00000040" stroke-width="0.015" transform="rotate(20 0.5 0.68)"/>` +
    `<rect x="0.2" y="0.63" width="0.6" height="0.1" rx="0.05" fill="#8a5f38" stroke="#00000040" stroke-width="0.015" transform="rotate(-20 0.5 0.68)"/>` +
    `<path d="M0.5 0.22 Q0.67 0.42 0.57 0.56 Q0.69 0.5 0.64 0.63 Q0.6 0.71 0.5 0.71 Q0.4 0.71 0.36 0.63 Q0.31 0.5 0.43 0.56 Q0.33 0.42 0.5 0.22 Z" fill="#f0842b"/>` +
    `<path d="M0.5 0.36 Q0.58 0.5 0.5 0.63 Q0.42 0.5 0.5 0.36 Z" fill="#ffd23c"/>`
  );
}

/** A workbench: a wooden table with a plank and a hammer on top. */
function workbench(wood: string): string {
  return (
    `<rect x="0.25" y="0.56" width="0.06" height="0.26" fill="#5f4126"/>` +
    `<rect x="0.69" y="0.56" width="0.06" height="0.26" fill="#5f4126"/>` +
    `<rect x="0.16" y="0.48" width="0.68" height="0.12" rx="0.02" fill="${wood}" stroke="#00000040" stroke-width="0.02"/>` +
    `<rect x="0.26" y="0.4" width="0.3" height="0.07" rx="0.02" fill="#b98a4e" stroke="#00000030" stroke-width="0.015"/>` +
    `<rect x="0.62" y="0.3" width="0.035" height="0.16" rx="0.015" fill="#5f4126" transform="rotate(18 0.64 0.38)"/>` +
    `<rect x="0.58" y="0.28" width="0.14" height="0.055" rx="0.02" fill="#9aa0a6" stroke="#00000035" stroke-width="0.015" transform="rotate(18 0.65 0.31)"/>`
  );
}

/** A storage warehouse: a wide body with a low gable roof and a big slatted
 *  roll-up door. */
function storage(wall: string, roof: string): string {
  return (
    `<rect x="0.14" y="0.46" width="0.72" height="0.38" rx="0.02" fill="${wall}" stroke="#00000040" stroke-width="0.02"/>` +
    `<path d="M0.1 0.48 L0.5 0.3 L0.9 0.48 Z" fill="${roof}" stroke="#00000040" stroke-width="0.02"/>` +
    `<rect x="0.37" y="0.52" width="0.26" height="0.32" rx="0.01" fill="#00000045"/>` +
    `<path d="M0.37 0.6 h0.26 M0.37 0.68 h0.26 M0.37 0.76 h0.26" stroke="#ffffff22" stroke-width="0.015"/>`
  );
}

/** A house: pitched roof, door, and a little window (the old building glyph). */
function house(wall: string, roof: string): string {
  return (
    `<rect x="0.24" y="0.46" width="0.52" height="0.38" rx="0.04" fill="${wall}" stroke="#00000033" stroke-width="0.02"/>` +
    `<path d="M0.18 0.48 L0.5 0.24 L0.82 0.48 Z" fill="${roof}" stroke="#00000033" stroke-width="0.02"/>` +
    `<rect x="0.44" y="0.62" width="0.14" height="0.22" rx="0.02" fill="#00000055"/>` +
    `<rect x="0.28" y="0.52" width="0.12" height="0.12" rx="0.02" fill="#ffe9a8" stroke="#00000033" stroke-width="0.015"/>`
  );
}

/** A work-in-progress construction site, drawn while a unit is building here
 *  (before the finished structure exists). A ghosted preview of the target
 *  building under a dashed hazard outline + a little corner marker, so players
 *  see intent the moment work starts. */
export function constructionSvg(type: string): string {
  return (
    `<g opacity="0.9">` +
    buildingSvg(type, true) +
    `<rect x="0.12" y="0.12" width="0.76" height="0.76" rx="0.05" fill="none" ` +
    `stroke="#e0b23c" stroke-width="0.05" stroke-dasharray="0.12 0.08" opacity="0.85"/>` +
    `<rect x="0.4" y="0.06" width="0.2" height="0.14" rx="0.02" fill="#e0b23c"/>` +
    `<path d="M0.44 0.13 h0.12 M0.5 0.08 v0.1" stroke="#3a2c0a" stroke-width="0.02"/>` +
    `</g>`
  );
}

/** Loose resources on a tile. A ground tile holds ONE resource, so the common
 *  case draws a single bold, recognizable sprite (a log, a stone, a fruit…). A
 *  storage depot can hold several, so multiple keys fall back to a small cluster
 *  of icons. */
export function itemsSvg(items: Record<string, number>): string {
  const keys = Object.keys(items).filter((k) => (items[k] ?? 0) > 0);
  if (!keys.length) return '';
  if (keys.length === 1) return itemSvg(keys[0]!, items[keys[0]!]!);
  // Depot with a mix: shrink each glyph and tuck them into a little pile.
  const spots: Array<[number, number]> = [
    [0.32, 0.66],
    [0.66, 0.66],
    [0.5, 0.48],
    [0.5, 0.78],
    [0.24, 0.84],
    [0.76, 0.84],
  ];
  return keys
    .slice(0, spots.length)
    .map((k, i) => {
      const [cx, cy] = spots[i] ?? spots[0]!;
      return `<g transform="translate(${cx - 0.16} ${cy - 0.16}) scale(0.34)">${itemGlyph(k)}</g>`;
    })
    .join('');
}

/** One loose resource, drawn bold in tile-space (0..1) sitting low like it's on
 *  the ground, with a ground shadow and (for a stack) a small count badge. */
export function itemSvg(id: string, qty?: number): string {
  const shadow = `<ellipse cx="0.5" cy="0.82" rx="0.26" ry="0.06" fill="#00000030"/>`;
  const count = qty && qty > 1 ? countBadge(qty) : '';
  return shadow + itemGlyph(id) + count;
}

/** The recognizable shape for a resource id, minus shadow/badge (so it can be
 *  reused at any scale). Unknown ids fall back to a tinted sack. */
function itemGlyph(id: string): string {
  switch (id) {
    case 'wood':
      return log();
    case 'stone':
      return stones();
    case 'fruit':
      return fruit();
    case 'axe':
      return axeGlyph();
    case 'pickaxe':
      return pickaxeGlyph();
  }
  if (id.endsWith('Ore')) return nugget(id);
  return sack(id);
}

/** A felled log lying on its side: rounded bark barrel with visible end-grain. */
function log(): string {
  return (
    `<rect x="0.14" y="0.5" width="0.72" height="0.26" rx="0.13" fill="#7a5433" stroke="#00000045" stroke-width="0.02"/>` +
    `<ellipse cx="0.2" cy="0.63" rx="0.075" ry="0.13" fill="#c9a469" stroke="#00000045" stroke-width="0.018"/>` +
    `<ellipse cx="0.2" cy="0.63" rx="0.038" ry="0.07" fill="#a67d47"/>` +
    `<path d="M0.42 0.52 v0.22 M0.58 0.52 v0.22 M0.72 0.53 v0.2" stroke="#00000028" stroke-width="0.014"/>`
  );
}

/** A couple of smooth grey stones. */
function stones(): string {
  return (
    `<path d="M0.22 0.74 Q0.17 0.5 0.4 0.48 Q0.58 0.47 0.57 0.66 Q0.56 0.76 0.38 0.76 Z" ` +
    `fill="#9297a0" stroke="#00000045" stroke-width="0.02"/>` +
    `<path d="M0.52 0.76 Q0.49 0.58 0.66 0.56 Q0.82 0.56 0.81 0.7 Q0.8 0.78 0.65 0.78 Z" ` +
    `fill="#b2b7bf" stroke="#00000045" stroke-width="0.02"/>` +
    `<ellipse cx="0.34" cy="0.56" rx="0.06" ry="0.03" fill="#ffffff30"/>`
  );
}

/** A round fruit with a leaf and stem, tinted by the registry colour. */
function fruit(): string {
  const c = itemColor('fruit');
  return (
    `<circle cx="0.5" cy="0.61" r="0.21" fill="${c}" stroke="#00000030" stroke-width="0.015"/>` +
    `<ellipse cx="0.42" cy="0.53" rx="0.06" ry="0.035" fill="#ffffff55"/>` +
    `<rect x="0.485" y="0.34" width="0.03" height="0.1" rx="0.015" fill="#5a3d22"/>` +
    `<path d="M0.51 0.4 Q0.62 0.32 0.71 0.37 Q0.63 0.46 0.51 0.44 Z" fill="#4f9d47" stroke="#00000025" stroke-width="0.012"/>`
  );
}

/** An ore nugget with brighter flecks, tinted by the item colour. */
function nugget(id: string): string {
  const c = itemColor(id);
  return (
    `<path d="M0.28 0.74 L0.33 0.52 L0.5 0.44 L0.69 0.51 L0.74 0.72 L0.5 0.79 Z" ` +
    `fill="${c}" stroke="#00000045" stroke-width="0.02"/>` +
    `<circle cx="0.44" cy="0.6" r="0.045" fill="#ffffffaa"/>` +
    `<circle cx="0.6" cy="0.56" r="0.038" fill="#ffffff88"/>` +
    `<circle cx="0.54" cy="0.68" r="0.03" fill="#ffffff66"/>`
  );
}

/** An axe: wooden haft with a steel head. */
function axeGlyph(): string {
  return (
    `<rect x="0.34" y="0.24" width="0.06" height="0.56" rx="0.03" fill="#8a5f38" ` +
    `transform="rotate(18 0.5 0.5)" stroke="#00000035" stroke-width="0.015"/>` +
    `<path d="M0.5 0.26 Q0.74 0.28 0.72 0.46 Q0.56 0.44 0.46 0.36 Z" fill="#c7ccd2" stroke="#00000045" stroke-width="0.02"/>`
  );
}

/** A pickaxe: haft with a curved double-pointed head. */
function pickaxeGlyph(): string {
  return (
    `<rect x="0.47" y="0.28" width="0.06" height="0.5" rx="0.03" fill="#8a5f38" stroke="#00000035" stroke-width="0.015"/>` +
    `<path d="M0.2 0.42 Q0.5 0.24 0.8 0.42 Q0.5 0.34 0.2 0.42 Z" fill="#c7ccd2" stroke="#00000045" stroke-width="0.02"/>`
  );
}

/** Fallback for an unknown item: a tinted little sack. */
function sack(id: string): string {
  const c = itemColor(id);
  return (
    `<path d="M0.32 0.78 Q0.28 0.46 0.5 0.44 Q0.72 0.46 0.68 0.78 Z" fill="${c}" stroke="#00000045" stroke-width="0.02"/>` +
    `<path d="M0.4 0.46 Q0.5 0.38 0.6 0.46" fill="none" stroke="#00000045" stroke-width="0.02"/>`
  );
}

/** A small dark pill with the stack count, tucked at the item's lower-right. */
function countBadge(n: number): string {
  const s = String(n);
  const w = 0.13 + s.length * 0.1;
  const x = 0.88 - w;
  return (
    `<g transform="translate(${x} 0.58)">` +
    `<rect x="0" y="0" width="${w}" height="0.24" rx="0.06" fill="#000000aa"/>` +
    `<text x="${w / 2}" y="0.185" font-size="0.185" fill="#fff" text-anchor="middle" ` +
    `font-family="system-ui, sans-serif" font-weight="600">${s}</text>` +
    `</g>`
  );
}

function ore(type: string): string {
  const def = ORES[type] ?? ORES.iron!;
  const body =
    `<path d="M0.2 0.72 L0.34 0.4 L0.56 0.34 L0.76 0.5 L0.82 0.72 Z" ` +
    `fill="${def.color}" stroke="#00000033" stroke-width="0.02"/>`;
  const flecks =
    `<circle cx="0.4" cy="0.55" r="0.055" fill="${def.fleckColor}"/>` +
    `<circle cx="0.58" cy="0.48" r="0.05" fill="${def.fleckColor}"/>` +
    `<circle cx="0.52" cy="0.63" r="0.045" fill="${def.fleckColor}"/>`;
  return body + flecks;
}
