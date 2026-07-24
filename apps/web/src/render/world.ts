// SVG world renderer, split into two layers so tick-rate snapshots stay cheap:
//   • #terrain — flat terrain rects. Rebuilt only when the view changes (pan/
//     zoom/resize) or a new world arrives; terrain never changes mid-world.
//   • #dyn — objects, units, and the selection/target overlay. Rebuilt on every
//     snapshot (objects deplete, units move) and on view/selection changes.
// Both share one viewBox in tile-space, so zoom/pan are just viewBox math.
// Redraws are batched with requestAnimationFrame. Flat shapes now; swap in
// <image> sprites later without touching this file's structure.
import {
  BASE_TPS,
  BUILDINGS,
  BUILDING_IDS,
  RECIPES,
  RECIPE_IDS,
  TERRAIN_COLORS,
  bagLevel,
  baseSpeed,
  effectiveSpeed,
  encumbrance,
  isBuildable,
  tileAt,
  toCell,
  unitCapacity,
  unitLoad,
  unitShort,
} from '@game/shared';
import type { Unit, World } from '@game/shared';
import { sendAction } from '../net/client';
import { camera, game } from '../state/game';
import { selection } from '../state/selection';
import { setActive } from '../state/activeSurface';
import { recordDraw } from '../state/clientPerf';
import { isExplored, isVisible, rememberedObject, resetFog, updateFog } from '../state/fog';
import { pointerTile } from '../state/pointer';
import { closeLayer, openLayer } from '../ui/escStack';
import {
  buildingSvg,
  constructionSvg,
  itemIconSvg,
  itemsSvg,
  objectSvg,
  storageIconSvg,
  toolIconSvg,
  unitSvg,
} from './sprites';
import { clampTilesAcross, refreshViewportInfo, setViewportContainer, wheelZoom } from './viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Current viewBox in tile-space, kept so pointer events can map pixels → tiles.
interface View {
  left: number;
  top: number;
  viewW: number;
  viewH: number;
}

export function mountWorld(container: HTMLElement): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'world-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  // Layer order (bottom→top): terrain, remembered objects (stale memory), the
  // fog overlay (which dims everything beneath it), then the live dynamic layer
  // — visible objects/units sit above the fog, so they stay full-brightness.
  svg.innerHTML = `<g id="terrain"></g><g id="remembered"></g><g id="fog"></g><g id="dyn"></g>`;
  container.appendChild(svg);
  const terrainG = svg.querySelector<SVGGElement>('#terrain')!;
  const rememberedG = svg.querySelector<SVGGElement>('#remembered')!;
  const fogG = svg.querySelector<SVGGElement>('#fog')!;
  const dynG = svg.querySelector<SVGGElement>('#dyn')!;

  const info = document.createElement('div');
  info.className = 'sel-info';
  info.hidden = true;
  container.appendChild(info);
  attachMenu(info);

  const view: View = { left: 0, top: 0, viewW: 1, viewH: 1 };
  let lastWorldId: string | undefined;
  let needTerrain = true;
  let needDyn = true;
  let frame = 0;

  const schedule = (terrain: boolean, dyn: boolean): void => {
    needTerrain ||= terrain;
    needDyn ||= dyn;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  const render = (): void => {
    const world = game.get().world;
    const cam = camera.get();
    if (!world) return;

    const pxW = container.clientWidth || 1;
    const pxH = container.clientHeight || 1;
    const aspect = pxW / pxH;
    view.viewW = cam.tilesAcross;
    view.viewH = view.viewW / aspect;
    view.left = cam.cx - view.viewW / 2;
    view.top = cam.cy - view.viewH / 2;
    svg.setAttribute('viewBox', `${view.left} ${view.top} ${view.viewW} ${view.viewH}`);

    if (!needTerrain && !needDyn) return;

    // Time the SVG rebuild (string build + innerHTML parse) — the main-thread
    // work a redraw actually costs, so the Perf dialog can show it against the
    // frame budget. Excludes browser layout/paint, which we can't observe here.
    const t0 = performance.now();
    const range = cullRange(world, view);
    if (needTerrain) {
      terrainG.innerHTML = buildTerrain(world, range);
      needTerrain = false;
    }
    if (needDyn) {
      // Fog and remembered objects track the vision set, which moves with the
      // units every snapshot — so they rebuild whenever the dynamic layer does.
      rememberedG.innerHTML = buildRemembered(range);
      dynG.innerHTML = buildDyn(world, range, selection.get().unitId);
      fogG.innerHTML = buildFog(range);
      needDyn = false;
    }
    recordDraw(performance.now() - t0);
  };

  // A snapshot only changes objects/units → dyn layer; a NEW world (id change)
  // also rebuilds terrain and re-centers (handled in the client).
  game.subscribe(() => {
    const world = game.get().world;
    const newWorld = world && world.id !== lastWorldId;
    if (newWorld) {
      lastWorldId = world!.id;
      resetFog(); // a fresh world is fully undiscovered again
    }
    if (world) updateFog(world); // fold this snapshot into the client's map memory
    schedule(!!newWorld, true);
    updateInfo(info);
    // Even when updateInfo bails (structure unchanged), a live craft/build job's
    // timer still needs its per-tick nudge — patched without a rebuild.
    updateProgress(info);
  });
  camera.subscribe(() => schedule(true, true)); // view changed → re-cull both
  selection.subscribe(() => {
    const s = selection.get();
    schedule(false, true);
    updateInfo(info);
    container.classList.toggle('placing', !!s.pendingBuild);

    // Feed the Esc stack: a selected unit and (on top of it) placement mode are
    // each a dismissible layer, so Esc cancels placement first, then clears the
    // selection. Registering 'unit' before 'build' keeps that order.
    if (s.unitId) openLayer('unit', () => selection.set({ unitId: undefined, pendingBuild: undefined }));
    else closeLayer('unit');
    if (s.pendingBuild) openLayer('build', () => selection.set({ pendingBuild: undefined }));
    else closeLayer('build');
  });

  new ResizeObserver(() => {
    refreshViewportInfo();
    const cam = camera.get();
    const clamped = clampTilesAcross(cam.tilesAcross);
    if (clamped !== cam.tilesAcross) camera.set({ tilesAcross: clamped });
    schedule(true, true);
  }).observe(container);

  setViewportContainer(container);
  attachControls(svg, container, view);

  // Action-hint chip: with a unit selected, the map is in "targeting" mode, so a
  // single click DOES something (chop/mine/gather/pickup/deposit/move). A little
  // chip follows the cursor naming that action (and showing its icon) so the
  // player knows what a click will do before committing — we're a one-click game.
  const hint = document.createElement('div');
  hint.className = 'cursor-hint';
  hint.hidden = true;
  container.appendChild(hint);

  let lastClient: { x: number; y: number } | null = null;
  const updateHint = (clientX?: number, clientY?: number): void => {
    if (clientX != null && clientY != null) lastClient = { x: clientX, y: clientY };
    const world = game.get().world;
    const sel = selection.get();
    const u = sel.unitId && world ? world.units[sel.unitId] : undefined;
    // Only in targeting mode: a unit selected, not placing a building, cursor on map.
    if (!world || !u || sel.pendingBuild || !lastClient) {
      hint.hidden = true;
      container.classList.remove('targeting');
      return;
    }
    const rect = container.getBoundingClientRect();
    const x = Math.floor(view.left + ((lastClient.x - rect.left) / rect.width) * view.viewW);
    const y = Math.floor(view.top + ((lastClient.y - rect.top) / rect.height) * view.viewH);
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) {
      hint.hidden = true;
      container.classList.remove('targeting');
      return;
    }
    const h = actionHint(world, u, x, y);
    // A plain move has no chip (targeting crosshair is enough); only real
    // actions get a labelled hint.
    if (h) {
      hint.innerHTML = `<span class="ch-icon">${h.icon}</span><span class="ch-label">${h.label}</span>`;
      hint.classList.toggle('warn', !!h.warn);
      hint.style.left = `${lastClient.x - rect.left + 16}px`;
      hint.style.top = `${lastClient.y - rect.top + 18}px`;
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
    container.classList.add('targeting');
  };
  container.addEventListener('pointermove', (e) => updateHint(e.clientX, e.clientY));
  container.addEventListener('pointerleave', () => {
    hint.hidden = true;
    container.classList.remove('targeting');
  });
  // Recompute when the selection changes (enter/leave targeting) or a snapshot
  // changes what's under the cursor (e.g. a tree the pointer is over gets chopped).
  selection.subscribe(() => updateHint());
  game.subscribe(() => updateHint());
}

/** What a single click at (x,y) would do for the selected unit — the label + icon
 *  the cursor hint shows. Mirrors handleClick's dispatch so the preview never
 *  lies. `warn` flags an action the sim will reject (e.g. ore without a pickaxe). */
function actionHint(
  world: World,
  u: Unit,
  x: number,
  y: number,
): { label: string; icon: string; warn?: boolean } | null {
  const other = Object.values(world.units).find((v) => v.pos.x === x && v.pos.y === y);
  if (other && other.id !== u.id) return { label: `Select ${unitShort(other.id)}`, icon: SELECT_ICON };

  const tile = tileAt(world, x, y);
  const bld = tile?.building ? world.buildings[tile.building] : undefined;
  if (bld?.type === 'storage') {
    const carrying = Object.values(u.inventory).some((n) => n > 0);
    return carrying
      ? { label: 'Deposit', icon: storageIconSvg() }
      : { label: 'Withdraw', icon: storageIconSvg() };
  }
  if (tile?.object) {
    const o = tile.object;
    if (o.kind === 'tree' && o.hasFruit) return { label: 'Gather fruit', icon: itemIconSvg('fruit') };
    if (o.kind === 'tree') return { label: 'Chop', icon: toolIconSvg('axe') };
    if (o.kind === 'ore' && !u.tools.includes('pickaxe'))
      return { label: 'Mine — needs pickaxe', icon: toolIconSvg('pickaxe'), warn: true };
    return { label: 'Mine', icon: toolIconSvg('pickaxe') }; // rock / ore
  }
  if (tile?.items) {
    const key = Object.keys(tile.items)[0];
    if (key) return { label: `Pick up ${key}`, icon: itemIconSvg(key) };
  }
  // A plain move gets no hint chip.
  return null;
}
const SELECT_ICON =
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ffd54a" stroke-width="2" aria-hidden="true">` +
  `<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="#ffd54a"/></svg>`;

interface CullRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function cullRange(world: World, view: View): CullRange {
  return {
    x0: Math.max(0, Math.floor(view.left) - 1),
    y0: Math.max(0, Math.floor(view.top) - 1),
    x1: Math.min(world.width - 1, Math.ceil(view.left + view.viewW) + 1),
    y1: Math.min(world.height - 1, Math.ceil(view.top + view.viewH) + 1),
  };
}

function buildTerrain(world: World, r: CullRange): string {
  const parts: string[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const tile = tileAt(world, x, y);
      if (!tile) continue;
      const color = TERRAIN_COLORS[tile.terrain] ?? '#000';
      // 1.02 overlap hides hairline seams between rects at fractional zooms.
      parts.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${color}"/>`);
    }
  }
  return parts.join('');
}

// Objects drawn from memory: tiles we've explored but can't see right now. The
// fog overlay above darkens them, so they read as a faded recollection. Skip
// tiles that are currently visible — those are drawn live in the dyn layer.
function buildRemembered(r: CullRange): string {
  const parts: string[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      if (isVisible(x, y)) continue;
      const obj = rememberedObject(x, y);
      if (obj) parts.push(`<g transform="translate(${x} ${y})">${objectSvg(obj)}</g>`);
    }
  }
  return parts.join('');
}

// Semi-transparent rects over every non-visible tile: a light veil on explored
// ground, a heavy one on never-seen ground. Visible tiles get no rect, so they
// show through at full brightness.
function buildFog(r: CullRange): string {
  const parts: string[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      if (isVisible(x, y)) continue;
      const cls = isExplored(x, y) ? 'fog-dim' : 'fog-unseen';
      // Exact 1×1, no overlap: the rects are semi-transparent, so any overlap
      // would double the alpha along shared edges and paint a dark grid. crisp
      // edges (see CSS) keeps neighbours flush without anti-aliased seams.
      parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  return parts.join('');
}

function buildDyn(world: World, r: CullRange, selId: string | undefined): string {
  const parts: string[] = [];

  // Objects (mutable: they deplete as units work them) and loose ground items
  // (dropped resources awaiting pickup — never share a tile with an object).
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const tile = tileAt(world, x, y);
      if (tile?.object) parts.push(`<g transform="translate(${x} ${y})">${objectSvg(tile.object)}</g>`);
      else if (tile?.items) parts.push(`<g transform="translate(${x} ${y})">${itemsSvg(tile.items)}</g>`);
    }
  }

  // Buildings (placed structures; block movement).
  for (const id in world.buildings) {
    const b = world.buildings[id]!;
    if (b.pos.x < r.x0 || b.pos.x > r.x1 || b.pos.y < r.y0 || b.pos.y > r.y1) continue;
    // A storage depot with contents shows a few item mounds on top, so the
    // player can see at a glance what's stashed (mirrors loose ground piles).
    const store = b.type === 'storage' ? b.store : undefined;
    const inner = store ? `${buildingSvg(b.type)}${itemsSvg(store)}` : buildingSvg(b.type);
    parts.push(`<g transform="translate(${b.pos.x} ${b.pos.y})">${inner}</g>`);
  }

  // Construction sites: a unit with an active build job stakes out its plot the
  // moment work starts (the finished building only appears on completion), so
  // the site reads as "under construction" rather than empty. Dedup on tile so
  // two units targeting the same plot don't stack markers.
  const sites = new Set<string>();
  for (const id in world.units) {
    const job = world.units[id]!.buildJob;
    if (!job) continue;
    const { x, y } = job.at;
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    const key = `${x},${y}`;
    if (sites.has(key)) continue;
    sites.add(key);
    parts.push(`<g transform="translate(${x} ${y})">${constructionSvg(job.building)}</g>`);
  }

  // Units + their destination markers (drawn on top of everything).
  for (const id in world.units) {
    const u = world.units[id]!;
    if (u.pos.x < r.x0 - 1 || u.pos.x > r.x1 + 1 || u.pos.y < r.y0 - 1 || u.pos.y > r.y1 + 1) {
      continue;
    }
    const dest = destOf(u);
    if (dest) {
      parts.push(
        `<line x1="${u.pos.x + 0.5}" y1="${u.pos.y + 0.5}" x2="${dest.x + 0.5}" y2="${dest.y + 0.5}" ` +
          `stroke="#ffd54a" stroke-width="0.06" stroke-dasharray="0.18 0.14" opacity="0.75"/>`,
      );
      parts.push(
        `<circle cx="${dest.x + 0.5}" cy="${dest.y + 0.5}" r="0.16" fill="none" ` +
          `stroke="#ffd54a" stroke-width="0.06" opacity="0.85"/>`,
      );
    }
    parts.push(`<g transform="translate(${u.pos.x} ${u.pos.y})">${unitSvg(id === selId)}</g>`);
  }

  return parts.join('');
}

/** Where a unit is headed (job target if working, else the end of its path). */
function destOf(u: Unit): { x: number; y: number } | undefined {
  if (u.job) return u.job.target;
  if (u.path && u.path.length > 0) return u.path[u.path.length - 1];
  return undefined;
}

// The selection panel rebuilds by swapping innerHTML. Snapshots arrive ~10×/s,
// so without these guards a rebuild lands between a button's pointerdown and
// pointerup — the element is replaced and the browser never fires `click`
// (down/up on different nodes). `infoSig` skips rebuilds when nothing the panel
// shows has changed (an idle unit never churns); `infoPointerDown` defers any
// rebuild until the user releases, so a live click is never yanked out.
let infoSig: string | undefined;
let infoPointerDown = false;
let infoRebuildPending = false;

function updateInfo(info: HTMLElement): void {
  // Mid-press: don't touch the DOM; rebuild once the pointer is released.
  if (infoPointerDown) {
    infoRebuildPending = true;
    return;
  }

  const id = selection.get().unitId;
  const pendingBuild = selection.get().pendingBuild;
  const world = game.get().world;
  const u = id && world ? world.units[id] : undefined;
  if (!u) {
    info.hidden = true;
    infoSig = undefined;
    return;
  }
  info.hidden = false;

  // A unit chopping/mining/crafting/building is "busy": its job is
  // non-interruptible, so craft/build buttons are disabled and a ✕ appears to
  // cancel. A plain move / idle is NOT busy (still freely re-commandable).
  const busy = !!(u.job || u.craftJob || u.buildJob);
  const activeCraft = u.craftJob?.recipe;
  const activeBuild = u.buildJob?.building;

  const doing = u.craftJob
    ? `crafting ${RECIPES[u.craftJob.recipe]?.label ?? u.craftJob.recipe}`
    : u.buildJob
      ? `building ${BUILDINGS[u.buildJob.building]?.label ?? u.buildJob.building}`
      : u.job
        ? u.job.verb
        : u.path && u.path.length > 0
          ? 'moving'
          : 'idle';

  const inv = Object.entries(u.inventory);
  // Each carried stack gets a ⤓ button that drops the whole stack at the unit's
  // feet (dropNearby). Hidden while busy — a working unit rejects non-cancel
  // commands, so the button would no-op.
  const invHtml = inv.length
    ? inv
        .map(
          ([k, v]) =>
            `<span class="inv-item">${k} ${v}` +
            (busy ? '' : `<button class="inv-drop" data-drop="${k}" data-qty="${v}" title="Drop ${v} ${k} here">⤓</button>`) +
            `</span>`,
        )
        .join('')
    : `<span class="muted">empty</span>`;

  const toolsHtml = u.tools.length
    ? u.tools.map((t) => `<span class="inv-item tool">${RECIPES[t]?.label ?? t}</span>`).join('')
    : `<span class="muted">none</span>`;

  // Stats row: HP, armor, and current vs. base move speed (encumbrance drops the
  // effective speed; see stats.ts). Rounded for display only.
  const hp = Math.round(u.hp ?? 100);
  const maxHp = Math.round(u.maxHp ?? 100);
  const armor = u.armor ?? 0;
  const eff = Math.round(effectiveSpeed(u) * 100) / 100;
  const base = Math.round(baseSpeed() * 100) / 100;
  const slowed = eff < base - 0.001;
  const statsHtml =
    `<span class="stat">❤ ${hp}/${maxHp}</span>` +
    `<span class="stat">🛡 ${armor}</span>` +
    `<span class="stat${slowed ? ' stat-warn' : ''}">🏃 ${eff}${slowed ? `/${base}` : ''} t/s</span>`;

  // Bag fill bar: green→yellow→red→black by fraction of capacity (see bagLevel).
  const ratio = encumbrance(u);
  const load = Math.round(unitLoad(u) * 10) / 10;
  const cap = unitCapacity(u);
  const level = bagLevel(ratio);
  const fillPct = Math.min(100, Math.round(ratio * 100));
  const bagHtml =
    `<div class="bag-bar" title="${load} / ${cap}"><div class="bag-fill lvl-${level}" style="width:${fillPct}%"></div></div>` +
    `<span class="bag-num">${load}/${cap}</span>`;

  // A recipe/building button is enabled only if the unit can pay for it (and,
  // for tools, doesn't already own it) AND the unit isn't busy on another job.
  // The in-progress recipe/building is marked `active` (a live highlight).
  const craftBtns = RECIPE_IDS.map((rid) => {
    const rec = RECIPES[rid]!;
    const owned = u.tools.includes(rid);
    const afford = canAfford(u.inventory, rec.inputs);
    const active = activeCraft === rid ? 'active' : '';
    const dis = owned || !afford || busy ? 'disabled' : '';
    const note = owned ? 'have it' : costLabel(rec.inputs);
    return `<button class="menu-btn ${active}" data-craft="${rid}" ${dis}>${rec.label}<span class="menu-cost">${note}</span></button>`;
  }).join('');

  const buildBtns = BUILDING_IDS.map((bid) => {
    const def = BUILDINGS[bid]!;
    const afford = canAfford(u.inventory, def.inputs);
    const active = pendingBuild === bid || activeBuild === bid ? 'active' : '';
    const dis = !afford || busy ? 'disabled' : '';
    return `<button class="menu-btn ${active}" data-build="${bid}" ${dis}>${def.label}<span class="menu-cost">${costLabel(def.inputs)}</span></button>`;
  }).join('');

  // ✕ cancel: only for a busy (non-interruptible) unit. Idle/moving units have
  // nothing to cancel, so it's absent then.
  const cancelBtn = busy
    ? `<button class="sel-cancel" data-cancel="1" title="Cancel action" aria-label="Cancel action">✕</button>`
    : '';

  // The ✕ shares a row with the job's progress bar, so cancel sits with the
  // thing it stops. The bar itself shows only for timed jobs (craft/build) —
  // its fill width + meta text are refreshed each snapshot by updateProgress
  // WITHOUT rebuilding the panel, so the timer animates while buttons stay
  // clickable. A harvesting unit is still busy but has no bar, so the row then
  // carries just the ✕.
  const timed = u.craftJob ?? u.buildJob;
  const barHtml = timed ? `<div class="job-progress"><div class="job-fill"></div></div>` : '';
  const progressHtml = busy
    ? `<div class="job-bar">${barHtml}${cancelBtn}</div>${timed ? '<div class="job-meta"></div>' : ''}`
    : '';

  const hint = pendingBuild
    ? `<div class="sel-hint">Click a tile to place <b>${BUILDINGS[pendingBuild]?.label ?? pendingBuild}</b> · Esc to cancel</div>`
    : '';

  // Everything the panel's STRUCTURE derives from; if none changed, the existing
  // DOM is already correct — leaving it untouched keeps clicks clean. Job tick
  // `remaining`/`total` are deliberately EXCLUDED (they change ~10×/s) — the
  // progress bar is patched separately by updateProgress instead of rebuilt.
  const sig = JSON.stringify([
    u.id,
    u.pos,
    doing,
    u.inventory,
    u.tools,
    pendingBuild ?? '',
    busy,
    hp,
    maxHp,
    armor,
  ]);
  if (sig === infoSig) return;
  infoSig = sig;

  info.innerHTML =
    `<div class="sel-head"><b>${u.id}</b> <span class="muted">${toCell(u.pos)}</span>` +
    ` <span class="sel-doing">${doing}</span>` +
    `<button class="icon-btn sel-center" type="button" data-center-unit="1" title="Center on ${u.id}" aria-label="Center on ${u.id}">⌖</button></div>` +
    `<div class="sel-stats">${statsHtml}</div>` +
    `<div class="sel-row"><span class="sel-label">Tools</span>${toolsHtml}</div>` +
    `<div class="sel-row"><span class="sel-label">Bag</span>${bagHtml}</div>` +
    `<div class="sel-row"><span class="sel-label">Items</span>${invHtml}</div>` +
    progressHtml +
    `<div class="menu-title">Craft</div><div class="menu-grid">${craftBtns}</div>` +
    `<div class="menu-title">Build</div><div class="menu-grid">${buildBtns}</div>` +
    hint;

  // Seed the freshly-built progress bar with its current values.
  updateProgress(info);
}

/** Patch ONLY the craft/build progress bar (fill width + elapsed/remaining +
 *  cost) in place, without rebuilding the panel — so the timer animates every
 *  snapshot while the craft/build/cancel buttons stay intact for clicking. A
 *  no-op when the selected unit has no timed job (the bar isn't in the DOM). */
function updateProgress(info: HTMLElement): void {
  const fill = info.querySelector<HTMLElement>('.job-fill');
  const meta = info.querySelector<HTMLElement>('.job-meta');
  if (!fill || !meta) return;

  const id = selection.get().unitId;
  const u = id ? game.get().world?.units[id] : undefined;
  const job = u?.craftJob ?? u?.buildJob;
  if (!job) return;

  const total = job.total && job.total > 0 ? job.total : job.remaining;
  const done = total > 0 ? Math.max(0, Math.min(1, 1 - job.remaining / total)) : 0;
  fill.style.width = `${Math.round(done * 100)}%`;

  const secs = (t: number): string => `${Math.max(0, Math.round((t / BASE_TPS) * 10) / 10)}s`;
  const label = u?.craftJob
    ? `${RECIPES[u.craftJob.recipe]?.label ?? u.craftJob.recipe}`
    : `${BUILDINGS[u!.buildJob!.building]?.label ?? u!.buildJob!.building}`;
  const cost = u?.craftJob
    ? costLabel(RECIPES[u.craftJob.recipe]?.inputs ?? {})
    : costLabel(BUILDINGS[u!.buildJob!.building]?.inputs ?? {});
  meta.textContent =
    `${label} · ${secs(total - job.remaining)} / ${secs(total)} · ${secs(job.remaining)} left` +
    (cost ? ` · ${cost}` : '');
}

/** Can this inventory cover a cost map? Mirrors sim.canAfford for UI gating. */
function canAfford(inv: Record<string, number>, cost: Record<string, number>): boolean {
  return Object.entries(cost).every(([k, n]) => (inv[k] ?? 0) >= n);
}

function costLabel(cost: Record<string, number>): string {
  return Object.entries(cost)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

function attachControls(svg: SVGSVGElement, container: HTMLElement, view: View): void {
  container.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelZoom(e);
    },
    { passive: false },
  );

  // Track the tile under the cursor for the topbar mouse-coordinate readout.
  // Dedup on tile so we only publish when the hovered tile actually changes.
  container.addEventListener('pointermove', (e) => {
    const world = game.get().world;
    const cur = pointerTile.get().tile;
    if (!world) {
      if (cur) pointerTile.set({ tile: null });
      return;
    }
    const rect = container.getBoundingClientRect();
    const x = Math.floor(view.left + ((e.clientX - rect.left) / rect.width) * view.viewW);
    const y = Math.floor(view.top + ((e.clientY - rect.top) / rect.height) * view.viewH);
    const inBounds = x >= 0 && y >= 0 && x < world.width && y < world.height;
    if (!inBounds) {
      if (cur) pointerTile.set({ tile: null });
    } else if (!cur || cur.x !== x || cur.y !== y) {
      pointerTile.set({ tile: { x, y } });
    }
  });
  container.addEventListener('pointerleave', () => {
    if (pointerTile.get().tile) pointerTile.set({ tile: null });
  });

  // A gesture is a pan once it moves past a small threshold; otherwise it's a
  // click (select a unit, or command the selected unit).
  const DRAG_PX = 4;
  let down = false;
  let movedFar = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  container.addEventListener('pointerdown', (e) => {
    setActive('map'); // clicking the map claims keyboard focus, even if a panel is open
    down = true;
    movedFar = false;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    container.setPointerCapture(e.pointerId);
  });

  container.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!movedFar && Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_PX) {
      movedFar = true;
      svg.classList.add('grabbing');
    }
    if (!movedFar) return;
    const cam = camera.get();
    const world = game.get().world;
    const tilesPerPx = cam.tilesAcross / (container.clientWidth || 1);
    const dxTiles = (e.clientX - lastX) * tilesPerPx;
    const dyTiles = (e.clientY - lastY) * tilesPerPx;
    lastX = e.clientX;
    lastY = e.clientY;
    camera.set({
      cx: clamp(cam.cx - dxTiles, 0, world?.width ?? cam.cx),
      cy: clamp(cam.cy - dyTiles, 0, world?.height ?? cam.cy),
    });
  });

  const endDrag = (e: PointerEvent): void => {
    if (down && !movedFar) handleClick(e, container, view);
    down = false;
    if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
    svg.classList.remove('grabbing');
  };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);
}

/** Delegated handling for the overlay's craft/build buttons. The overlay sits
 *  inside the world container, so we also stop pointer events from falling
 *  through to the pan/click gesture behind it. */
function attachMenu(info: HTMLElement): void {
  for (const ev of ['pointerdown', 'pointerup', 'click'] as const) {
    info.addEventListener(ev, (e) => e.stopPropagation());
  }

  // Freeze rebuilds while a button is pressed (see updateInfo). pointerup is on
  // window+capture so a release still lands even if it happens off the panel —
  // and capture dodges the stopPropagation above, which kills the bubble phase.
  // The deferred rebuild waits a frame so the `click` this pointerup generates
  // fires against the still-intact button before we swap the DOM.
  info.addEventListener('pointerdown', () => {
    infoPointerDown = true;
  });
  window.addEventListener(
    'pointerup',
    () => {
      if (!infoPointerDown) return;
      infoPointerDown = false;
      if (infoRebuildPending) {
        infoRebuildPending = false;
        requestAnimationFrame(() => updateInfo(info));
      }
    },
    true,
  );

  info.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-craft],[data-build],[data-cancel],[data-drop],[data-center-unit]',
    );
    if (!btn) return;
    const selId = selection.get().unitId;
    if (!selId) return;
    if (btn.dataset.centerUnit) {
      const unit = game.get().world?.units[selId];
      if (unit) camera.set({ cx: unit.pos.x + 0.5, cy: unit.pos.y + 0.5 });
    } else if (btn.dataset.cancel) {
      // Stop the unit's current non-interruptible job (refunds craft inputs).
      sendAction({ type: 'cancel', unitId: selId });
      selection.set({ pendingBuild: undefined });
    } else if (btn.dataset.drop) {
      // Drop the whole carried stack of this item at the unit's feet.
      const qty = Number(btn.dataset.qty) || 0;
      if (qty > 0) sendAction({ type: 'dropNearby', unitId: selId, item: btn.dataset.drop, qty });
    } else if (btn.dataset.craft) {
      sendAction({ type: 'craft', unitId: selId, recipe: btn.dataset.craft });
      selection.set({ pendingBuild: undefined });
    } else if (btn.dataset.build) {
      // Toggle placement mode; clicking the active build again cancels it.
      const cur = selection.get().pendingBuild;
      selection.set({ pendingBuild: cur === btn.dataset.build ? undefined : btn.dataset.build });
    }
  });
}

/** Click-a-unit-then-click-a-target: in placement mode a click sites the
 *  pending building; otherwise a unit under the cursor selects it, and with a
 *  unit selected an object tile issues a harvest and a walkable tile a move. */
function handleClick(e: PointerEvent, container: HTMLElement, view: View): void {
  const world = game.get().world;
  if (!world) return;
  const rect = container.getBoundingClientRect();
  const tx = view.left + ((e.clientX - rect.left) / rect.width) * view.viewW;
  const ty = view.top + ((e.clientY - rect.top) / rect.height) * view.viewH;
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;

  // Placement mode: this click places the pending building on a buildable tile.
  const pending = selection.get().pendingBuild;
  if (pending) {
    const selId = selection.get().unitId;
    if (selId && world.units[selId] && isBuildable(world, x, y)) {
      sendAction({ type: 'build', unitId: selId, building: pending, at: { x, y } });
      selection.set({ pendingBuild: undefined });
    }
    return; // invalid tile → stay in placement mode (Esc to cancel)
  }

  const hit = Object.values(world.units).find((u) => u.pos.x === x && u.pos.y === y);
  if (hit) {
    selection.set({ unitId: hit.id });
    return;
  }

  const selId = selection.get().unitId;
  if (!selId || !world.units[selId]) return;

  const tile = tileAt(world, x, y);
  const bld = tile?.building ? world.buildings[tile.building] : undefined;
  if (bld?.type === 'storage') {
    // Click a storage depot with a unit selected: deposit the whole bag if the
    // unit is carrying anything, otherwise withdraw everything that fits. Both
    // reuse the depot-aware drop/pickup (the unit walks adjacent, then transfers).
    const carrying = Object.values(world.units[selId]!.inventory).some((n) => n > 0);
    sendAction(
      carrying
        ? { type: 'drop', unitId: selId, at: { x, y } }
        : { type: 'pickup', unitId: selId, at: { x, y } },
    );
  } else if (tile?.object) {
    sendAction({ type: 'harvest', unitId: selId, target: { x, y } });
  } else if (tile?.items) {
    // Loose pile on the ground → send the unit to pick it up (mirrors the
    // click-an-object-to-harvest gesture).
    sendAction({ type: 'pickup', unitId: selId, at: { x, y } });
  } else {
    // Any other tile — walkable, water, or still under fog — issues a
    // best-effort move. We deliberately DON'T pre-check walkability here: a
    // refused click would reveal hidden terrain. The unit heads over and only
    // discovers blockers via its own vision (see stepTravel in sim).
    sendAction({ type: 'move', unitId: selId, to: { x, y } });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
