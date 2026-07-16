// Keyboard panning for the map: WASD (and arrow keys) slide the camera while
// held. Context-guarded — it only fires when the map is the active surface
// (see activeSurface) and focus isn't in a text field, so typing into the AI
// chat / command bar / settings never pans, and an open panel you haven't
// clicked away from keeps the keys inert until you click back onto the map.
import { camera, game } from '../state/game';
import { isMapActive } from '../state/activeSurface';

// key → unit direction (screen space; +y is down).
const KEYS: Record<string, [number, number]> = {
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0],
};

// Pan speed as a fraction of the viewport width per second, so it feels the
// same at every zoom level (~1.4s to cross the screen).
const PAN_FRAC_PER_SEC = 0.7;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function installMapKeys(): void {
  const held = new Set<string>();
  let raf = 0;
  let last = 0;

  const step = (dt: number): void => {
    const world = game.get().world;
    if (!world) return;
    let dx = 0;
    let dy = 0;
    for (const k of held) {
      const v = KEYS[k];
      if (v) { dx += v[0]; dy += v[1]; }
    }
    if (dx === 0 && dy === 0) return;
    const len = Math.hypot(dx, dy) || 1;
    const cam = camera.get();
    const move = cam.tilesAcross * PAN_FRAC_PER_SEC * dt;
    camera.set({
      cx: clamp(cam.cx + (dx / len) * move, 0, world.width),
      cy: clamp(cam.cy + (dy / len) * move, 0, world.height),
    });
  };

  const tick = (now: number): void => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    step(dt);
    if (held.size) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
    }
  };

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (!(k in KEYS)) return;
    if (isEditing() || !isMapActive()) return;
    e.preventDefault();
    if (!held.has(k)) {
      held.add(k);
      if (!raf) raf = requestAnimationFrame(tick);
    }
  });

  window.addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
  });

  // Tabbing away / losing focus mid-press would otherwise leave a key "stuck"
  // and the map drifting; clear everything when the window blurs.
  window.addEventListener('blur', () => held.clear());
}
