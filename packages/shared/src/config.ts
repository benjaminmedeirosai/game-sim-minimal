// Shared, environment-agnostic constants.

// The whole game lives in ONE room. The host (Node server) claims this exact
// PeerJS id on the public broker; clients connect to it. It must be
// unguessable + namespaced so we don't collide with other apps on the shared
// public broker. Change this to run an isolated instance.
export const ROOM_ID = 'gsm-room-7f3a9c2e1b4d';

// Authoritative simulation base rate. Effective rate = BASE_TPS * speedMultiplier.
export const BASE_TPS = 6;

// Ticks a fully-unencumbered unit takes to walk one tile — its base movement
// cadence. Encumbrance stretches this (see stats.ts speedMult). Shared so the
// sim (which spends the ticks) and the UI (which shows tiles/s) agree.
export const UNIT_STEP_TICKS = 2;

// How often the host pushes perf stats to clients (ms). Decoupled from ticks.
export const STATS_INTERVAL_MS = 1000;
