// Turn a model's text response into validated Actions (and an optional reply).
// The model is asked for a JSON object {actions, msg}, but we stay defensive:
// strip code fences, and accept either that object OR a bare actions array.
// Every action is validated against the real world (unit exists, coords
// in-bounds, known recipe/building); anything that fails is dropped —
// applyAction is the final authority, but rejecting garbage here keeps the
// audit log honest about what we actually tried to run.
import { BUILDINGS, RECIPES } from '@game/shared';
import type { Action, Coord, World } from '@game/shared';

/** Slice out the first balanced-looking JSON value of a given bracket type and
 *  parse it. Returns the parsed value, or null if none parses. */
function sliceJson(cleaned: string, open: string, close: string): unknown {
  const start = cleaned.indexOf(open);
  const end = cleaned.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Extract the first top-level JSON array from arbitrary model text. Returns
 *  the parsed value, or null if none parses. */
function extractArray(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  return sliceJson(cleaned, '[', ']');
}

function isCoord(v: unknown, world: World): v is Coord {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    Number.isInteger(c.x) &&
    Number.isInteger(c.y) &&
    (c.x as number) >= 0 &&
    (c.y as number) >= 0 &&
    (c.x as number) < world.width &&
    (c.y as number) < world.height
  );
}

function validate(raw: unknown, world: World): Action | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const unitId = a.unitId;
  if (typeof unitId !== 'string' || !world.units[unitId]) return null;

  switch (a.type) {
    case 'move':
      return isCoord(a.to, world) ? { type: 'move', unitId, to: a.to as Coord } : null;
    case 'harvest':
      return isCoord(a.target, world)
        ? { type: 'harvest', unitId, target: a.target as Coord }
        : null;
    case 'craft':
      return typeof a.recipe === 'string' && RECIPES[a.recipe]
        ? { type: 'craft', unitId, recipe: a.recipe }
        : null;
    case 'build':
      return typeof a.building === 'string' && BUILDINGS[a.building] && isCoord(a.at, world)
        ? { type: 'build', unitId, building: a.building, at: a.at as Coord }
        : null;
    default:
      return null;
  }
}

/** Validate an arbitrary list of candidate actions against the world. */
function validateList(arr: unknown, world: World): Action[] {
  if (!Array.isArray(arr)) return [];
  const actions: Action[] = [];
  for (const item of arr) {
    const a = validate(item, world);
    if (a) actions.push(a);
  }
  return actions;
}

/** Caps on saved memory, enforced here so a runaway model can't bloat the
 *  cache-stable prompt: at most this many lines, each trimmed to this length. */
const MEMORY_MAX_ENTRIES = 20;
const MEMORY_MAX_LEN = 200;

/** Parse a "memory" field into the new memory list, or undefined to signal "no
 *  change" (field absent or not an array). An explicit empty array is honored —
 *  it clears memory. Non-string entries and blanks are dropped; the rest are
 *  trimmed, length-capped, and count-capped. */
function parseMemory(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, MEMORY_MAX_LEN).trim();
    if (s) out.push(s);
    if (out.length >= MEMORY_MAX_ENTRIES) break;
  }
  return out;
}

/** The parsed model response: accepted actions, an optional reply, and an
 *  optional new memory list (present only when the model chose to change it). */
export interface OrchestratorResponse {
  actions: Action[];
  msg?: string;
  /** The full replacement memory list, or undefined to leave memory unchanged. */
  memory?: string[];
}

/** Parse a model response into accepted actions + optional player reply.
 *  Accepts the object form {"actions":[...],"msg":"..."} first, then falls back
 *  to a bare actions array (older/looser outputs). */
export function parseResponse(text: string, world: World): OrchestratorResponse {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();

  const obj = sliceJson(cleaned, '{', '}');
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    const actions = validateList(o.actions, world);
    const msg = typeof o.msg === 'string' ? o.msg.trim() : '';
    const memory = parseMemory(o.memory);
    const res: OrchestratorResponse = { actions };
    if (msg) res.msg = msg;
    if (memory !== undefined) res.memory = memory;
    return res;
  }

  // Fallback: a bare array of actions, no message.
  return { actions: validateList(sliceJson(cleaned, '[', ']'), world) };
}

/** Parse + validate a model response into accepted Actions (actions only). */
export function parseActions(text: string, world: World): Action[] {
  return validateList(extractArray(text), world);
}
