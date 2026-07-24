// The one command schema shared by every write path into the world. Both the
// UI (click-a-unit-then-click-a-target) and, from M4, the AI orchestrator emit
// these; the host validates and applies each through sim.applyAction. There is
// no other way to mutate the authoritative world, which keeps UI and AI honest
// and makes every mutation reproducible.
import { toCell } from './coords.js';
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
  // Carry resources from the bag and drop them at tile `at` (the unit walks
  // there first). Onto a storage-depot tile this DEPOSITS into the depot; onto
  // plain ground it drops a loose pile (spilling to nearby ground when full).
  // `item`/`qty` narrow it; omit `item` to unload the whole bag.
  | { type: 'drop'; unitId: string; at: Coord; item?: string; qty?: number }
  // Drop resources on the ground right where the unit stands — no walking.
  // `item`/`qty` narrow it; omit `item` to dump the whole bag at the unit's feet.
  | { type: 'dropNearby'; unitId: string; item?: string; qty?: number }
  // Pick up resources at tile `at` into the bag (the unit walks there first).
  // From a storage-depot tile this WITHDRAWS; from plain ground it collects a
  // loose pile. `item`/`qty` narrow it; omit to grab everything that fits.
  | { type: 'pickup'; unitId: string; at: Coord; item?: string; qty?: number }
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
 *  (e.g. "View → M9, zoom 18 across"). Mirrors describeAction. */
export function describeView(v: ViewCommand): string {
  const bits: string[] = [];
  if (v.center) bits.push(`View → ${toCell(v.center)}`);
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

/** How an action's execution turned out, tracked by the host as the sim plays it
 *  out over subsequent ticks (the pure sim doesn't know about records, so the
 *  host derives this by watching the unit's job/position):
 *   - 'ongoing'     — the job it started is still running (walking, harvesting,
 *                     crafting, building).
 *   - 'done'        — finished with its intended effect (arrived / object
 *                     depleted / building raised / tool crafted).
 *   - 'interrupted' — explicitly cancelled, or superseded by a later command on
 *                     the same unit before it could finish.
 *   - 'error'       — the job ended WITHOUT its effect (couldn't reach, lacked a
 *                     required tool, boxed in) or never started (rejected on
 *                     apply). */
export type ActionStatus = 'ongoing' | 'done' | 'interrupted' | 'error';

/** One action as it happened in the world: the pure Action plus who submitted
 *  it and when. The host keeps a capped ring of these and ships a tail in each
 *  snapshot so every client can render the Actions panel. */
export interface ActionRecord {
  id: string;
  action: Action;
  source: ActionSource;
  /** World tick when the action was dispatched. */
  tick: number;
  /** Live execution status, updated in place by the host as the sim runs.
   *  Optional so older saves (and any record mid-flight) default gracefully. */
  status?: ActionStatus;
  /** Human-readable explanation retained when an action ends in `error`.
   *  Set by the host at the point it knows why the action could not start or
   *  finish, so the Actions panel can explain a failure after the world moves
   *  on. */
  failureReason?: string;
  /** Live progress of the job this action is running (0 → done), updated in
   *  place by the host each tick while `status === 'ongoing'` and cleared when
   *  it resolves. Present only for jobs that HAVE a measurable duration —
   *  move (remaining route distance), harvest (object hp), craft, and build.
   *  Lets the
   *  Actions panel show the same bar the unit inspector does. */
  progress?: { remaining: number; total: number };
}

/** Compact label for a unit id — "unit-0" → "U0" — for the Actions panel and AI
 *  history, where the full id is noise. Falls back to the raw id if it doesn't
 *  match the spawn naming. */
export function unitShort(unitId: string): string {
  const m = /^unit-(\d+)$/.exec(unitId);
  return m ? `U${m[1]}` : unitId;
}

/** "all", "5 wood", or "wood" — a compact item/quantity phrase for drop/pickup
 *  labels, handling the optional item (whole bag) and optional quantity. */
function itemQty(item: string | undefined, qty: number | undefined): string {
  if (!item) return 'all';
  return qty != null ? `${qty} ${item}` : item;
}

/** A short human-readable label for an action, e.g. "Craft pickaxe" or
 *  "Move → M9". Used by the Actions panel and AI history. Coordinates render as
 *  spreadsheet-style cells (see coords.ts) so the log matches the language the
 *  player and AI use. Kept here so UI and any future logging share one phrasing. */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'move':
      return `Move → ${toCell(action.to)}`;
    case 'harvest':
      return `Harvest ${toCell(action.target)}`;
    case 'craft':
      return `Craft ${action.recipe}`;
    case 'build':
      return `Build ${action.building} @ ${toCell(action.at)}`;
    case 'drop':
      return `Drop ${itemQty(action.item, action.qty)} → ${toCell(action.at)}`;
    case 'dropNearby':
      return `Drop nearby ${itemQty(action.item, action.qty)}`;
    case 'pickup':
      return `Pick up ${itemQty(action.item, action.qty)} @ ${toCell(action.at)}`;
    case 'cancel':
      return 'Cancel job';
  }
}
