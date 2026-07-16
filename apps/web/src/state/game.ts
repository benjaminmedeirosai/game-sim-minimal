import { Store } from '@game/shared';
import type { TickStatsSnapshot, World } from '@game/shared';

// What the host tells us about the world + simulation.
export interface GameState {
  world?: World;
  stats?: TickStatsSnapshot;
  tick: number;
  speed: number;
}

export const game = new Store<GameState>({ tick: 0, speed: 1 });

// The camera is pure client-side view state (never sent to the host). Stored as
// a center point + how many tiles span the viewport horizontally, so zooming
// keeps the middle stable and panning is a simple center shift.
export interface Camera {
  cx: number;
  cy: number;
  tilesAcross: number;
}

export const camera = new Store<Camera>({ cx: 0, cy: 0, tilesAcross: 20 });

export const MIN_TILES_ACROSS = 4;

// Hard ceiling on tiles drawn at once (width × height of the visible range).
// The dynamic max-zoom in viewport.ts keeps us under this so a big world can't
// be zoomed out into a tab-choking redraw.
export const MAX_VISIBLE_TILES = 2800;
