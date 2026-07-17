// Turn a model's text response into validated Actions (and an optional reply).
// The model is asked for a JSON object {actions, msg}, but we stay defensive:
// strip code fences, and accept either that object OR a bare actions array.
// Every action is validated against the real world (unit exists, coords
// in-bounds, known recipe/building); anything that fails is dropped —
// applyAction is the final authority, but rejecting garbage here keeps the
// audit log honest about what we actually tried to run.
import { BUILDINGS, RECIPES } from '@game/shared';
import type { Action, Coord, MemoryOp, ViewCommand, World } from '@game/shared';
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

/** Best-effort render of a candidate coord for a rejection reason (the value may
 *  be anything the model emitted, not a valid Coord). */
function coordStr(v: unknown): string {
  if (v && typeof v === 'object') {
    const c = v as Record<string, unknown>;
    if (typeof c.x === 'number' && typeof c.y === 'number') return `(${c.x},${c.y})`;
  }
  return JSON.stringify(v) ?? '(?)';
}

/** Resolve a model-supplied unitId to a real unit id, tolerating the common
 *  slip where the model drops the "unit-" prefix and sends the bare index (as a
 *  number or a numeric string). Unit ids are generated as `unit-${n}` (see
 *  sim.ts), so `0`/"0" → "unit-0". Returns the canonical id or null if none
 *  matches — the caller turns null into a rejection reason. */
function resolveUnitId(raw: unknown, world: World): string | null {
  if (typeof raw === 'string' && world.units[raw]) return raw;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (Number.isInteger(n)) {
    const id = `unit-${n}`;
    if (world.units[id]) return id;
  }
  return null;
}

/** Validate one candidate world action. Returns the accepted Action, or a
 *  `{ reject }` reason string so the caller can surface WHY it was dropped
 *  (instead of silently swallowing it). setView is handled separately — it is a
 *  view command, not a world action — so it should never reach here. */
function validateAction(raw: unknown, world: World): Action | { reject: string } {
  if (typeof raw !== 'object' || raw === null) return { reject: 'action is not an object' };
  const a = raw as Record<string, unknown>;
  const type = typeof a.type === 'string' ? a.type : '(missing type)';
  const unitId = resolveUnitId(a.unitId, world);
  if (!unitId) return { reject: `${type}: unknown unit ${JSON.stringify(a.unitId)}` };

  switch (a.type) {
    case 'move':
      return isCoord(a.to, world)
        ? { type: 'move', unitId, to: a.to as Coord }
        : { reject: `move: target ${coordStr(a.to)} out of bounds` };
    case 'harvest':
      return isCoord(a.target, world)
        ? { type: 'harvest', unitId, target: a.target as Coord }
        : { reject: `harvest: target ${coordStr(a.target)} out of bounds` };
    case 'craft':
      return typeof a.recipe === 'string' && RECIPES[a.recipe]
        ? { type: 'craft', unitId, recipe: a.recipe }
        : { reject: `craft: unknown recipe ${JSON.stringify(a.recipe)}` };
    case 'build':
      if (typeof a.building !== 'string' || !BUILDINGS[a.building]) {
        return { reject: `build: unknown building ${JSON.stringify(a.building)}` };
      }
      return isCoord(a.at, world)
        ? { type: 'build', unitId, building: a.building, at: a.at as Coord }
        : { reject: `build: location ${coordStr(a.at)} out of bounds` };
    default:
      return { reject: `unknown action type ${JSON.stringify(a.type)}` };
  }
}

/** Validate a setView view command: `center` must be in-bounds, `tilesAcross` a
 *  positive finite number; at least one must be present. */
function validateView(raw: Record<string, unknown>, world: World): ViewCommand | { reject: string } {
  const cmd: ViewCommand = { type: 'setView' };
  if (raw.center !== undefined) {
    if (isCoord(raw.center, world)) cmd.center = raw.center as Coord;
    else return { reject: `setView: center ${coordStr(raw.center)} out of bounds` };
  }
  if (raw.tilesAcross !== undefined) {
    const t = raw.tilesAcross;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) cmd.tilesAcross = Math.round(t);
    else return { reject: `setView: bad tilesAcross ${JSON.stringify(t)}` };
  }
  if (cmd.center === undefined && cmd.tilesAcross === undefined) {
    return { reject: 'setView: neither center nor tilesAcross given' };
  }
  return cmd;
}

/** Cap on how many rejection reasons we keep, so a runaway response can't flood
 *  the audit log/chat. We keep validating good actions past the cap — only the
 *  reason list stops growing. */
const MAX_REJECTED = 10;

/** Split a candidate list into accepted world actions, accepted view commands,
 *  and human-readable rejection reasons. setView items branch to view-command
 *  validation; everything else is a world action. */
function splitAndValidate(
  arr: unknown,
  world: World,
): { actions: Action[]; viewCommands: ViewCommand[]; rejected: string[] } {
  const actions: Action[] = [];
  const viewCommands: ViewCommand[] = [];
  const rejected: string[] = [];
  const push = (reason: string): void => {
    if (rejected.length < MAX_REJECTED) rejected.push(reason);
  };
  if (!Array.isArray(arr)) return { actions, viewCommands, rejected };
  for (const item of arr) {
    if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'setView') {
      const r = validateView(item as Record<string, unknown>, world);
      if ('reject' in r) push(r.reject);
      else viewCommands.push(r);
      continue;
    }
    const r = validateAction(item, world);
    if ('reject' in r) push(r.reject);
    else actions.push(r);
  }
  return { actions, viewCommands, rejected };
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

/** The parsed model response: accepted world actions + view commands, an
 *  optional reply, optional memory edit ops, and a list of rejection reasons for
 *  anything we had to drop (so failures are auditable rather than silent). */
export interface OrchestratorResponse {
  actions: Action[];
  /** Camera moves requested via setView (applied client-side, not through the
   *  sim). Empty when the model didn't touch the view. */
  viewCommands: ViewCommand[];
  /** Human-readable reasons for dropped items (bad unit, out-of-bounds, unknown
   *  recipe, un-parseable response). Empty on a clean response. */
  rejected: string[];
  msg?: string;
  /** Memory edit ops to apply, or undefined to leave memory unchanged. */
  memoryOps?: MemoryOp[];
}

/** Parse a model response into accepted actions/view commands + optional player
 *  reply, plus reasons for anything rejected. Accepts the object form
 *  {"actions":[...],"msg":"..."} first, then falls back to a bare actions array
 *  (older/looser outputs). */
export function parseResponse(text: string, world: World): OrchestratorResponse {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();

  const obj = sliceJson(cleaned, '{', '}');
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    const { actions, viewCommands, rejected } = splitAndValidate(o.actions, world);
    const msg = typeof o.msg === 'string' ? o.msg.trim() : '';
    const memoryOps = parseMemoryOps(o.memory);
    const res: OrchestratorResponse = { actions, viewCommands, rejected };
    if (msg) res.msg = msg;
    if (memoryOps !== undefined) res.memoryOps = memoryOps;
    return res;
  }

  // Fallback: a bare array of actions, no message. If nothing parsed at all
  // (no JSON object AND no JSON array), flag it so the empty result isn't
  // mistaken for a deliberate no-op plan.
  const arr = sliceJson(cleaned, '[', ']');
  const { actions, viewCommands, rejected } = splitAndValidate(arr, world);
  if (arr === null) rejected.push('response was not valid JSON — no actions parsed');
  return { actions, viewCommands, rejected };
}
