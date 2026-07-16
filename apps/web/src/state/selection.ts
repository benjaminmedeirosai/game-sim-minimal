import { Store } from '@game/shared';

// Which unit the player has selected. Pure client-side view state — never sent
// to the host. The click-a-unit-then-click-a-target flow reads/writes this.
export interface SelectionState {
  unitId?: string;
  /** When set, the next world click sites this building type (placement mode)
   *  instead of moving/harvesting. Cleared after placing or pressing Esc. */
  pendingBuild?: string;
}

export const selection = new Store<SelectionState>({});
