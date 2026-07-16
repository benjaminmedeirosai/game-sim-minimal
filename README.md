# game-sim-minimal

A real-time board/colony simulation played over a PeerJS mesh, with an
always-on Node host that also runs an Ollama-backed AI command parser.

## Architecture (see the full plan in chat)

- **`packages/shared`** — types, the `Action` schema (UI + AI emit the same
  actions), the pure simulation, the wire protocol, and a tiny reactive store.
  Consumed as source by both the web app and the server (no build step).
- **`apps/server`** — the always-on host. Claims the room id on the PeerJS
  broker, is the authoritative simulator, runs the AI orchestrator, and owns
  saves. Connects to the mesh over WebRTC via `@roamhq/wrtc`.
- **`apps/web`** — the browser client (Vanilla TS + Vite). Always a client:
  sends intents, renders the host's snapshots.

## Run it

```bash
npm install

# terminal 1 — the host
npm run dev:server

# terminal 2 — the web client
npm run dev:web        # open http://localhost:5173

# or both at once
npm run dev
```

Open the web app in two tabs: both appear in each other's room list, with the
server shown as **HOST** / **ai-orchestrator**.

## Milestones

- **M0 (this) — scaffold + mesh**: host claims room, clients connect, lobby
  shows the roster + roles.
- M1 — world generation, authoritative tick loop + perf stats, SVG rendering.
- M2 — the `Action` spine: units, chopping/mining/gathering over ticks.
- M3 — buildings, tools, crafting, resource costs.
- M4 — AI orchestrator (Ollama), cache-aware prompt ordering.
- M5 — server-side saves + home screen.
