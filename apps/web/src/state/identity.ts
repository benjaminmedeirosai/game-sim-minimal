// Client-side player identity, all in localStorage (never leaves this browser
// except the token, which is sent in the join handshake as the login secret).
//
//  - deviceToken: a random per-browser secret minted once. It IS the login — the
//    host stores only its hash and recognizes this device by it. No password.
//  - name / allowOthers: the last values the player used on the join screen, so
//    the form is prefilled and reconnects reuse them.
//  - lastCamera: this browser's last camera (world-scoped + timestamped) so we
//    can restore it on load, or defer to the host's copy when the host's is newer.
import type { CameraState } from '@game/shared';

const TOKEN_KEY = 'gsm.deviceToken';
const NAME_KEY = 'gsm.userName';
const ALLOW_KEY = 'gsm.allowOthers';
const CAMERA_KEY = 'gsm.lastCamera';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable/full — identity just won't persist this session */
  }
}

/** This browser's device token, minting + persisting one on first use. Requires
 *  a secure context or localhost for crypto.randomUUID (both true here). */
export function deviceToken(): string {
  let t = read(TOKEN_KEY);
  if (!t) {
    t = crypto.randomUUID();
    write(TOKEN_KEY, t);
  }
  return t;
}

export function savedName(): string {
  return read(NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  write(NAME_KEY, name);
}

export function savedAllowOthers(): boolean {
  return read(ALLOW_KEY) === '1';
}

export function saveAllowOthers(allow: boolean): void {
  write(ALLOW_KEY, allow ? '1' : '0');
}

export function savedCamera(): CameraState | null {
  const raw = read(CAMERA_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as CameraState;
    if (typeof c?.worldId === 'string' && Number.isFinite(c.cx) && Number.isFinite(c.cy)) return c;
  } catch {
    /* ignore malformed */
  }
  return null;
}

export function saveCamera(cam: CameraState): void {
  write(CAMERA_KEY, JSON.stringify(cam));
}
