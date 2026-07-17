// The one command schema shared by every write path into the world. Both the
// UI (click-a-unit-then-click-a-target) and, from M4, the AI orchestrator emit
// these; the host validates and applies each through sim.applyAction. There is
// no other way to mutate the authoritative world, which keeps UI and AI honest
// and makes every mutation reproducible.
import type { Coord } from './types.js';

export type Action =
  // Walk a unit to a specific (walkable) tile.
  | { type: 'move'; unitId: string; to: Coord }
  // Send a unit to work the object on a tile. The verb (chop/mine/gather) is
  // derived from what's there, so the caller doesn't have to know.
  | { type: 'harvest'; unitId: string; target: Coord }
  // Craft a tool (recipe id) in place, consuming inventory over its work ticks.
  | { type: 'craft'; unitId: string; recipe: string }
  // Walk to a tile and raise a building there, consuming inventory on completion.
  | { type: 'build'; unitId: string; building: string; at: Coord }
  // Stop a unit's current non-interruptible job (craft/build/harvest), leaving
  // it idle. The one command accepted against a busy unit; craft inputs are
  // refunded (nothing was produced). No-op on an idle/moving unit.
  | { type: 'cancel'; unitId: string };

export type ActionType = Action['type'];

// --- View commands -------------------------------------------------------
// A camera move the AI can request on a player's behalf. Deliberately NOT part
// of the Action union: an Action mutates the authoritative world (and must stay
// pure + reproducible), whereas this only nudges ONE client's on-screen camera.
// It never reaches applyAction — the host routes it to the requesting player as
// a `setCamera` HostMsg. `center` pans; `tilesAcross` sets zoom (how many tiles
// wide to show — smaller = closer). At least one is present.
export type ViewCommand = { type: 'setView'; center?: Coord; tilesAcross?: number };

/** A short human-readable label for a view command, for the AI history + chat
 *  (e.g. "View → (12, 8), zoom 18 across"). Mirrors describeAction. */
export function describeView(v: ViewCommand): string {
  const bits: string[] = [];
  if (v.center) bits.push(`View → (${v.center.x}, ${v.center.y})`);
  if (v.tilesAcross != null) bits.push(`zoom ${v.tilesAcross} across`);
  return bits.length ? bits.join(', ') : 'View unchanged';
}

// --- Attribution ---------------------------------------------------------
// WHO submitted an action. This is metadata that rides ALONGSIDE the action in
// the host's log — it is deliberately NOT part of the Action itself, so the
// sim stays pure and reproducible (applyAction never sees a source). Multiple
// players and the AI all write through the same schema; the source is how the
// Actions panel colors and labels each entry.
export type ActionSource =
  | { kind: 'player'; peerId: string; name: string }
  // `agent` is which AI produced it; `onBehalfOf` is the player whose command
  // triggered it (absent when the AI acts autonomously / on standing orders).
  | { kind: 'ai'; agent: string; onBehalfOf?: string };

/** One action as it happened in the world: the pure Action plus who submitted
 *  it and when. The host keeps a capped ring of these and ships a tail in each
 *  snapshot so every client can render the Actions panel. */
export interface ActionRecord {
  id: string;
  action: Action;
  source: ActionSource;
  /** World tick when the action was dispatched. */
  tick: number;
}

/** A short human-readable label for an action, e.g. "Craft pickaxe" or
 *  "Move → (12, 8)". Used by the Actions panel and AI history. Kept here so UI
 *  and any future logging share one phrasing. */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'move':
      return `Move → (${action.to.x}, ${action.to.y})`;
    case 'harvest':
      return `Harvest (${action.target.x}, ${action.target.y})`;
    case 'craft':
      return `Craft ${action.recipe}`;
    case 'build':
      return `Build ${action.building} @ (${action.at.x}, ${action.at.y})`;
    case 'cancel':
      return 'Cancel job';
  }
}
