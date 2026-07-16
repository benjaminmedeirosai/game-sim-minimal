// Centralized camera zoom, shared by wheel scrolling and the +/- buttons.
// Zoom factor < 1 zooms IN (fewer tiles across); > 1 zooms OUT.
import { Store } from '@game/shared';
import { camera, game, MAX_VISIBLE_TILES, MIN_TILES_ACROSS } from '../state/game';
import { settings } from '../state/settings';

let containerEl: HTMLElement | null = null;

/** Live, read-only view of the zoom cap — depends on window aspect ratio and
 *  the current world, so it's a store the Settings panel can display. */
export interface ViewportInfo {
  aspect: number;
  budget: number;
  maxTilesAcross: number;
  maxTilesDown: number;
}

export const viewportInfo = new Store<ViewportInfo>({
  aspect: 1,
  budget: MAX_VISIBLE_TILES,
  maxTilesAcross: 0,
  maxTilesDown: 0,
});

/** Recompute the published zoom-cap info. Call on resize and on world change. */
export function refreshViewportInfo(): void {
  const a = aspect();
  const across = maxTilesAcross();
  viewportInfo.set({
    aspect: a,
    budget: MAX_VISIBLE_TILES,
    maxTilesAcross: across,
    maxTilesDown: across / a,
  });
}

/** The world renderer registers its container so zoom can map cursor pixels
 *  to world coordinates. */
export function setViewportContainer(el: HTMLElement): void {
  containerEl = el;
  refreshViewportInfo();
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function aspect(): number {
  if (!containerEl) return 1;
  const r = containerEl.getBoundingClientRect();
  return (r.width || 1) / (r.height || 1);
}

/**
 * Largest allowed tiles-across (i.e. most zoomed-out). Bounded by two things:
 *  - the tile budget: keep width × height of the visible range under
 *    MAX_VISIBLE_TILES so redraws stay cheap on big worlds;
 *  - the world size: no point zooming past "whole world + small margin", which
 *    would just show dark void around a shrinking world.
 */
export function maxTilesAcross(): number {
  const a = aspect();
  const budgetCap = Math.sqrt(MAX_VISIBLE_TILES * a); // tilesAcross² / a ≤ budget
  const world = game.get().world;
  const fitCap = world ? Math.max(world.width, world.height * a) * 1.08 : budgetCap;
  return Math.max(MIN_TILES_ACROSS, Math.min(budgetCap, fitCap));
}

/** Clamp a tiles-across value into the currently allowed zoom range. */
export function clampTilesAcross(v: number): number {
  return clamp(v, MIN_TILES_ACROSS, maxTilesAcross());
}

/**
 * Apply a zoom factor. If a focus point (client px) is given AND the
 * zoom-toward-cursor setting is on, the world point under the cursor stays
 * fixed; otherwise the screen center stays fixed.
 */
export function applyZoom(factor: number, focusX?: number, focusY?: number): void {
  const cam = camera.get();
  const tilesAcross = clampTilesAcross(cam.tilesAcross * factor);

  const useCursor =
    containerEl != null && focusX != null && focusY != null && settings.get().zoomToCursor;

  if (!useCursor) {
    camera.set({ tilesAcross });
    return;
  }

  const rect = containerEl!.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  const aspect = w / h;

  const viewW = cam.tilesAcross;
  const viewH = viewW / aspect;
  const fracX = (focusX! - rect.left) / w;
  const fracY = (focusY! - rect.top) / h;

  // World point currently under the cursor.
  const worldX = cam.cx - viewW / 2 + fracX * viewW;
  const worldY = cam.cy - viewH / 2 + fracY * viewH;

  // Choose a new center that keeps that world point under the cursor.
  const newViewW = tilesAcross;
  const newViewH = tilesAcross / aspect;
  const cx = worldX + newViewW * (0.5 - fracX);
  const cy = worldY + newViewH * (0.5 - fracY);

  const world = game.get().world;
  camera.set({
    tilesAcross,
    cx: clamp(cx, 0, world?.width ?? cx),
    cy: clamp(cy, 0, world?.height ?? cy),
  });
}

/** Handle a wheel event: zoom proportional to scroll delta. */
export function wheelZoom(e: WheelEvent): void {
  const factor = Math.exp(e.deltaY * settings.get().zoomSensitivity);
  applyZoom(factor, e.clientX, e.clientY);
}

// Fixed steps for the +/- buttons (zoom toward center).
export const zoomInStep = (): void => applyZoom(1 / 1.2);
export const zoomOutStep = (): void => applyZoom(1.2);

/** Set an absolute zoom level (tiles across), clamped, toward center. Used by
 *  the zoom slider. */
export function setTilesAcross(tilesAcross: number): void {
  camera.set({ tilesAcross: clampTilesAcross(tilesAcross) });
}

/** Recenter the camera on the middle of the world (keeps current zoom). */
export function centerOnWorld(): void {
  const world = game.get().world;
  if (!world) return;
  camera.set({ cx: world.width / 2, cy: world.height / 2 });
}
