// Which surface currently owns keyboard/gesture "focus". This is deliberately
// distinct from what's merely visible: opening the Perf panel makes it active,
// but clicking back onto the map makes the MAP active again even while Perf
// stays open. Map-only hotkeys (WASD/arrow panning) check isMapActive(), so an
// open-but-not-interacted overlay never blocks them.
//
// The map is the default. Clicking the world sets 'map'; opening or clicking a
// panel/modal/sidebar sets that surface instead.
import { Store } from '@game/shared';

export const activeSurface = new Store<{ id: string }>({ id: 'map' });

export function setActive(id: string): void {
  if (activeSurface.get().id !== id) activeSurface.set({ id });
}

export const isMapActive = (): boolean => activeSurface.get().id === 'map';
