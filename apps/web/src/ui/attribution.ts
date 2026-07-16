// Shared styling for "who submitted this" — used by the Actions panel and the
// AI History window so a player/agent reads the same everywhere. Players get a
// stable hue derived from their peer id; the AI is deliberately distinct (a
// violet) because it's special: it can act for a player or on its own.
import type { ActionSource } from '@game/shared';

const AI_COLOR = '#a78bfa';

function hueFrom(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** A CSS color for the source's accent (left border / dot). */
export function sourceColor(source: ActionSource): string {
  if (source.kind === 'ai') return AI_COLOR;
  return `hsl(${hueFrom(source.peerId)}, 62%, 62%)`;
}

/** A short human label, e.g. "Ada" or "AI ← Ada" / "AI (auto)". */
export function sourceLabel(source: ActionSource): string {
  if (source.kind === 'player') return source.name;
  return source.onBehalfOf ? `AI ← ${source.onBehalfOf}` : 'AI (auto)';
}

/** True for AI-submitted actions (the panel marks these specially). */
export function isAi(source: ActionSource): boolean {
  return source.kind === 'ai';
}
