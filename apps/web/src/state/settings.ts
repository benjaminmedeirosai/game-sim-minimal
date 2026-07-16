import { Store } from '@game/shared';

// Client-only view/UX preferences (never sent to the host). Persisted to
// localStorage per our "small prefs in localStorage" rule.
export interface Settings {
  /** Wheel zoom sensitivity: applied as exp(deltaY * sensitivity), so it
   *  scales with how much the user actually scrolled (trackpad-friendly). */
  zoomSensitivity: number;
  /** Zoom toward the cursor instead of the screen center. */
  zoomToCursor: boolean;
  /** Width (px) of the opt-in left sidebar layout. */
  sidebarWidth: number;
}

export const ZOOM_SENS_MIN = 0.0003;
export const ZOOM_SENS_MAX = 0.004;

// The sidebar's default width and the range the setting allows: half the
// default at the low end, 50% more at the high end (per the design).
export const SIDEBAR_W_DEFAULT = 340;
export const SIDEBAR_W_MIN = Math.round(SIDEBAR_W_DEFAULT / 2); // 170
export const SIDEBAR_W_MAX = Math.round(SIDEBAR_W_DEFAULT * 1.5); // 510
export const SIDEBAR_W_STEP = 20;

const DEFAULTS: Settings = {
  zoomSensitivity: 0.0012,
  zoomToCursor: false,
  sidebarWidth: SIDEBAR_W_DEFAULT,
};
const KEY = 'gsm-settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore malformed/unavailable storage */
  }
  return { ...DEFAULTS };
}

export const settings = new Store<Settings>(load());

settings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
});
