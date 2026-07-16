// SVG world renderer, split into two layers so tick-rate snapshots stay cheap:
//   • #terrain — flat terrain rects. Rebuilt only when the view changes (pan/
//     zoom/resize) or a new world arrives; terrain never changes mid-world.
//   • #dyn — objects, units, and the selection/target overlay. Rebuilt on every
//     snapshot (objects deplete, units move) and on view/selection changes.
// Both share one viewBox in tile-space, so zoom/pan are just viewBox math.
// Redraws are batched with requestAnimationFrame. Flat shapes now; swap in
// <image> sprites later without touching this file's structure.
import {
  BUILDINGS,
  BUILDING_IDS,
  RECIPES,
  RECIPE_IDS,
  TERRAIN_COLORS,
  isBuildable,
  isWalkable,
  tileAt,
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
import { buildingSvg, objectSvg, unitSvg } from './sprites';
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
}

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
      // 1.02 overlap matches the terrain rects so the veil has no seams.
      parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="1.02" height="1.02"/>`);
    }
  }
  return parts.join('');
}

function buildDyn(world: World, r: CullRange, selId: string | undefined): string {
  const parts: string[] = [];

  // Objects (mutable: they deplete as units work them).
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const tile = tileAt(world, x, y);
      if (tile?.object) parts.push(`<g transform="translate(${x} ${y})">${objectSvg(tile.object)}</g>`);
    }
  }

  // Buildings (placed structures; block movement).
  for (const id in world.buildings) {
    const b = world.buildings[id]!;
    if (b.pos.x < r.x0 || b.pos.x > r.x1 || b.pos.y < r.y0 || b.pos.y > r.y1) continue;
    parts.push(`<g transform="translate(${b.pos.x} ${b.pos.y})">${buildingSvg(b.type)}</g>`);
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

function updateInfo(info: HTMLElement): void {
  const id = selection.get().unitId;
  const pendingBuild = selection.get().pendingBuild;
  const world = game.get().world;
  const u = id && world ? world.units[id] : undefined;
  if (!u) {
    info.hidden = true;
    return;
  }
  info.hidden = false;

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
  const invHtml = inv.length
    ? inv.map(([k, v]) => `<span class="inv-item">${k} ${v}</span>`).join('')
    : `<span class="muted">empty</span>`;

  const toolsHtml = u.tools.length
    ? u.tools.map((t) => `<span class="inv-item tool">${RECIPES[t]?.label ?? t}</span>`).join('')
    : `<span class="muted">none</span>`;

  // A recipe/building button is enabled only if the unit can pay for it (and,
  // for tools, doesn't already own it). data-* attrs drive the delegated click.
  const craftBtns = RECIPE_IDS.map((rid) => {
    const rec = RECIPES[rid]!;
    const owned = u.tools.includes(rid);
    const afford = canAfford(u.inventory, rec.inputs);
    const dis = owned || !afford ? 'disabled' : '';
    const note = owned ? 'have it' : costLabel(rec.inputs);
    return `<button class="menu-btn" data-craft="${rid}" ${dis}>${rec.label}<span class="menu-cost">${note}</span></button>`;
  }).join('');

  const buildBtns = BUILDING_IDS.map((bid) => {
    const def = BUILDINGS[bid]!;
    const afford = canAfford(u.inventory, def.inputs);
    const active = pendingBuild === bid ? 'active' : '';
    const dis = afford ? '' : 'disabled';
    return `<button class="menu-btn ${active}" data-build="${bid}" ${dis}>${def.label}<span class="menu-cost">${costLabel(def.inputs)}</span></button>`;
  }).join('');

  const hint = pendingBuild
    ? `<div class="sel-hint">Click a tile to place <b>${BUILDINGS[pendingBuild]?.label ?? pendingBuild}</b> · Esc to cancel</div>`
    : '';

  info.innerHTML =
    `<div class="sel-head"><b>${u.id}</b> <span class="muted">(${u.pos.x}, ${u.pos.y})</span>` +
    ` <span class="sel-doing">${doing}</span></div>` +
    `<div class="sel-row"><span class="sel-label">Tools</span>${toolsHtml}</div>` +
    `<div class="sel-row"><span class="sel-label">Bag</span>${invHtml}</div>` +
    `<div class="menu-title">Craft</div><div class="menu-grid">${craftBtns}</div>` +
    `<div class="menu-title">Build</div><div class="menu-grid">${buildBtns}</div>` +
    hint;
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
  info.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-craft],[data-build]');
    if (!btn) return;
    const selId = selection.get().unitId;
    if (!selId) return;
    if (btn.dataset.craft) {
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
  if (tile?.object) {
    sendAction({ type: 'harvest', unitId: selId, target: { x, y } });
  } else if (isWalkable(world, x, y)) {
    sendAction({ type: 'move', unitId: selId, to: { x, y } });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
