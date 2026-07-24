// The Actions panel: a live feed of every action in the world, newest first,
// attributed to whoever submitted it (player or AI). Each row's left border is
// colored by source; AI rows are badged. Fed by the actionLog store, which the
// host refreshes with every snapshot.
import { BUILDINGS, ITEMS, RECIPES, describeAction, parseCell, toCell, unitShort } from '@game/shared';
import type { Action, ActionRecord, Coord, World } from '@game/shared';
import { actionLog, sendAction } from '../net/client';
import { game } from '../state/game';
import { actionStatusMark, isAi, sourceColor, sourceLabel } from './attribution';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
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
    `<li class="act-row" data-action-id="${esc(rec.id)}" style="border-left-color:${color}">` +
    `<div class="act-main">${badge}${actionStatusMark(rec.status)}${unit}<span class="act-desc">${esc(describeAction(rec.action))}</span></div>` +
    progressBar(rec) +
    `<div class="act-meta"><span class="act-who" style="color:${color}">${label}</span>` +
    `<span class="act-tick">t${rec.tick}</span></div>` +
    `</li>`
  );
}

function makeRow(markup: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild as HTMLElement;
}

type Verb = 'move' | 'harvest' | 'craft' | 'build' | 'drop' | 'dropnearby' | 'pickup' | 'cancel';

const VERBS: Verb[] = ['move', 'harvest', 'craft', 'build', 'drop', 'dropnearby', 'pickup', 'cancel'];
const PARAMS: Record<Verb, string[]> = {
  move: ['unit', 'cell'], harvest: ['unit', 'cell or area', 'type (optional)'], craft: ['unit', 'recipe'],
  build: ['unit', 'building', 'cell'], drop: ['unit', 'cell', 'item (optional)', 'quantity (optional)'],
  dropnearby: ['unit', 'item (optional)', 'quantity (optional)'], pickup: ['unit', 'cell or area', 'item (optional)', 'quantity (optional)'],
  cancel: ['unit'],
};

function inBounds(token: string, world: World): Coord | undefined {
  const cell = parseCell(token);
  return cell && cell.x >= 0 && cell.y >= 0 && cell.x < world.width && cell.y < world.height ? cell : undefined;
}

/** Keep the direct composer compatible with the AI line grammar: `unit0`,
 * `0`, and the canonical `unit-0` all identify the same live unit. */
function resolveUnit(token: string | undefined, world: World) {
  if (token && world.units[token]) return world.units[token];
  const match = token?.match(/(\d+)\s*$/);
  return match ? world.units[`unit-${Number(match[1])}`] : undefined;
}

function nearestInRange(world: World, from: Coord, range: string, predicate: (x: number, y: number) => boolean): Coord | undefined {
  const [a, b] = range.split(':').map((part) => inBounds(part, world));
  if (!a || !b) return undefined;
  let best: Coord | undefined;
  let distance = Infinity;
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    if (!predicate(x, y)) continue;
    const d = Math.abs(from.x - x) + Math.abs(from.y - y);
    if (d < distance) { best = { x, y }; distance = d; }
  }
  return best;
}

function actionFromTokens(tokens: string[], world: World | undefined): Action | undefined {
  if (!world || !tokens.length) return undefined;
  const verb = tokens[0]?.toLowerCase() as Verb;
  if (!VERBS.includes(verb)) return undefined;
  const unit = resolveUnit(tokens[1], world);
  if (!unit) return undefined;
  const cell = (token: string | undefined): Coord | undefined => token ? inBounds(token, world) : undefined;
  const itemQty = (tail: string[]): { item?: string; qty?: number } | undefined => {
    let item: string | undefined;
    let qty: number | undefined;
    for (const value of tail) {
      if (/^\d+$/.test(value)) qty ??= Number(value);
      else if (!item && ITEMS[value]) item = value;
      else return undefined;
    }
    return qty && qty < 1 ? undefined : { ...(item ? { item } : {}), ...(qty ? { qty } : {}) };
  };
  const ranged = (token: string | undefined, test: (x: number, y: number) => boolean): Coord | undefined =>
    token?.includes(':') ? nearestInRange(world, unit.pos, token, test) : cell(token);

  switch (verb) {
    case 'move': { const to = cell(tokens[2]); return to && tokens.length === 3 ? { type: 'move', unitId: unit.id, to } : undefined; }
    case 'harvest': {
      const target = ranged(tokens[2], (x, y) => !!world.tiles[y * world.width + x]?.object);
      return target && tokens.length <= 4 ? { type: 'harvest', unitId: unit.id, target } : undefined;
    }
    case 'craft': return RECIPES[tokens[2] ?? ''] && tokens.length === 3 ? { type: 'craft', unitId: unit.id, recipe: tokens[2]! } : undefined;
    case 'build': { const at = cell(tokens[3]); return BUILDINGS[tokens[2] ?? ''] && at && tokens.length === 4 ? { type: 'build', unitId: unit.id, building: tokens[2]!, at } : undefined; }
    case 'drop': { const at = cell(tokens[2]); const tail = itemQty(tokens.slice(3)); return at && tail && tokens.length <= 5 ? { type: 'drop', unitId: unit.id, at, ...tail } : undefined; }
    case 'dropnearby': { const tail = itemQty(tokens.slice(2)); return tail && tokens.length <= 4 ? { type: 'dropNearby', unitId: unit.id, ...tail } : undefined; }
    case 'pickup': {
      const at = ranged(tokens[2], (x, y) => !!world.tiles[y * world.width + x]?.items);
      const tail = itemQty(tokens.slice(3));
      return at && tail && tokens.length <= 5 ? { type: 'pickup', unitId: unit.id, at, ...tail } : undefined;
    }
    case 'cancel': return tokens.length === 2 ? { type: 'cancel', unitId: unit.id } : undefined;
  }
}

function suggestions(tokens: string[], trailingSpace: boolean, world: World | undefined): string[] {
  const index = trailingSpace ? tokens.length : tokens.length - 1;
  const typed = (trailingSpace ? '' : tokens[index] ?? '').toLowerCase();
  const verb = tokens[0]?.toLowerCase() as Verb;
  let values: string[];
  if (index === 0) values = VERBS;
  else if (!world || !VERBS.includes(verb)) values = [];
  else if (index === 1) values = Object.keys(world.units);
  else if (['craft'].includes(verb) && index === 2) values = Object.keys(RECIPES);
  else if (verb === 'build' && index === 2) values = Object.keys(BUILDINGS);
  else if (verb === 'harvest' && index === 3) values = ['tree', 'fruit', 'rock', 'ore'];
  else if ((verb === 'drop' && index === 3) || (verb === 'dropnearby' && index === 2) || (verb === 'pickup' && index === 3)) {
    const unit = resolveUnit(tokens[1], world);
    values = unit ? Object.keys(unit.inventory).filter((item) => unit.inventory[item]! > 0) : Object.keys(ITEMS);
  } else if ((verb === 'drop' && index === 4) || (verb === 'dropnearby' && index === 3) || (verb === 'pickup' && index === 4)) {
    const unit = resolveUnit(tokens[1], world);
    const item = tokens[index - 1];
    values = unit && item ? [String(unit.inventory[item] ?? '')].filter(Boolean) : [];
  } else {
    // Cells are intentionally typed, but surface useful live values first.
    values = world ? Object.values(world.units).map((unit) => toCell(unit.pos)) : [];
  }
  return values.filter((value) => value.toLowerCase().startsWith(typed)).slice(0, 7);
}

export function mountActionsPanel(panel: HTMLElement): void {
  panel.innerHTML = `
    <h2>Actions</h2>
    <ul class="act-list" id="act-list"></ul>
    <form class="action-form" id="action-form">
      <input class="action-input" autocomplete="off" spellcheck="false" placeholder="move unit-0 A1" aria-label="Direct action command" />
      <button class="btn action-send" type="submit">Run</button>
      <div class="action-help" id="action-help" aria-live="polite"></div>
    </form>`;
  const list = panel.querySelector<HTMLElement>('#act-list')!;
  const form = panel.querySelector<HTMLFormElement>('#action-form')!;
  const input = panel.querySelector<HTMLInputElement>('.action-input')!;
  const help = panel.querySelector<HTMLElement>('#action-help')!;
  let helpOpen = true;

  const renderHelp = (): void => {
    if (!helpOpen) { help.replaceChildren(); return; }
    const trailingSpace = /\s$/.test(input.value);
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    const options = suggestions(tokens, trailingSpace, game.get().world);
    const verb = tokens[0]?.toLowerCase() as Verb;
    const index = trailingSpace ? tokens.length : Math.max(0, tokens.length - 1);
    const hint = index === 0 ? 'Choose an action' : PARAMS[verb]?.[index - 1];
    const rangeTarget = (verb === 'harvest' || verb === 'pickup') && index === 2;
    const world = game.get().world;
    const cell = options[0] ?? (world ? toCell(Object.values(world.units)[0]?.pos ?? { x: 0, y: 0 }) : 'A1');
    const point = world && inBounds(cell, world);
    const range = point && world
      ? `${cell}:${toCell({ x: Math.min(world.width - 1, point.x + 2), y: Math.min(world.height - 1, point.y + 2) })}`
      : 'A1:C3';
    const examples = rangeTarget
      ? `<span class="action-hint">cell</span><button type="button" data-action-option="${esc(cell)}">${esc(cell)}</button>` +
        `<span class="action-hint">or area</span><button type="button" data-action-option="${esc(range)}">${esc(range)}</button>`
      : options.map((option) => `<button type="button" data-action-option="${esc(option)}">${esc(option)}</button>`).join('');
    help.innerHTML = `${hint && !rangeTarget ? `<span class="action-hint">${hint}</span>` : ''}${examples}`;
  };
  const choose = (value: string): void => {
    const trailingSpace = /\s$/.test(input.value);
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    const index = trailingSpace ? tokens.length : Math.max(0, tokens.length - 1);
    tokens[index] = value;
    input.value = `${tokens.join(' ')} `;
    helpOpen = true;
    renderHelp();
  };

  input.addEventListener('input', () => { helpOpen = true; renderHelp(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); helpOpen = false; renderHelp(); }
    if (event.key === 'Tab') {
      const options = suggestions(input.value.trim().split(/\s+/).filter(Boolean), /\s$/.test(input.value), game.get().world);
      if (options[0]) { event.preventDefault(); choose(options[0]); }
    }
  });
  help.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action-option]')?.dataset.actionOption;
    if (option) choose(option);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const action = actionFromTokens(input.value.trim().split(/\s+/).filter(Boolean), game.get().world);
    if (!action) { helpOpen = true; help.innerHTML = `<span class="action-error">Complete a valid action before running it.</span>`; return; }
    sendAction(action);
    input.value = '';
    helpOpen = true;
    renderHelp();
  });
  game.subscribe(renderHelp);
  renderHelp();

  actionLog.subscribe((log) => {
    if (log.length === 0) {
      if (!list.querySelector('.act-empty')) {
        list.innerHTML = `<li class="act-empty">No actions yet. Click a unit or use the command bar.</li>`;
      }
      return;
    }

    // Newest first; cap the DOM at a sane number regardless of buffer size.
    // Snapshots arrive several times per second, but most action records are
    // unchanged. Reconcile by record id so only changed cards are replaced.
    const records = log.slice(-60).reverse();
    const existing = new Map(
      [...list.querySelectorAll<HTMLElement>('.act-row')].map((element) => [element.dataset.actionId!, element]),
    );
    const desired: HTMLElement[] = [];

    for (const rec of records) {
      const markup = row(rec);
      const current = existing.get(rec.id);
      const element = current && current.outerHTML === markup ? current : makeRow(markup);
      if (current && element !== current) current.replaceWith(element);
      existing.delete(rec.id);
      desired.push(element);
    }

    // Discard records that have aged out of the visible tail.
    for (const element of existing.values()) element.remove();

    // A new record normally inserts at the front; leave every already-correct
    // card in place so snapshot churn does not touch its DOM.
    desired.forEach((element, index) => {
      if (list.children[index] !== element) list.insertBefore(element, list.children[index] ?? null);
    });
  });
}
