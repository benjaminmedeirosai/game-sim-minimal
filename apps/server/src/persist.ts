// Durable single-slot autosave for the authoritative host. The whole session
// — world, AI history/chat, AI memory, and the action log — is written as one
// JSON file so a server restart RESUMES where it left off instead of reseeding
// a fresh world (which is what happens with no save present).
//
// Durability: we never write the live file in place. We write a sibling `.tmp`,
// fsync it to disk, then atomically rename it over the real save. On POSIX a
// rename within a directory is atomic, so a reader (or a crash mid-write) can
// only ever see the complete old file or the complete new one — never a
// half-written save.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionRecord, AiExchange, AiTestResult, CameraState, MemoryRevision, World } from '@game/shared';

// Bump when the SaveGame shape changes incompatibly; a mismatched save is
// ignored (we start fresh) rather than crashing the host on boot.
const SAVE_VERSION = 1;

/** The full persisted session. `world` is authoritative; the rest restores the
 *  AI's colony-level state so chat/history/memory survive a restart too. */
export interface SaveGame {
  version: number;
  /** Epoch ms the save was written (host-side; informational). */
  savedAt: number;
  world: World;
  /** Per-agent exchange log (the shared colony chat is derived from this). */
  aiHistory: Record<string, AiExchange[]>;
  /** Standing player preferences the orchestrator chose to keep. */
  aiMemory: string[];
  /** Append-only audit log of memory changes (model- or player-driven).
   *  Optional so pre-memory-log saves still load — the host defaults it to []. */
  aiMemoryLog?: MemoryRevision[];
  /** The active voice style id for the orchestrator's replies (or 'off').
   *  Optional so pre-voice saves still load — the host defaults it on resume. */
  aiVoice?: string;
  /** The model tag the orchestrator runs on. Optional so older saves load (and
   *  it's machine-specific) — applied on resume only if the daemon has it. */
  aiModel?: string;
  /** Shared, persisted Test Suite replay history. */
  aiTestResults?: AiTestResult[];
  /** Last host-issued AI request number. Never reset by clearing history. */
  aiRequestSeq?: number;
  /** Recent attributed actions for the Actions panel. */
  actionLog: ActionRecord[];
}

/** Everything a save needs except the envelope fields (version/savedAt), which
 *  `writeSave` stamps so callers can't disagree with the on-disk version. */
export type SavePayload = Omit<SaveGame, 'version' | 'savedAt'>;

// Resolved relative to THIS module (apps/server/src/persist.ts → apps/server/
// saves/autosave.json) so it doesn't depend on the process's cwd, and lands in
// the already-gitignored `saves/` dir. Overridable for tests / deployments.
const DEFAULT_SAVE_PATH = fileURLToPath(new URL('../saves/autosave.json', import.meta.url));
const SAVE_PATH = process.env.GSM_SAVE_PATH ?? DEFAULT_SAVE_PATH;

/** Load the autosave, or null when there is none / it is unreadable / it is an
 *  incompatible version. Never throws — a bad save must not stop the host from
 *  booting; it just starts a fresh world. */
export function loadSave(): SaveGame | null {
  if (!existsSync(SAVE_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SAVE_PATH, 'utf8')) as SaveGame;
    if (data?.version !== SAVE_VERSION || !data.world) {
      console.warn(`[save] ignoring incompatible save (version ${data?.version}); starting fresh`);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[save] could not read save, starting fresh:', (err as Error).message);
    return null;
  }
}

/** Write the session durably: full serialize → temp file → fsync → atomic
 *  rename over the live save. Throws on I/O failure so the caller can log and
 *  keep the "dirty" flag set for the next attempt. */
export function writeSave(payload: SavePayload): void {
  const save: SaveGame = { version: SAVE_VERSION, savedAt: Date.now(), ...payload };
  const json = JSON.stringify(save);
  const tmp = `${SAVE_PATH}.tmp`;
  mkdirSync(dirname(SAVE_PATH), { recursive: true });
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, json);
    fsyncSync(fd); // force bytes to disk before we swap the file in
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, SAVE_PATH); // atomic swap: readers see old-or-new, never partial
}

/** The resolved autosave path (for logging / status). */
export function savePath(): string {
  return SAVE_PATH;
}

// --- Accounts sidecar ----------------------------------------------------
// Player accounts live in their OWN file, deliberately separate from the world
// save: they must survive a "New World" (accounts aren't world state), and they
// hold credentials (device-token hashes) that must never ride in the world
// snapshot broadcast to clients. Same durable write pattern as the game save.

const ACCOUNTS_VERSION = 1;

/** One player account. Identity is device-token based (no password): `keys` is
 *  the set of SHA-256 hashes of every enrolled device's token. `allowOthers`
 *  gates whether a new device may enroll (see the `hello` protocol note). */
export interface AccountRecord {
  /** The name as last entered (display casing); the map key is normalized. */
  displayName: string;
  /** SHA-256 hex of each enrolled device token. */
  keys: string[];
  /** Whether an un-enrolled device using this name may enroll + connect. */
  allowOthers: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** The account's last camera (world-scoped, timestamped) for cross-device
   *  restore. Absent until the player has moved their camera at least once. */
  lastCamera?: CameraState;
}

/** The accounts file: a map of normalized-name → account. */
export interface AccountsFile {
  version: number;
  savedAt: number;
  accounts: Record<string, AccountRecord>;
}

const DEFAULT_ACCOUNTS_PATH = fileURLToPath(new URL('../saves/accounts.json', import.meta.url));
const ACCOUNTS_PATH = process.env.GSM_ACCOUNTS_PATH ?? DEFAULT_ACCOUNTS_PATH;

/** Load the accounts registry, or an empty map when absent/unreadable/stale.
 *  Never throws — a bad accounts file must not stop the host from booting. */
export function loadAccounts(): Record<string, AccountRecord> {
  if (!existsSync(ACCOUNTS_PATH)) return {};
  try {
    const data = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) as AccountsFile;
    if (data?.version !== ACCOUNTS_VERSION || typeof data.accounts !== 'object') {
      console.warn(`[accounts] ignoring incompatible file (version ${data?.version})`);
      return {};
    }
    return data.accounts;
  } catch (err) {
    console.error('[accounts] could not read, starting empty:', (err as Error).message);
    return {};
  }
}

/** Write the accounts registry durably (temp → fsync → atomic rename), same as
 *  the game save. Throws on I/O failure so the caller can retry. */
export function writeAccounts(accounts: Record<string, AccountRecord>): void {
  const file: AccountsFile = { version: ACCOUNTS_VERSION, savedAt: Date.now(), accounts };
  const json = JSON.stringify(file);
  const tmp = `${ACCOUNTS_PATH}.tmp`;
  mkdirSync(dirname(ACCOUNTS_PATH), { recursive: true });
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, ACCOUNTS_PATH);
}

/** The resolved accounts path (for logging / status). */
export function accountsPath(): string {
  return ACCOUNTS_PATH;
}
