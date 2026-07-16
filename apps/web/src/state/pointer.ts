// The world tile currently under the mouse cursor (null when the pointer isn't
// over the map). Fed by the world renderer's pointermove and read by the topbar
// coordinate readout next to the camera-center coord.
import { Store } from '@game/shared';

export const pointerTile = new Store<{ tile: { x: number; y: number } | null }>({ tile: null });
