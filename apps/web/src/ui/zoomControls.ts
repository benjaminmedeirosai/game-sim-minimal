import { camera, MIN_TILES_ACROSS } from '../state/game';
import {
  centerOnWorld,
  maxTilesAcross,
  setTilesAcross,
  viewportInfo,
  zoomInStep,
  zoomOutStep,
} from '../render/viewport';

const SLIDER_MAX = 1000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Zoom controls: − / slider / + and a Center button. The slider spans the full
 * zoom range (max zoom-out → max zoom-in). Because zoom is multiplicative, the
 * slider interpolates geometrically between maxTilesAcross (left) and
 * MIN_TILES_ACROSS (right), so equal drags feel like equal zoom steps.
 */
export function mountZoomControls(el: HTMLElement): void {
  el.classList.add('zoomctl');
  el.innerHTML = `
    <button class="icon-btn" id="zoom-out" title="Zoom out">−</button>
    <input type="range" class="zoom-slider" id="zoom-slider"
           min="0" max="${SLIDER_MAX}" value="${SLIDER_MAX / 2}" title="Zoom" />
    <button class="icon-btn" id="zoom-in" title="Zoom in">+</button>
    <button class="icon-btn" id="zoom-center" title="Center on map">⌖</button>`;

  const slider = el.querySelector<HTMLInputElement>('#zoom-slider')!;

  // slider fraction (0 = zoomed out, 1 = zoomed in) ⇄ tiles-across
  const fracToTiles = (f: number): number => {
    const maxA = maxTilesAcross();
    return maxA * Math.pow(MIN_TILES_ACROSS / maxA, f);
  };
  const tilesToFrac = (tiles: number): number => {
    const maxA = maxTilesAcross();
    if (maxA <= MIN_TILES_ACROSS) return 1;
    return clamp01(Math.log(tiles / maxA) / Math.log(MIN_TILES_ACROSS / maxA));
  };

  let dragging = false;
  slider.addEventListener('input', () => {
    dragging = true;
    setTilesAcross(fracToTiles(Number(slider.value) / SLIDER_MAX));
    dragging = false;
  });

  el.querySelector<HTMLButtonElement>('#zoom-in')!.addEventListener('click', zoomInStep);
  el.querySelector<HTMLButtonElement>('#zoom-out')!.addEventListener('click', zoomOutStep);
  el.querySelector<HTMLButtonElement>('#zoom-center')!.addEventListener('click', centerOnWorld);

  // Keep the slider in sync when zoom changes via wheel/buttons, and rescale
  // when the aspect/world changes the max (viewportInfo).
  const sync = (): void => {
    if (dragging) return;
    slider.value = String(Math.round(tilesToFrac(camera.get().tilesAcross) * SLIDER_MAX));
  };
  camera.subscribe(sync);
  viewportInfo.subscribe(sync);
}
