// The Actions panel: a live feed of every action in the world, newest first,
// attributed to whoever submitted it (player or AI). Each row's left border is
// colored by source; AI rows are badged. Fed by the actionLog store, which the
// host refreshes with every snapshot.
import { describeAction, unitShort } from '@game/shared';
import type { ActionRecord } from '@game/shared';
import { actionLog } from '../net/client';
import { actionStatusMark, isAi, sourceColor, sourceLabel } from './attribution';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** A thin progress bar for an in-flight action, mirroring the unit inspector's
 *  job bar. Only drawn while ongoing with live progress (harvest/craft/build). */
function progressBar(rec: ActionRecord): string {
  if (rec.status !== 'ongoing' || !rec.progress) return '';
  const { remaining, total } = rec.progress;
  const done = total > 0 ? Math.max(0, Math.min(1, 1 - remaining / total)) : 0;
  return `<div class="act-progress"><div class="act-fill" style="width:${Math.round(done * 100)}%"></div></div>`;
}

function row(rec: ActionRecord): string {
  const color = sourceColor(rec.source);
  const label = esc(sourceLabel(rec.source));
  const badge = isAi(rec.source) ? '<span class="act-ai">AI</span>' : '';
  const unit = `<span class="act-unit">${esc(unitShort(rec.action.unitId))}</span>`;
  return (
    `<li class="act-row" style="border-left-color:${color}">` +
    `<div class="act-main">${badge}${actionStatusMark(rec.status)}${unit}<span class="act-desc">${esc(describeAction(rec.action))}</span></div>` +
    progressBar(rec) +
    `<div class="act-meta"><span class="act-who" style="color:${color}">${label}</span>` +
    `<span class="act-tick">t${rec.tick}</span></div>` +
    `</li>`
  );
}

export function mountActionsPanel(panel: HTMLElement): void {
  panel.innerHTML = `
    <h2>Actions</h2>
    <ul class="act-list" id="act-list"></ul>`;
  const list = panel.querySelector<HTMLElement>('#act-list')!;

  actionLog.subscribe((log) => {
    if (log.length === 0) {
      list.innerHTML = `<li class="act-empty">No actions yet. Click a unit or use the command bar.</li>`;
      return;
    }
    // Newest first; cap the DOM at a sane number regardless of buffer size.
    list.innerHTML = log.slice(-60).reverse().map(row).join('');
  });
}
