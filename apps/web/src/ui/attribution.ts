// Shared styling for "who submitted this" — used by the Actions panel and the
// AI History window so a player/agent reads the same everywhere. Players get a
// stable hue derived from their peer id; the AI is deliberately distinct (a
// violet) because it's special: it can act for a player or on its own.
import type { ActionSource, ActionStatus } from '@game/shared';

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

const STATUS_MARK: Record<ActionStatus, { cls: string; sym: string; title: string }> = {
  ongoing: { cls: 'st-ongoing', sym: '⟳', title: 'In progress' },
  done: { cls: 'st-done', sym: '✓', title: 'Completed' },
  interrupted: { cls: 'st-interrupted', sym: '⊘', title: 'Interrupted / cancelled' },
  error: { cls: 'st-error', sym: '✕', title: "Failed — didn't complete" },
};

/** A small status glyph for an action's outcome (ongoing/done/interrupted/error),
 *  shared by the Actions panel and the AI History so both read the same. Empty
 *  string when the status is unknown (older records, or an AI-history action not
 *  found in the live log), so nothing is drawn rather than a misleading icon. */
export function actionStatusMark(status: ActionStatus | undefined): string {
  if (!status) return '';
  const m = STATUS_MARK[status];
  return `<span class="act-status ${m.cls}" title="${m.title}">${m.sym}</span>`;
}
