// Turn a model's text response into validated Actions (and an optional reply).
// The model is asked for a compact LINE format — one command per line, keyword
// first — because it roughly halves output tokens vs. the old JSON object:
//
//   msg Getting another tree down for wood!
//   move unit-1 AF29
//   harvest unit-1 AB16
//   harvest unit-2 AU20:AZ28 tree     (an AREA — nearest tree in the box)
//
// We parse line by line and validate every command against the real world (unit
// exists, coords in-bounds, known recipe/building); anything that fails is
// dropped with a reason. applyAction is the final authority, but rejecting
// garbage here keeps the audit log honest about what we actually tried to run.
// A JSON object/array is still accepted as a fallback so a model that reverts to
// the old shape (or an older saved exchange) doesn't break.
import { BUILDINGS, RECIPES, parseCell, parseCellRange, toCell } from '@game/shared';
import type { Action, CellRange, Coord, MemoryOp, ViewCommand, World } from '@game/shared';
import { MEMORY_MAX_LEN } from './memory.js';

/** Coerce a model-supplied coordinate to an in-bounds Coord, or null. The line
 *  format sends a cell string ("AF29"); we also still accept a legacy {x,y}
 *  object (JSON fallback path) so a transitional response doesn't break. Bounds
 *  are checked against the real world here. */
function coerceCoord(v: unknown, world: World): Coord | null {
  let c: Coord | null = null;
  if (typeof v === 'string') {
    c = parseCell(v);
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Number.isInteger(o.x) && Number.isInteger(o.y)) c = { x: o.x as number, y: o.y as number };
  }
  if (!c || c.x < 0 || c.y < 0 || c.x >= world.width || c.y >= world.height) return null;
  return c;
}

/** Best-effort render of a candidate coord for a rejection reason (the value may
 *  be anything the model emitted). Cell strings pass through as-is; an {x,y}
 *  object renders as its cell so the reason speaks the same language as the
 *  prompt. */
function coordStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const c = v as Record<string, unknown>;
    if (typeof c.x === 'number' && typeof c.y === 'number') {
      return toCell({ x: c.x, y: c.y });
    }
  }
  return JSON.stringify(v) ?? '(?)';
}

/** Resolve a model-supplied unitId to a real unit id, tolerating the common
 *  slips: the bare index ("0"), the prefix run together ("unit1"), or the exact
 *  id ("unit-0"). Unit ids are generated as `unit-${n}` (see sim.ts), so we take
 *  the trailing integer of whatever was sent and map it to `unit-${n}`. Returns
 *  the canonical id or null if none matches. */
function resolveUnitId(raw: unknown, world: World): string | null {
  if (typeof raw === 'string' && world.units[raw]) return raw;
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') {
    const m = raw.match(/(\d+)\s*$/); // trailing digits of "unit-3" / "unit3" / "3"
    if (m) n = Number(m[1]);
  }
  if (Number.isInteger(n)) {
    const id = `unit-${n}`;
    if (world.units[id]) return id;
  }
  return null;
}

/** A positive integer quantity (accepts a numeric string), or null if invalid. */
function coerceQty(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

/** Optional trailing "[item] [qty]" for drop/dropnearby/pickup, parsed
 *  order-independently: a pure-integer token is the qty, the first other token
 *  is the item id. Omitting the item means "the whole bag". */
function itemQtyTail(tokens: string[]): { item?: string; qty?: number } {
  let item: string | undefined;
  let qty: number | undefined;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      if (qty === undefined) qty = coerceQty(t) ?? undefined;
    } else if (item === undefined) {
      item = t;
    }
  }
  return { item, qty };
}

// --- Areas (cell OR range targets) --------------------------------------

/** True if a target token is an AREA (a range, "AU20:AZ28") rather than a single
 *  cell. Only ranges get resolved to a nearest match; a bare cell is passed
 *  through as-is (so exact-tile and depot semantics are untouched). */
function isRangeToken(t: string | undefined): boolean {
  return typeof t === 'string' && t.includes(':');
}

/** Parse + clamp an area token to the world. Returns the in-bounds rectangle, or
 *  null if the token isn't a valid range or the box lies entirely off the map. */
function coerceRange(token: string, world: World): CellRange | null {
  const r = parseCellRange(token);
  if (!r) return null;
  // Reject a box that doesn't intersect the world at all (else clamping would
  // collapse it onto an edge cell and invent a bogus match).
  if (r.max.x < 0 || r.max.y < 0 || r.min.x >= world.width || r.min.y >= world.height) return null;
  const clamp = (c: Coord): Coord => ({
    x: Math.max(0, Math.min(world.width - 1, c.x)),
    y: Math.max(0, Math.min(world.height - 1, c.y)),
  });
  return { min: clamp(r.min), max: clamp(r.max) };
}

const manhattan = (a: Coord, b: Coord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Which harvest category an object belongs to (for the optional type filter on
 *  `harvest <id> <range> [types...]`). A fruit tree is its own category (gathered
 *  for food) vs. a plain tree (chopped for wood). Non-harvestable → null. */
function harvestCategory(obj: { kind: string; hasFruit?: boolean }): 'tree' | 'fruit' | 'rock' | 'ore' | null {
  if (obj.kind === 'tree') return obj.hasFruit ? 'fruit' : 'tree';
  if (obj.kind === 'rock') return 'rock';
  if (obj.kind === 'ore') return 'ore';
  return null;
}

/** Map a model-supplied type word to a harvest category. Tolerant of the obvious
 *  synonyms so "wood"/"stone"/"metal" work as well as the kind names. */
const HARVEST_TYPE_ALIASES: Record<string, 'tree' | 'fruit' | 'rock' | 'ore'> = {
  tree: 'tree', wood: 'tree', log: 'tree', logs: 'tree',
  fruit: 'fruit', food: 'fruit', fruittree: 'fruit',
  rock: 'rock', stone: 'rock', rocks: 'rock',
  ore: 'ore', metal: 'ore', iron: 'ore', copper: 'ore', gold: 'ore',
};

/** Nearest harvestable object to `from` within `range`, optionally filtered to
 *  the given type words. Empty/unknown filter = any harvestable object. Null if
 *  the box holds nothing matching. */
function nearestHarvestable(world: World, from: Coord, range: CellRange, typeTokens: string[]): Coord | null {
  const wanted = new Set<string>();
  for (const t of typeTokens) {
    const cat = HARVEST_TYPE_ALIASES[t.toLowerCase()];
    if (cat) wanted.add(cat);
  }
  let best: { cell: Coord; d: number } | undefined;
  for (let y = range.min.y; y <= range.max.y; y++) {
    for (let x = range.min.x; x <= range.max.x; x++) {
      const obj = world.tiles[y * world.width + x]?.object;
      if (!obj) continue;
      const cat = harvestCategory(obj);
      if (!cat || (wanted.size && !wanted.has(cat))) continue;
      const d = manhattan(from, { x, y });
      if (!best || d < best.d) best = { cell: { x, y }, d };
    }
  }
  return best?.cell ?? null;
}

/** Nearest loose ground pile to `from` within `range`, optionally requiring a
 *  specific item. Null if the box holds no matching pile. (Depots are addressed
 *  by their own known cell, so ranges resolve to ground piles only.) */
function nearestPile(world: World, from: Coord, range: CellRange, item: string | undefined): Coord | null {
  let best: { cell: Coord; d: number } | undefined;
  for (let y = range.min.y; y <= range.max.y; y++) {
    for (let x = range.min.x; x <= range.max.x; x++) {
      const items = world.tiles[y * world.width + x]?.items;
      if (!items) continue;
      const has = item ? (items[item] ?? 0) > 0 : Object.values(items).some((n) => n > 0);
      if (!has) continue;
      const d = manhattan(from, { x, y });
      if (!best || d < best.d) best = { cell: { x, y }, d };
    }
  }
  return best?.cell ?? null;
}

// --- JSON fallback (legacy shape) ---------------------------------------

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

/** Validate one candidate world-action OBJECT (the JSON fallback path). setView
 *  is handled separately; it should never reach here. */
function validateAction(raw: unknown, world: World): Action | { reject: string } {
  if (typeof raw !== 'object' || raw === null) return { reject: 'action is not an object' };
  const a = raw as Record<string, unknown>;
  const type = typeof a.type === 'string' ? a.type : '(missing type)';
  const unitId = resolveUnitId(a.unitId, world);
  if (!unitId) return { reject: `${type}: unknown unit ${JSON.stringify(a.unitId)}` };

  switch (a.type) {
    case 'move': {
      const to = coerceCoord(a.to, world);
      return to
        ? { type: 'move', unitId, to }
        : { reject: `move: target ${coordStr(a.to)} out of bounds` };
    }
    case 'harvest': {
      const target = coerceCoord(a.target, world);
      return target
        ? { type: 'harvest', unitId, target }
        : { reject: `harvest: target ${coordStr(a.target)} out of bounds` };
    }
    case 'craft':
      return typeof a.recipe === 'string' && RECIPES[a.recipe]
        ? { type: 'craft', unitId, recipe: a.recipe }
        : { reject: `craft: unknown recipe ${JSON.stringify(a.recipe)}` };
    case 'build': {
      if (typeof a.building !== 'string' || !BUILDINGS[a.building]) {
        return { reject: `build: unknown building ${JSON.stringify(a.building)}` };
      }
      const at = coerceCoord(a.at, world);
      return at
        ? { type: 'build', unitId, building: a.building, at }
        : { reject: `build: location ${coordStr(a.at)} out of bounds` };
    }
    case 'dropNearby': {
      const item = typeof a.item === 'string' ? a.item : undefined;
      const qty = a.qty == null ? undefined : (coerceQty(a.qty) ?? undefined);
      return { type: 'dropNearby', unitId, ...(item ? { item } : {}), ...(qty ? { qty } : {}) };
    }
    case 'drop': {
      const at = coerceCoord(a.at, world);
      if (!at) return { reject: `drop: location ${coordStr(a.at)} out of bounds` };
      const item = typeof a.item === 'string' ? a.item : undefined;
      const qty = a.qty == null ? undefined : (coerceQty(a.qty) ?? undefined);
      return { type: 'drop', unitId, at, ...(item ? { item } : {}), ...(qty ? { qty } : {}) };
    }
    case 'pickup': {
      const at = coerceCoord(a.at, world);
      if (!at) return { reject: `pickup: location ${coordStr(a.at)} out of bounds` };
      const item = typeof a.item === 'string' ? a.item : undefined;
      const qty = a.qty == null ? undefined : (coerceQty(a.qty) ?? undefined);
      return { type: 'pickup', unitId, at, ...(item ? { item } : {}), ...(qty ? { qty } : {}) };
    }
    case 'cancel':
      return { type: 'cancel', unitId };
    default:
      return { reject: `unknown action type ${JSON.stringify(a.type)}` };
  }
}

/** Cap on how many rejection reasons we keep, so a runaway response can't flood
 *  the audit log/chat. We keep validating good actions past the cap — only the
 *  reason list stops growing. */
const MAX_REJECTED = 10;

/** Cap on how many edit ops we accept from a single response, so a runaway
 *  model can't flood the audit log or the applier. Generous — real edits are a
 *  handful. Length/count caps on the RESULT live in memory.ts. */
const MEMORY_MAX_OPS = 20;

/** A small accumulator threaded through both the line parser and the JSON
 *  fallback so they build the same result the same way. */
interface Acc {
  actions: Action[];
  viewCommands: ViewCommand[];
  rejected: string[];
  memoryOps: MemoryOp[];
  msg: string;
}

function newAcc(): Acc {
  return { actions: [], viewCommands: [], rejected: [], memoryOps: [], msg: '' };
}

/** Record a rejection reason (capped). Returns true so a `return reject(...)`
 *  inside parseLine reads as "known keyword, bad arguments" — callers that
 *  return void ignore the value. */
function reject(acc: Acc, reason: string): true {
  if (acc.rejected.length < MAX_REJECTED) acc.rejected.push(reason);
  return true;
}

// --- Line format (the primary shape) ------------------------------------

/** Parse ONE `view ...` command's tokens: a pure-integer token is tilesAcross,
 *  anything else is the center cell. At least one must be valid. */
function parseView(tokens: string[], world: World, acc: Acc): void {
  const cmd: ViewCommand = { type: 'setView' };
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n > 0) cmd.tilesAcross = Math.round(n);
    } else if (cmd.center === undefined) {
      const c = coerceCoord(t, world);
      if (c) cmd.center = c;
      else {
        reject(acc, `view: center ${t} out of bounds`);
        return;
      }
    }
  }
  if (cmd.center === undefined && cmd.tilesAcross === undefined) {
    reject(acc, 'view: neither a cell nor a zoom given');
    return;
  }
  acc.viewCommands.push(cmd);
}

/** Parse ONE `mem <op> ...` line into a memory edit op. */
function parseMemLine(tokens: string[], acc: Acc): void {
  if (acc.memoryOps.length >= MEMORY_MAX_OPS) return;
  const op = (tokens[0] ?? '').toLowerCase();
  const clip = (s: string): string => s.trim().slice(0, MEMORY_MAX_LEN).trim();
  if (op === 'add') {
    const text = clip(tokens.slice(1).join(' '));
    if (text) acc.memoryOps.push({ op: 'add', text });
    else reject(acc, 'mem add: empty text');
  } else if (op === 'edit') {
    const id = Number(tokens[1]);
    const text = clip(tokens.slice(2).join(' '));
    if (Number.isInteger(id) && id >= 1 && text) acc.memoryOps.push({ op: 'edit', id, text });
    else reject(acc, `mem edit: bad id/text ${tokens.slice(1, 2).join('')}`);
  } else if (op === 'del' || op === 'delete' || op === 'remove') {
    const id = Number(tokens[1]);
    if (Number.isInteger(id) && id >= 1) acc.memoryOps.push({ op: 'del', id });
    else reject(acc, `mem del: bad id ${tokens[1] ?? '(none)'}`);
  } else {
    reject(acc, `mem: unknown op ${tokens[0] ?? '(none)'}`);
  }
}

/** Parse ONE action/command line. `verb` is already lowercased; `args` are the
 *  whitespace tokens after it; `rest` is the untokenized remainder (for msg).
 *  Returns true if `verb` was a KNOWN keyword (whether or not its args were
 *  valid) — a line that isn't one of our keywords returns false so the caller
 *  can tell a real command line from JSON/prose and fall back accordingly. */
function parseLine(verb: string, args: string[], rest: string, world: World, acc: Acc): boolean {
  const unit = (): string | null => resolveUnitId(args[0], world);
  switch (verb) {
    case 'msg': {
      if (!acc.msg && rest) acc.msg = rest; // first msg wins; ignore any extras
      break;
    }
    case 'move': {
      const id = unit();
      if (!id) return reject(acc, `move: unknown unit ${args[0] ?? '(none)'}`);
      const to = coerceCoord(args[1], world);
      if (!to) return reject(acc, `move: bad cell ${args[1] ?? '(none)'}`);
      acc.actions.push({ type: 'move', unitId: id, to });
      break;
    }
    case 'harvest': {
      const id = unit();
      if (!id) return reject(acc, `harvest: unknown unit ${args[0] ?? '(none)'}`);
      // An AREA (range) resolves to the nearest matching resource to the unit,
      // optionally filtered by trailing type words; a bare cell is worked as-is.
      if (isRangeToken(args[1])) {
        const range = coerceRange(args[1], world);
        if (!range) return reject(acc, `harvest: bad area ${args[1]}`);
        const target = nearestHarvestable(world, world.units[id]!.pos, range, args.slice(2));
        if (!target) return reject(acc, `harvest: no matching resource in ${args[1]}`);
        acc.actions.push({ type: 'harvest', unitId: id, target });
        break;
      }
      const target = coerceCoord(args[1], world);
      if (!target) return reject(acc, `harvest: bad cell ${args[1] ?? '(none)'}`);
      acc.actions.push({ type: 'harvest', unitId: id, target });
      break;
    }
    case 'craft': {
      const id = unit();
      if (!id) return reject(acc, `craft: unknown unit ${args[0] ?? '(none)'}`);
      const recipe = args[1];
      if (!recipe || !RECIPES[recipe]) return reject(acc, `craft: unknown recipe ${recipe ?? '(none)'}`);
      acc.actions.push({ type: 'craft', unitId: id, recipe });
      break;
    }
    case 'build': {
      const id = unit();
      if (!id) return reject(acc, `build: unknown unit ${args[0] ?? '(none)'}`);
      // Tolerate either order — "build <id> <building> <cell>" (the documented
      // form) or "build <id> <cell> <building>" (a common model slip): the known
      // building name identifies itself, and the other token is the cell.
      const a = args[1];
      const b = args[2];
      const building = a && BUILDINGS[a] ? a : b && BUILDINGS[b] ? b : undefined;
      if (!building) return reject(acc, `build: unknown building ${a ?? '(none)'}`);
      const cellTok = building === a ? b : a;
      const at = coerceCoord(cellTok, world);
      if (!at) return reject(acc, `build: bad cell ${cellTok ?? '(none)'}`);
      acc.actions.push({ type: 'build', unitId: id, building, at });
      break;
    }
    case 'drop': {
      const id = unit();
      if (!id) return reject(acc, `drop: unknown unit ${args[0] ?? '(none)'}`);
      const at = coerceCoord(args[1], world);
      if (!at) return reject(acc, `drop: bad cell ${args[1] ?? '(none)'}`);
      const { item, qty } = itemQtyTail(args.slice(2));
      acc.actions.push({ type: 'drop', unitId: id, at, ...(item ? { item } : {}), ...(qty ? { qty } : {}) });
      break;
    }
    case 'dropnearby': {
      const id = unit();
      if (!id) return reject(acc, `dropnearby: unknown unit ${args[0] ?? '(none)'}`);
      const { item, qty } = itemQtyTail(args.slice(1));
      acc.actions.push({ type: 'dropNearby', unitId: id, ...(item ? { item } : {}), ...(qty ? { qty } : {}) });
      break;
    }
    case 'pickup': {
      const id = unit();
      if (!id) return reject(acc, `pickup: unknown unit ${args[0] ?? '(none)'}`);
      const { item, qty } = itemQtyTail(args.slice(2));
      const tail = { ...(item ? { item } : {}), ...(qty ? { qty } : {}) };
      // An AREA (range) resolves to the nearest loose pile (matching item, if
      // given) to the unit; a bare cell keeps exact ground/depot semantics.
      if (isRangeToken(args[1])) {
        const range = coerceRange(args[1], world);
        if (!range) return reject(acc, `pickup: bad area ${args[1]}`);
        const at = nearestPile(world, world.units[id]!.pos, range, item);
        if (!at) return reject(acc, `pickup: no loose items in ${args[1]}`);
        acc.actions.push({ type: 'pickup', unitId: id, at, ...tail });
        break;
      }
      const at = coerceCoord(args[1], world);
      if (!at) return reject(acc, `pickup: bad cell ${args[1] ?? '(none)'}`);
      acc.actions.push({ type: 'pickup', unitId: id, at, ...tail });
      break;
    }
    case 'cancel': {
      const id = unit();
      if (!id) return reject(acc, `cancel: unknown unit ${args[0] ?? '(none)'}`);
      acc.actions.push({ type: 'cancel', unitId: id });
      break;
    }
    case 'view':
      parseView(args, world, acc);
      break;
    case 'mem':
    case 'memory':
      parseMemLine(args, acc);
      break;
    default:
      return false; // unknown keyword — caller decides whether to reject/fallback
  }
  return true;
}

/** Parse the line format. Returns the accumulator, or null if not a single
 *  recognizable line was found (so the caller can try the JSON fallback). */
function parseLines(cleaned: string, world: World): Acc | null {
  const acc = newAcc();
  let recognized = 0;
  const unknown: string[] = [];
  for (const rawLine of cleaned.split('\n')) {
    // Tolerate a leading list marker ("- ", "* ", "1. ") the model may add.
    const line = rawLine.trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const verb = m[1].toLowerCase().replace(/:$/, ''); // tolerate "move:"
    const rest = m[2].trim();
    const args = rest ? rest.split(/\s+/) : [];
    if (parseLine(verb, args, rest, world, acc)) recognized++;
    else unknown.push(line);
  }
  // Nothing looked like a command line — let the caller try the JSON fallback
  // (and don't pollute its rejections with prose we were never meant to parse).
  if (recognized === 0) return null;
  // We WERE in line mode, so any leftover non-command line is a real miss (a bad
  // verb like "pickaxe", a stray prose line). Surface each as a rejection so it's
  // auditable instead of silently vanishing.
  for (const line of unknown) reject(acc, `unrecognized command: ${line.slice(0, 60)}`);
  return acc;
}

/** JSON fallback: the legacy {"actions":[...],"msg":"...","memory":[...]} object
 *  (or a bare actions array). Only tried when the line parser found nothing. */
function parseJson(cleaned: string, world: World): Acc {
  const acc = newAcc();
  const validate = (item: unknown): void => {
    if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'setView') {
      const v = item as Record<string, unknown>;
      const cmd: ViewCommand = { type: 'setView' };
      const center = v.center !== undefined ? coerceCoord(v.center, world) : null;
      if (v.center !== undefined && !center) {
        reject(acc, `setView: center ${coordStr(v.center)} out of bounds`);
        return;
      }
      if (center) cmd.center = center;
      if (typeof v.tilesAcross === 'number' && Number.isFinite(v.tilesAcross) && v.tilesAcross > 0) {
        cmd.tilesAcross = Math.round(v.tilesAcross);
      }
      if (cmd.center === undefined && cmd.tilesAcross === undefined) {
        reject(acc, 'setView: neither center nor tilesAcross given');
        return;
      }
      acc.viewCommands.push(cmd);
      return;
    }
    const r = validateAction(item, world);
    if ('reject' in r) reject(acc, r.reject);
    else acc.actions.push(r);
  };

  // A bare actions array (no wrapping object) also contains `{...}` objects, so
  // decide by which bracket opens FIRST — otherwise the object scan would grab
  // the array's first element and treat it as the top-level payload.
  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arr = sliceJson(cleaned, '[', ']');
    if (Array.isArray(arr)) arr.forEach(validate);
    else reject(acc, 'response was neither command lines nor valid JSON — no actions parsed');
    return acc;
  }

  const obj = sliceJson(cleaned, '{', '}');
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.actions)) o.actions.forEach(validate);
    if (typeof o.msg === 'string') acc.msg = o.msg.trim();
    if (Array.isArray(o.memory)) {
      for (const raw of o.memory) {
        if (acc.memoryOps.length >= MEMORY_MAX_OPS) break;
        if (typeof raw !== 'object' || raw === null) continue;
        const op = raw as Record<string, unknown>;
        const kind = typeof op.op === 'string' ? op.op.trim().toLowerCase() : '';
        const text = typeof op.text === 'string' ? op.text.trim().slice(0, MEMORY_MAX_LEN).trim() : '';
        const id = Number.isInteger(op.id) ? (op.id as number) : NaN;
        if (kind === 'add' && text) acc.memoryOps.push({ op: 'add', text });
        else if (kind === 'edit' && id >= 1 && text) acc.memoryOps.push({ op: 'edit', id, text });
        else if ((kind === 'del' || kind === 'delete' || kind === 'remove') && id >= 1) acc.memoryOps.push({ op: 'del', id });
      }
    }
    return acc;
  }

  const arr = sliceJson(cleaned, '[', ']');
  if (Array.isArray(arr)) arr.forEach(validate);
  else reject(acc, 'response was neither command lines nor valid JSON — no actions parsed');
  return acc;
}

/** The parsed model response: accepted world actions + view commands, an
 *  optional reply, optional memory edit ops, and a list of rejection reasons for
 *  anything we had to drop (so failures are auditable rather than silent). */
export interface OrchestratorResponse {
  actions: Action[];
  /** Camera moves requested via a `view` command (applied client-side, not
   *  through the sim). Empty when the model didn't touch the view. */
  viewCommands: ViewCommand[];
  /** Human-readable reasons for dropped items (bad unit, out-of-bounds, unknown
   *  recipe, un-parseable response). Empty on a clean response. */
  rejected: string[];
  msg?: string;
  /** Memory edit ops to apply, or undefined to leave memory unchanged. */
  memoryOps?: MemoryOp[];
}

/** Parse a model response into accepted actions/view commands + optional player
 *  reply, plus reasons for anything rejected. Tries the compact LINE format
 *  first (the format the prompt now asks for); falls back to the legacy JSON
 *  object/array if not one line was recognized. */
export function parseResponse(text: string, world: World): OrchestratorResponse {
  const cleaned = text.replace(/```(?:json|txt|text)?/gi, '').trim();

  const acc = parseLines(cleaned, world) ?? parseJson(cleaned, world);

  const res: OrchestratorResponse = {
    actions: acc.actions,
    viewCommands: acc.viewCommands,
    rejected: acc.rejected,
  };
  if (acc.msg) res.msg = acc.msg;
  if (acc.memoryOps.length) res.memoryOps = acc.memoryOps;
  return res;
}
