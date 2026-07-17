// The one TEXT form for a tile coordinate: a spreadsheet-style cell like "A1",
// "F12", or "AF29" — column letters for x, a 1-based row number for y. This is
// what both the AI prompt (input AND output) and the player-facing UI use, so
// the human and the model address tiles the same way. It's also markedly more
// token-efficient than `{"x":31,"y":28}` or `(31, 28)` for the model.
//
// Internals stay `{x, y}` everywhere — this module only converts at the edges
// (prompt text, parsed model output, on-screen readouts). Nothing in the sim or
// the wire protocol changes shape.
import type { Coord } from './types.js';

/** Column letters for a 0-based x, like spreadsheet columns (bijective base-26):
 *  0→A, 25→Z, 26→AA, 27→AB, 51→AZ, 52→BA, … Always at least one letter. */
export function columnLabel(x: number): string {
  let n = Math.max(0, Math.floor(x)) + 1; // 1-based for bijective base-26
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A tile as a cell string: column letters (x) + row number (y + 1). So (0,0)→
 *  "A1", (31,28)→"AF29". The canonical text form of a coordinate. */
export function toCell(c: Coord): string {
  return columnLabel(c.x) + (Math.max(0, Math.floor(c.y)) + 1);
}

/** Same as toCell, from loose x/y (handy for fractional camera/mouse values,
 *  which are floored). */
export function toCellXY(x: number, y: number): string {
  return columnLabel(x) + (Math.max(0, Math.floor(y)) + 1);
}

const CELL_RE = /^\s*([A-Za-z]+)\s*(\d+)\s*$/;

/** Parse a cell like "AF29" (case-insensitive, tolerant of surrounding space)
 *  back to `{x, y}`. Returns null for anything that isn't LETTERS+DIGITS or has a
 *  row below 1. Does NOT bounds-check against a world — a caller that needs that
 *  compares against width/height itself (it may not have a world in hand). */
export function parseCell(s: string): Coord | null {
  const m = CELL_RE.exec(s);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64); // A=1 … Z=26
  }
  const row = Number(m[2]);
  if (row < 1) return null;
  return { x: col - 1, y: row - 1 };
}
