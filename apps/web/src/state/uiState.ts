import { Store } from '@game/shared';

// Which UI surfaces the player had open, mirrored to localStorage so a page
// reload drops them back where they left off (a common annoyance mid-task).
// Pure client view state — never sent to the host, per our "small prefs in
// localStorage" rule. The panel/sidebar bits restore on mount; the AI window
// and unit selection restore only once the world has loaded (they're only
// meaningful in-world), see app.ts.
export interface UiState {
  /** Open floating panel by name (room/hud/settings/controls), or null. At most
   *  one floats at a time — see app.ts togglePanel. */
  panel: string | null;
  /** Left-sidebar layout toggle (the ☰ Sidebar button → .layout-sidebar). */
  sidebar: boolean;
  /** AI History modal open. */
  ai: boolean;
  /** Last selected AI History tab, restored with the modal after reload. */
  aiTab: 'history' | 'memory' | 'config' | 'test';
  /** Preferred Test Details JSON formatting. */
  aiTestDetailPretty: boolean;
  /** Selected unit id, restored once the world (hence the unit) exists. */
  unitId: string | null;
}

const DEFAULTS: UiState = { panel: null, sidebar: false, ai: false, aiTab: 'history', aiTestDetailPretty: false, unitId: null };
const KEY = 'gsm-ui';

function load(): UiState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UiState>) };
  } catch {
    /* ignore malformed/unavailable storage */
  }
  return { ...DEFAULTS };
}

export const uiState = new Store<UiState>(load());

uiState.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
});

/** Patch a subset of the UI state (merges into the current value). */
export function setUi(patch: Partial<UiState>): void {
  uiState.set({ ...uiState.get(), ...patch });
}
