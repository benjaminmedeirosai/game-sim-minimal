// The Controls panel, tabbed:
//   • Hotkeys — keyboard shortcuts only (things you press).
//   • Guide   — what the mouse and the toolbar buttons do (things you click).
//   • Assets  — a visual catalogue of every game asset (sprite + key stats),
//     grouped by category, so you can eyeball what everything looks like and
//     what its numbers are in one spot.
//   • Actions — the full command vocabulary: every action the AI can emit and
//     the player can trigger, with what each does and who reaches it.
// A floating panel, so it can be left open beside the map for reference;
// clicking the map re-arms the keyboard without closing it.
import {
  TREES,
  ROCKS,
  ORES,
  TERRAIN_COLORS,
  ITEMS,
  BUILDINGS,
  RECIPES,
  HARVEST_RULES,
  OBJECT_DEFENSE,
  OBJECT_HP,
} from '@game/shared';
import type { WorldObject } from '@game/shared';
import { objectSvg, itemSvg, buildingSvg } from '../render/sprites';

interface Row {
  keys: string[]; // rendered as <kbd> chips
  desc: string;
}

function grid(rows: Row[]): string {
  return `<div class="ctl-grid">${rows
    .map(
      (r) =>
        `<div class="ctl-keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</div>` +
        `<div class="ctl-desc">${r.desc}</div>`,
    )
    .join('')}</div>`;
}

function section(title: string, rows: Row[]): string {
  return `<h2 class="mt">${title}</h2>${grid(rows)}`;
}

// Keyboard shortcuts — the things you actually press.
function hotkeysTab(): string {
  return (
    section('Map', [
      { keys: ['W', 'A', 'S', 'D'], desc: 'Pan the map' },
      { keys: ['↑', '↓', '←', '→'], desc: 'Pan the map' },
    ]) +
    section('General', [
      { keys: ['Esc'], desc: 'Cancel placement, then deselect, then close a panel' },
    ]) +
    `<p class="hint">Keys only pan when the map is active — click the map to
      re-arm them after using a panel or the chat. Pan speed is adjustable in
      Settings.</p>`
  );
}

// What things do — mouse gestures and the toolbar buttons.
function guideTab(): string {
  return (
    section('Mouse', [
      { keys: ['Click'], desc: 'Select the unit under the cursor' },
      { keys: ['Click'], desc: 'With a unit selected: move it to that tile' },
      { keys: ['Click'], desc: 'With a unit selected: harvest a resource tile' },
      { keys: ['Click'], desc: 'In placement mode: site the pending building' },
      { keys: ['Drag'], desc: 'Pan the map' },
      { keys: ['Wheel'], desc: 'Zoom in / out' },
    ]) +
    section('Toolbar', [
      { keys: ['⏸', '1×', '2×', '4×', '8×'], desc: 'Simulation speed' },
      { keys: ['−', '+'], desc: 'Zoom out / in (or the slider)' },
      { keys: ['⌖'], desc: 'Recenter the camera' },
      { keys: ['☰'], desc: 'Toggle the left sidebar layout' },
    ])
  );
}

// --- Assets catalogue -----------------------------------------------------
// Every asset the game draws, with the stats that matter, read straight from
// the shared registries so this never drifts from the sim.

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Wrap a tile-space (0..1) glyph in a small fixed-size SVG for a catalogue card. */
function sprite(inner: string): string {
  return `<span class="cat-sprite"><svg viewBox="0 0 1 1" width="40" height="40" aria-hidden="true">${inner}</svg></span>`;
}

/** A flat colour swatch (for terrain, which has no glyph). */
function swatch(color: string): string {
  return `<span class="cat-sprite"><span class="cat-swatch" style="background:${color}"></span></span>`;
}

/** One catalogue card: a sprite, a name, and a set of key/value stat chips. */
function card(spriteHtml: string, name: string, stats: Array<[string, string]>): string {
  const chips = stats
    .map(([k, v]) => `<span class="cat-stat"><span class="cs-k">${k}</span> ${v}</span>`)
    .join('');
  return (
    `<div class="cat-card">${spriteHtml}` +
    `<div class="cat-info"><div class="cat-name">${name}</div>` +
    `<div class="cat-stats">${chips}</div></div></div>`
  );
}

function catSection(title: string, cards: string[]): string {
  return `<h2 class="mt">${title}</h2><div class="cat-grid">${cards.join('')}</div>`;
}

/** "4 wood, 1 stone" from a yields/inputs map. */
function amounts(map: Record<string, number>): string {
  return Object.entries(map)
    .map(([id, n]) => `${n} ${ITEMS[id]?.label.toLowerCase() ?? id}`)
    .join(', ');
}

/** How a harvestable kind responds to tools, in words. */
function toolNote(kind: string): string {
  const rule = HARVEST_RULES[kind];
  if (rule?.require) return `needs ${rule.require}`;
  if (rule?.boost) return `faster w/ ${rule.boost}`;
  return 'bare hands';
}

function harvestCards(): string[] {
  const cards: string[] = [];
  const add = (obj: WorldObject, label: string, yields: Record<string, number>): void => {
    const def = obj.defense ?? OBJECT_DEFENSE[obj.kind] ?? 1;
    cards.push(
      card(sprite(objectSvg(obj)), label, [
        ['HP', String(obj.hp)],
        ['DEF', String(def)],
        ['Yields', amounts(yields)],
        ['Tool', toolNote(obj.kind)],
      ]),
    );
  };
  for (const [type, d] of Object.entries(TREES))
    add({ kind: 'tree', type, hasFruit: false, hp: OBJECT_HP.tree, defense: OBJECT_DEFENSE.tree }, cap(type), d.yields);
  for (const [type, d] of Object.entries(ROCKS))
    add({ kind: 'rock', type, hp: OBJECT_HP.rock, defense: OBJECT_DEFENSE.rock }, cap(type), d.yields);
  for (const [type, d] of Object.entries(ORES))
    add({ kind: 'ore', type, hp: OBJECT_HP.ore, defense: OBJECT_DEFENSE.ore }, `${cap(type)} ore`, d.yields);
  return cards;
}

const TOOL_IDS = Object.keys(RECIPES); // axe, pickaxe — the craftable, non-stacking items

function itemCards(kind: 'resource' | 'tool'): string[] {
  return Object.entries(ITEMS)
    .filter(([id]) => (kind === 'tool') === TOOL_IDS.includes(id))
    .map(([id, d]) => {
      const stats: Array<[string, string]> = [['Weight', String(d.weight)]];
      if (d.stack > 1) stats.push(['Stack', String(d.stack)]);
      const recipe = RECIPES[id];
      if (recipe) stats.push(['Craft', amounts(recipe.inputs)]);
      return card(sprite(itemSvg(id)), d.label, stats);
    });
}

function buildingCards(): string[] {
  return Object.entries(BUILDINGS).map(([type, d]) =>
    card(sprite(buildingSvg(type)), d.label, [
      ['Cost', amounts(d.inputs)],
      ['Work', `${d.workTicks} ticks`],
    ]),
  );
}

function terrainCards(): string[] {
  return Object.entries(TERRAIN_COLORS).map(([name, color]) =>
    card(swatch(color), cap(name), [['Move', name === 'water' ? 'impassable' : 'walkable']]),
  );
}

// A catalogue of every asset the game draws, grouped by category.
function assetsTab(): string {
  return (
    catSection('Harvestables', harvestCards()) +
    catSection('Resources', itemCards('resource')) +
    catSection('Tools', itemCards('tool')) +
    catSection('Buildings', buildingCards()) +
    catSection('Terrain', terrainCards()) +
    `<p class="hint">Everything the sim draws, read straight from the content
      registries — HP &amp; defense drive how long harvesting takes, weight &amp;
      stack size drive what a unit can carry.</p>`
  );
}

// --- Actions catalogue ----------------------------------------------------
// Every command that can drive a unit (or the camera), the same vocabulary the
// AI emits and the player triggers by clicking. Mirrors the Action union in
// packages/shared/src/actions.ts.

interface ActionDoc {
  name: string;
  type: string; // the JSON "type" the sim/AI use
  args: string; // fields beyond the action type
  who: string; // how it's reached
  desc: string;
}

/** One action card: a name + type badge, a sentence, and arg/access chips. */
function actCard(a: ActionDoc): string {
  return (
    `<div class="cat-card act-card"><div class="cat-info">` +
    `<div class="cat-name">${a.name} <code class="act-type">${a.type}</code></div>` +
    `<div class="act-desc">${a.desc}</div>` +
    `<div class="cat-stats">` +
    `<span class="cat-stat"><span class="cs-k">Args</span> ${a.args}</span>` +
    `<span class="cat-stat"><span class="cs-k">Who</span> ${a.who}</span>` +
    `</div></div></div>`
  );
}

function actSection(title: string, actions: ActionDoc[]): string {
  return `<h2 class="mt">${title}</h2><div class="cat-grid act-list">${actions.map(actCard).join('')}</div>`;
}

const UNIT_ACTIONS: ActionDoc[] = [
  {
    name: 'Move',
    type: 'move',
    args: 'unitId, to',
    who: 'Player + AI',
    desc: 'Walk a unit to a tile. Only for repositioning or scouting — targeted actions already walk themselves, so you rarely need a bare move first.',
  },
  {
    name: 'Harvest',
    type: 'harvest',
    args: 'unitId, target',
    who: 'Player + AI',
    desc: 'Work the object on the target tile — chop a tree for wood, gather a fruit tree for food, or mine rock/ore. The verb is inferred from what is there; the unit walks over first. Only one unit can work a given tile at a time.',
  },
  {
    name: 'Craft',
    type: 'craft',
    args: 'unitId, recipe',
    who: 'Player + AI',
    desc: 'Turn carried resources into a tool (axe, pickaxe) over the recipe’s work ticks. The unit stands still while crafting; inputs are reserved up front and refunded if cancelled.',
  },
  {
    name: 'Build',
    type: 'build',
    args: 'unitId, building, at',
    who: 'Player + AI',
    desc: 'Walk to a tile and raise a building (campfire, workbench, storage, house). A construction marker drops as soon as work starts; the carried inputs are spent on completion.',
  },
  {
    name: 'Drop',
    type: 'drop',
    args: 'unitId, at, item?, qty?',
    who: 'Player (at a depot) + AI',
    desc: 'Walk to a tile and set carried resources down. Onto a storage depot this deposits; onto plain ground it leaves a loose pile. Omit item to unload the whole bag.',
  },
  {
    name: 'Drop nearby',
    type: 'dropNearby',
    args: 'unitId, item?, qty?',
    who: 'Player (unit menu) + AI',
    desc: 'Drop resources on the ground right where the unit stands — no walking. Omit item to dump the whole bag. Overfilled bags shed their excess this way automatically.',
  },
  {
    name: 'Pick up',
    type: 'pickup',
    args: 'unitId, at, item?, qty?',
    who: 'Player (at a pile/depot) + AI',
    desc: 'Collect resources at a tile into the bag. From a storage depot this withdraws; from the ground it grabs a loose pile. Omit item to take all that fits under the carry limit.',
  },
  {
    name: 'Cancel',
    type: 'cancel',
    args: 'unitId',
    who: 'Player (✕) + AI',
    desc: 'Stop a unit’s current non-interruptible job (harvest/craft/build) and leave it idle. Craft inputs are refunded. The only command a busy unit will accept.',
  },
];

const CAMERA_ACTIONS: ActionDoc[] = [
  {
    name: 'Move view',
    type: 'setView',
    args: 'center?, tilesAcross?',
    who: 'AI (players pan/zoom directly)',
    desc: 'Pan and/or zoom the requesting player’s own camera. A view-only nudge (e.g. “show me unit-2”, “zoom out”) — it never changes the world or moves anyone else’s view.',
  },
];

// A catalogue of every command the AI can emit and the player can trigger.
function actionsTab(): string {
  return (
    actSection('Unit commands', UNIT_ACTIONS) +
    actSection('Camera', CAMERA_ACTIONS) +
    `<p class="hint">The full command vocabulary. The AI emits these as JSON; you
      trigger the same ones by clicking the map and the unit menu. Targeted
      actions (harvest, build, drop, pickup) walk the unit over on their own.</p>`
  );
}

type Tab = 'hotkeys' | 'guide' | 'assets' | 'actions';

export function mountControls(el: HTMLElement): void {
  let tab: Tab = 'hotkeys';
  el.innerHTML = `
    <h2>Controls</h2>
    <div class="ai-tabs" id="ctl-tabs">
      <button class="ai-tab" data-tab="hotkeys">Hotkeys</button>
      <button class="ai-tab" data-tab="guide">Guide</button>
      <button class="ai-tab" data-tab="assets">Assets</button>
      <button class="ai-tab" data-tab="actions">Actions</button>
    </div>
    <div id="ctl-body"></div>`;

  const tabs = el.querySelector<HTMLElement>('#ctl-tabs')!;
  const body = el.querySelector<HTMLElement>('#ctl-body')!;

  const render = (): void => {
    tabs.querySelectorAll<HTMLElement>('.ai-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    body.innerHTML =
      tab === 'hotkeys'
        ? hotkeysTab()
        : tab === 'assets'
          ? assetsTab()
          : tab === 'actions'
            ? actionsTab()
            : guideTab();
  };

  tabs.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.ai-tab');
    if (!btn) return;
    const t = btn.dataset.tab;
    tab =
      t === 'guide' ? 'guide' : t === 'assets' ? 'assets' : t === 'actions' ? 'actions' : 'hotkeys';
    render();
  });

  render();
}
