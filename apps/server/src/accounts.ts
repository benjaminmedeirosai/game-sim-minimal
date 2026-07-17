// The player identity registry. Identity is device-token based — no passwords:
// each browser mints a random token (kept in its localStorage) and that token IS
// the player. The host only ever stores SHA-256 hashes of tokens, so a leaked
// accounts.json can't be used to impersonate anyone.
//
// An account can enroll MULTIPLE devices. The `allowOthers` flag is the
// enrollment window: while it's on, a connection using the account's name from a
// not-yet-known device is accepted and its token remembered; while it's off,
// only already-enrolled devices connect (but all of them still do). Typical use:
// flip it on, connect your other device once, flip it off.
//
// Exactly one session per account may be live at a time. A new login from an
// already-enrolled device supersedes (kicks) the old session rather than being
// refused, so a reconnect after a network blip — or moving to another tab —
// just works. A login from an UN-enrolled device while the window is closed is
// refused outright ("name taken").
import { createHash } from 'node:crypto';
import type { CameraState } from '@game/shared';
import type { AccountRecord } from './persist.js';
import { loadAccounts, writeAccounts } from './persist.js';

/** Result of an authentication attempt. On success, `takeover` names the peer
 *  whose live session this login supersedes (if any) so the caller can drop it. */
export type AuthResult =
  | { ok: true; account: AccountRecord; nameKey: string; takeover?: string }
  | { ok: false; reason: string };

// Names players can't take (the host itself uses "AI Server" / the orchestrator
// speaks as "AI"), compared against the normalized key.
const RESERVED = new Set(['ai', 'ai server', 'host', 'server', 'system']);

const NAME_MAX = 24;
// Letters, numbers, spaces, and a few separators — enough for real handles
// without opening the door to control chars / markup in a name.
const NAME_OK = /^[\p{L}\p{N} _.-]+$/u;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Fold a raw name to its uniqueness key: trimmed, inner whitespace collapsed,
 *  lowercased. Two names that differ only by case/spacing are the same account. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class Accounts {
  private accounts: Record<string, AccountRecord>;
  // Live sessions: normalized name → the peerId currently holding it.
  private live = new Map<string, string>();
  // Reverse index so a disconnect (which only knows the peerId) can find its
  // account for release + camera attribution.
  private byPeer = new Map<string, string>();
  private dirty = false;

  constructor() {
    this.accounts = loadAccounts();
  }

  /** Validate + authenticate a join. Creates the account on first use, enrolls a
   *  new device when the window is open, and enforces one live session (kicking
   *  the previous one). Marks the account live under `peerId` on success. */
  authenticate(rawName: string, token: string | undefined, allowOthers: boolean, peerId: string): AuthResult {
    const name = (rawName ?? '').trim();
    if (!name) return { ok: false, reason: 'Please enter a name.' };
    if (name.length > NAME_MAX) return { ok: false, reason: `Name must be ${NAME_MAX} characters or fewer.` };
    if (!NAME_OK.test(name)) return { ok: false, reason: 'Name has invalid characters.' };
    const nameKey = normalizeName(name);
    if (RESERVED.has(nameKey)) return { ok: false, reason: 'That name is reserved.' };
    if (!token) return { ok: false, reason: 'This browser has no device key; reload and try again.' };

    const h = hashToken(token);
    const now = Date.now();
    let account = this.accounts[nameKey];

    if (!account) {
      // Brand-new name: claim it, bound to this device.
      account = { displayName: name, keys: [h], allowOthers, createdAt: now, lastUsedAt: now };
      this.accounts[nameKey] = account;
    } else {
      const known = account.keys.includes(h);
      if (!known) {
        if (!account.allowOthers) return { ok: false, reason: 'That name is taken.' };
        account.keys.push(h); // enrollment window is open — remember this device
      }
      // An owner (enrolled, or just enrolled) may update the flag + display casing.
      account.allowOthers = allowOthers;
      account.displayName = name;
    }
    account.lastUsedAt = now;

    // One live session per account: a new login supersedes any current one.
    const current = this.live.get(nameKey);
    const takeover = current && current !== peerId ? current : undefined;
    this.live.set(nameKey, peerId);
    this.byPeer.set(peerId, nameKey);
    this.dirty = true;
    return { ok: true, account, nameKey, takeover };
  }

  /** Release a peer's live session (on disconnect). Idempotent, and a no-op if
   *  the session was already superseded by a takeover (the slot now points at
   *  the newer peer, which we must not clear). */
  release(peerId: string): void {
    const nameKey = this.byPeer.get(peerId);
    this.byPeer.delete(peerId);
    if (nameKey && this.live.get(nameKey) === peerId) this.live.delete(nameKey);
  }

  /** Save a peer's latest camera to its account (world-scoped + timestamped),
   *  for cross-device restore. No-op if the peer isn't a known live session. */
  updateCamera(peerId: string, cam: CameraState): void {
    const nameKey = this.byPeer.get(peerId);
    if (!nameKey) return;
    const account = this.accounts[nameKey];
    if (!account) return;
    account.lastCamera = cam;
    this.dirty = true;
  }

  /** The account's saved camera, by normalized name (for the welcome reply). */
  cameraFor(nameKey: string): CameraState | undefined {
    return this.accounts[nameKey]?.lastCamera;
  }

  /** Persist the registry if it changed since the last write. Never throws — a
   *  failed write logs and leaves the dirty flag set for the next attempt. */
  flush(): void {
    if (!this.dirty) return;
    try {
      writeAccounts(this.accounts);
      this.dirty = false;
    } catch (err) {
      console.error('[accounts] write failed:', (err as Error).message);
    }
  }
}
