// The colony's standing memory as an EDITABLE list, and the pure logic that
// applies edit ops to it. Memory is a small ordered list of durable player
// preferences ("always keep one scout out"). Both the model and the Memory tab
// change it by sending tiny ops that address items by their 1-based position —
// never by re-sending the whole list. That is the whole point: once memory has
// a dozen lines, echoing it back on every command would dominate output tokens,
// so there is deliberately nothing to echo.
import type { MemoryOp } from '@game/shared';

// Caps enforced on the RESULT, so neither a runaway model nor a fat-fingered
// manual edit can bloat the cache-stable prompt: at most this many lines, each
// trimmed to this length. Shared with the parser (which pre-trims op text).
export const MEMORY_MAX_ENTRIES = 20;
export const MEMORY_MAX_LEN = 200;

/** Normalize one memory line: trim, cap length, trim again. '' means "drop". */
function clean(s: string): string {
  return s.trim().slice(0, MEMORY_MAX_LEN).trim();
}

/** Apply a batch of ops to `prev`, returning the new list (never mutating).
 *
 *  id-based ops (edit/del) resolve against the ORIGINAL 1-based positions, so a
 *  batch like [del 1, del 2] removes the first two items rather than deleting
 *  #1 and then #2-of-the-shrunk-list. Out-of-range ids are ignored. adds append
 *  in order after the surviving items. The result is trimmed, de-blanked, and
 *  capped, matching what the model was shown and what we persist. */
export function applyMemoryOps(prev: string[], ops: MemoryOp[]): string[] {
  const edits = new Map<number, string>();
  const dels = new Set<number>();
  const adds: string[] = [];
  for (const op of ops) {
    if (op.op === 'edit') {
      if (op.id >= 1 && op.id <= prev.length) edits.set(op.id, op.text);
    } else if (op.op === 'del') {
      if (op.id >= 1 && op.id <= prev.length) dels.add(op.id);
    } else {
      adds.push(op.text);
    }
  }
  const out: string[] = [];
  for (let i = 0; i < prev.length; i++) {
    const id = i + 1;
    if (dels.has(id)) continue;
    out.push(edits.get(id) ?? prev[i]!);
  }
  for (const a of adds) out.push(a);
  return out.map(clean).filter((s) => s.length > 0).slice(0, MEMORY_MAX_ENTRIES);
}

/** Whether two memory lists differ (order-sensitive) — used to decide if a set
 *  of ops actually changed anything worth recording as a revision. */
export function memoryChanged(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((s, i) => s !== b[i]);
}
