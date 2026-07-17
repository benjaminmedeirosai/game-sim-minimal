// Derived unit/object stats — all PURE functions over plain world data, so the
// sim (authoritative), the client (display), and the AI prompt (durations) read
// the exact same numbers and never drift. Nothing here mutates anything.
import { BASE_TPS, UNIT_STEP_TICKS } from './config.js';
import {
  HAND_DAMAGE,
  MINING_TOOL_MODIFIER,
  OBJECT_DEFENSE,
  TOOL_DAMAGE,
} from './registry/recipes.js';
import { DEFAULT_BAG_CAPACITY, itemWeight } from './registry/items.js';
import type { Unit, WorldObject } from './types.js';

// --- Bag & encumbrance ----------------------------------------------------

/** Total bag weight: every inventory stack (qty × item weight) plus every tool
 *  carried. Tools count too, so a well-equipped unit carries less loot. */
export function unitLoad(unit: Unit): number {
  let load = 0;
  for (const key in unit.inventory) load += itemWeight(key) * (unit.inventory[key] ?? 0);
  for (const tool of unit.tools) load += itemWeight(tool);
  return load;
}

/** This unit's carry capacity (falls back to the default for older saves). */
export function unitCapacity(unit: Unit): number {
  return unit.capacity ?? DEFAULT_BAG_CAPACITY;
}

/** Load as a fraction of capacity. 0 = empty, 1 = exactly full; may exceed 1
 *  when a unit is overfilled (a stack that pushed it past the limit). */
export function encumbrance(unit: Unit): number {
  const cap = unitCapacity(unit);
  return cap > 0 ? unitLoad(unit) / cap : 0;
}

/** Fill-bar colour band for a given fill ratio. Black = fully encumbered: the
 *  bag is at (or over) capacity and can't take anything else. */
export function bagLevel(ratio: number): 'green' | 'yellow' | 'red' | 'black' {
  if (ratio >= 1) return 'black';
  if (ratio >= 0.8) return 'red';
  if (ratio >= 0.5) return 'yellow';
  return 'green';
}

/** True once the bag is full (or over) — the unit can't pick up any more. */
export function isEncumbered(unit: Unit): boolean {
  return encumbrance(unit) >= 1;
}

// --- Movement speed -------------------------------------------------------

const SPEED_MIN = 0.2; // never slower than 1/5 base, even wildly overfilled
const SPEED_DROP = 0.7; // how much of base speed a full bag removes
const SPEED_EXP = 2.8; // curve shape: each added weight bites harder than the last

/** Speed multiplier from a fill ratio: 1 when empty, tapering on a convex curve
 *  so light loads barely matter and a full bag hurts. Tuned to hit the design
 *  checkmarks — f(0)=1, f(0.5)≈0.9, f(0.9)≈0.48 (~2× slower), f(1)=0.3. */
export function speedMult(ratio: number): number {
  const r = Math.max(0, ratio);
  return Math.min(1, Math.max(SPEED_MIN, 1 - SPEED_DROP * Math.pow(r, SPEED_EXP)));
}

/** Base (unencumbered) move speed in tiles/second, from the tick cadence. */
export function baseSpeed(): number {
  return BASE_TPS / UNIT_STEP_TICKS;
}

/** Current move speed in tiles/second after encumbrance. */
export function effectiveSpeed(unit: Unit): number {
  return baseSpeed() * speedMult(encumbrance(unit));
}

// --- Harvest damage vs defense --------------------------------------------

/** Damage a unit deals per work tick for a given harvest verb, given its tools.
 *  Chop uses an axe, mine uses a pickaxe (with the mining multiplier); without
 *  the matching tool it's bare-handed. Gather is instant, so damage is unused. */
export function harvestDamage(verb: 'chop' | 'mine' | 'gather', tools: string[]): number {
  if (verb === 'chop') return tools.includes('axe') ? TOOL_DAMAGE.axe! : HAND_DAMAGE;
  if (verb === 'mine') {
    return tools.includes('pickaxe') ? TOOL_DAMAGE.pickaxe! * MINING_TOOL_MODIFIER : HAND_DAMAGE;
  }
  return HAND_DAMAGE;
}

/** An object's defense (damage needed per 1 hp removed). Reads a per-object
 *  override if present, else the kind default, else 1. */
export function objectDefense(obj: WorldObject): number {
  return obj.defense ?? OBJECT_DEFENSE[obj.kind] ?? 1;
}
