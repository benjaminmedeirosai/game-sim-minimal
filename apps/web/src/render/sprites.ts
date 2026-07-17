// Flat-SVG glyph for each world object, drawn in unit tile-space (0..1). Later
// milestones swap these string builders for <image> sprites keyed by the same
// type ids — nothing else needs to change.
import { BUILDINGS, ORES, ROCKS, TREES } from '@game/shared';
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

/** A placed building, drawn in unit tile-space. A little house glyph tinted by
 *  the building's registry colors; `ghost` dims it for placement preview. */
export function buildingSvg(type: string, ghost = false): string {
  const def = BUILDINGS[type] ?? BUILDINGS.campfire!;
  const op = ghost ? 0.5 : 1;
  return (
    `<g opacity="${op}">` +
    `<ellipse cx="0.5" cy="0.86" rx="0.32" ry="0.08" fill="#00000038"/>` +
    `<rect x="0.24" y="0.46" width="0.52" height="0.38" rx="0.04" fill="${def.color}" stroke="#00000033" stroke-width="0.02"/>` +
    `<path d="M0.18 0.48 L0.5 0.24 L0.82 0.48 Z" fill="${def.roofColor}" stroke="#00000033" stroke-width="0.02"/>` +
    `<rect x="0.43" y="0.62" width="0.14" height="0.22" rx="0.02" fill="#00000055"/>` +
    `</g>`
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
