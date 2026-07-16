// Turn a model's text response into validated Actions (and an optional reply).
// The model is asked for a JSON object {actions, msg}, but we stay defensive:
// strip code fences, and accept either that object OR a bare actions array.
// Every action is validated against the real world (unit exists, coords
// in-bounds, known recipe/building); anything that fails is dropped —
// applyAction is the final authority, but rejecting garbage here keeps the
// audit log honest about what we actually tried to run.
import { BUILDINGS, RECIPES } from '@game/shared';
import type { Action, Coord, MemoryOp, World } from '@game/shared';
import { MEMORY_MAX_LEN } from './memory.js';

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

/** Cap on how many edit ops we accept from a single response, so a runaway
 *  model can't flood the audit log or the applier. Generous — real edits are a
 *  handful. Length/count caps on the RESULT live in memory.ts. */
const MEMORY_MAX_OPS = 20;

/** Parse a "memory" field into a list of edit ops, or undefined to signal "no
 *  change" (field absent / not an array / no valid ops). This is the whole
 *  point of the op format: the model sends a few tiny diffs addressing items by
 *  their 1-based id, never the full list — so there is nothing to echo back and
 *  memory edits stay cheap even when memory is large.
 *
 *  Accepted per entry:
 *   - {op:"add", text} — text non-empty after trim
 *   - {op:"edit", id, text} — id an integer ≥1, text non-empty
 *   - {op:"del"|"delete"|"remove", id} — id an integer ≥1
 *  Anything malformed is dropped. Returns undefined (not []) when nothing valid
 *  survives, so the host treats it as "left memory alone". */
function parseMemoryOps(raw: unknown): MemoryOp[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ops: MemoryOp[] = [];
  for (const item of raw) {
    if (ops.length >= MEMORY_MAX_OPS) break;
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o.op === 'string' ? o.op.trim().toLowerCase() : '';
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, MEMORY_MAX_LEN).trim() : '';
    const id = Number.isInteger(o.id) ? (o.id as number) : NaN;
    if (kind === 'add') {
      if (text) ops.push({ op: 'add', text });
    } else if (kind === 'edit') {
      if (id >= 1 && text) ops.push({ op: 'edit', id, text });
    } else if (kind === 'del' || kind === 'delete' || kind === 'remove') {
      if (id >= 1) ops.push({ op: 'del', id });
    }
  }
  return ops.length ? ops : undefined;
}

/** The parsed model response: accepted actions, an optional reply, and an
 *  optional list of memory edit ops (present only when the model changed
 *  memory). */
export interface OrchestratorResponse {
  actions: Action[];
  msg?: string;
  /** Memory edit ops to apply, or undefined to leave memory unchanged. */
  memoryOps?: MemoryOp[];
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
    const memoryOps = parseMemoryOps(o.memory);
    const res: OrchestratorResponse = { actions };
    if (msg) res.msg = msg;
    if (memoryOps !== undefined) res.memoryOps = memoryOps;
    return res;
  }

  // Fallback: a bare array of actions, no message.
  return { actions: validateList(sliceJson(cleaned, '[', ']'), world) };
}

/** Parse + validate a model response into accepted Actions (actions only). */
export function parseActions(text: string, world: World): Action[] {
  return validateList(extractArray(text), world);
}
