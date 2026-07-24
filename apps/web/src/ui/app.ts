import { toCellXY } from '@game/shared';
import { net } from '../net/client';
import { camera, game } from '../state/game';
import { refreshViewportInfo } from '../render/viewport';
import { mountWorld } from '../render/world';
import { mountZoomControls } from './zoomControls';
import { mountRoom } from './lobby';
import { mountNewWorld } from './newWorld';
import { mountSpeed } from './speed';
import { mountHud } from './hud';
import { mountSettings } from './settings';
import { mountControls } from './controls';
import { mountCommandBar } from './commandBar';
import { mountAiHistory } from './aiHistory';
import { mountSidebar } from './sidebar';
import { closeLayer, installEscStack, openLayer } from './escStack';
import { mountConnGate } from './connGate';
import { installMapKeys } from './mapKeys';
import { setActive } from '../state/activeSurface';
import { pointerTile } from '../state/pointer';
import { settings } from '../state/settings';
import { startClientPerf } from '../state/clientPerf';
import { selection } from '../state/selection';
import { uiState, setUi } from '../state/uiState';

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <button class="brand-toggle" data-layout type="button" title="Toggle the left sidebar (AI chat + actions)" aria-label="Toggle the left sidebar" aria-expanded="false">
          <img class="brand-icon" src="/favicon.svg" alt="" />
        </button>
        <span class="brand">game-sim-minimal</span>
        <span class="spacer"></span>
        <div class="topbar-actions">
          <button class="btn btn-ghost" data-panel="new" title="New World is disabled for now" disabled>New World</button>
          <button class="btn btn-ghost" data-panel="room" title="Room: connected players & host">Room <span id="peer-count" class="count">0</span></button>
          <button class="btn btn-ghost" data-ai title="AI history &amp; prompt config">AI</button>
          <button class="btn btn-ghost" data-panel="hud" title="Performance stats (server + this client)">Perf</button>
          <button class="btn btn-ghost" data-panel="settings" title="Settings (zoom, pan speed, sidebar width, …)">Settings</button>
          <button class="btn btn-ghost" data-panel="controls" title="Controls &amp; hotkeys reference">Controls</button>
        </div>
        <div class="controls">
          <div id="speed" class="speed"></div>
          <div id="zoomctl"></div>
          <span class="coord-badge" id="coord-badge" title="Camera center cell (column-row, e.g. AF29)"></span>
          <span class="coord-badge coord-mouse" id="mouse-badge" title="Cell under the cursor (column-row, e.g. AF29)"></span>
        </div>
      </header>
      <div class="stage">
        <aside class="sidebar" id="sidebar"></aside>
        <main id="world" class="world"></main>
        <aside class="panel-side panel-hud" data-name="hud" hidden></aside>
        <aside class="panel-side" data-name="settings" hidden></aside>
        <aside class="panel-side panel-controls" data-name="controls" hidden></aside>
        <aside class="panel-side" data-name="room" hidden></aside>
      </div>
      <aside class="panel-float" data-name="new" hidden></aside>
      <div class="conn-gate" id="conn-gate"></div>
    </div>`;

  // Snapshot the persisted UI state BEFORE we wire the live persist listeners
  // below (those fire immediately on subscribe and would overwrite it). Restore
  // reads from this snapshot; every later change flows back to localStorage.
  const savedUi = uiState.get();

  const worldEl = root.querySelector<HTMLElement>('#world')!;
  const panels = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-name]').forEach((p) => {
    panels.set(p.dataset.name!, p);
  });

  const togglePanel = (name: string): void => {
    for (const [n, p] of panels) {
      const wasOpen = !p.hidden;
      p.hidden = n === name ? !p.hidden : true;
      if (wasOpen && p.hidden) p.dispatchEvent(new Event('panelclose'));
    }
    refreshViewportInfo(); // a docked right panel changes the map's width
    // Re-render the settings form each time it opens so it reflects the world.
    if (name === 'new' && !panels.get('new')!.hidden) {
      mountNewWorld(panels.get('new')!, () => togglePanel('new'));
    }
    // Sync the Esc stack: at most one floating panel is open at a time, so it's
    // a single 'panel' layer that Esc closes before falling through to a unit.
    const open = [...panels].find(([, p]) => !p.hidden);
    setUi({ panel: open ? open[0] : null }); // survive reload
    if (open) {
      // Dynamic floating panels subscribe to live stores, but only paint while
      // visible. Notify the newly-open panel to catch up with the latest state.
      open[1].dispatchEvent(new Event('panelopen'));
      openLayer('panel', () => {
        open[1].hidden = true;
        open[1].dispatchEvent(new Event('panelclose'));
        refreshViewportInfo();
        closeLayer('panel');
        setActive('map');
      });
      setActive(`panel:${open[0]}`); // an open panel owns the keyboard until you click away
    } else {
      closeLayer('panel');
      setActive('map');
    }
  };

  root.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => togglePanel(btn.dataset.panel!));
  });

  mountWorld(worldEl);
  mountCommandBar(worldEl);
  mountSpeed(root.querySelector<HTMLElement>('#speed')!);
  mountRoom(panels.get('room')!);
  mountHud(panels.get('hud')!);
  mountSettings(panels.get('settings')!);
  const controls = mountControls(panels.get('controls')!);
  window.addEventListener('game:show-action-doc', (event) => {
    const type = (event as CustomEvent<string>).detail;
    if (!type) return;
    // This is a navigation request, not a toolbar toggle. Leave Controls open
    // when the player clicks a second action in the feed.
    if (panels.get('controls')!.hidden) togglePanel('controls');
    requestAnimationFrame(() => controls.showAction(type));
  });
  const sidebarEl = root.querySelector<HTMLElement>('#sidebar')!;
  mountSidebar(sidebarEl);
  mountZoomControls(root.querySelector<HTMLElement>('#zoomctl')!);

  // Interacting with the sidebar takes keyboard focus away from the map, so
  // WASD panning pauses while you're reading/typing there.
  sidebarEl.addEventListener('pointerdown', () => setActive('sidebar'));

  // Left-sidebar layout is an opt-in alternative to the floating panels; toggle
  // adds/removes the class on .app. The floating cards/command bar are untouched.
  const app = root.querySelector<HTMLElement>('.app')!;
  // Restore the sidebar layout before settings.subscribe (below) reads the class
  // to decide whether to recompute the zoom cap.
  if (savedUi.sidebar) app.classList.add('layout-sidebar');
  const layoutToggle = root.querySelector<HTMLButtonElement>('[data-layout]')!;
  const syncLayoutToggle = (): void => layoutToggle.setAttribute('aria-expanded', String(app.classList.contains('layout-sidebar')));
  syncLayoutToggle();
  layoutToggle.addEventListener('click', () => {
    const on = app.classList.toggle('layout-sidebar');
    syncLayoutToggle();
    setUi({ sidebar: on }); // survive reload
    refreshViewportInfo(); // world width changed; recompute zoom cap
  });

  // Drive the sidebar's width from the client setting (CSS var the layout reads),
  // recomputing the zoom cap when it changes while the sidebar is showing.
  settings.subscribe((s) => {
    app.style.setProperty('--sidebar-w', `${s.sidebarWidth}px`);
    if (app.classList.contains('layout-sidebar')) refreshViewportInfo();
  });

  // One Escape owner for every dismissible layer; WASD/arrow map panning;
  // client-perf sampling loop.
  installEscStack();
  installMapKeys();
  startClientPerf();

  // Full-screen connection gate / landing page shown until a host answers.
  mountConnGate(root.querySelector<HTMLElement>('#conn-gate')!);

  // The AI History window is a full-screen modal, not a side panel.
  const aiWindow = mountAiHistory(root);
  root.querySelector<HTMLButtonElement>('[data-ai]')!.addEventListener('click', () => aiWindow.toggle());

  // --- Restore UI state across reloads -----------------------------------
  // Reopen the floating panel the player left open (skip 'new' — it's disabled).
  if (savedUi.panel && savedUi.panel !== 'new' && panels.has(savedUi.panel)) {
    togglePanel(savedUi.panel);
  }
  // Mirror unit selection to storage so it too survives a reload.
  selection.subscribe(() => setUi({ unitId: selection.get().unitId ?? null }));
  // The AI window and unit selection only mean something in-world, so restore
  // them the first time a world is present (on reload that's when the host's
  // snapshot lands; if a world is already up, this fires immediately). One-shot.
  let restoredInWorld = false;
  game.subscribe(() => {
    if (restoredInWorld || !game.get().world) return;
    restoredInWorld = true;
    if (savedUi.unitId) selection.set({ unitId: savedUi.unitId });
    if (savedUi.ai) aiWindow.toggle();
  });

  // Topbar live bits: peer count + tick.
  const peerCount = root.querySelector<HTMLElement>('#peer-count')!;
  net.subscribe((s) => {
    peerCount.textContent = String(s.roster.length);
  });
  // Live camera-center tile coordinate.
  const coordBadge = root.querySelector<HTMLElement>('#coord-badge')!;
  const syncCoord = (): void => {
    const c = camera.get();
    coordBadge.textContent = game.get().world ? `◎ ${toCellXY(c.cx, c.cy)}` : '';
  };
  camera.subscribe(syncCoord);

  // Live tile under the mouse cursor (blank when off the map).
  const mouseBadge = root.querySelector<HTMLElement>('#mouse-badge')!;
  pointerTile.subscribe((p) => {
    mouseBadge.textContent = p.tile ? `↖ ${toCellXY(p.tile.x, p.tile.y)}` : '';
  });

  // No auto-connect: the connection gate shows the join form (name + world +
  // "play from other computers") and calls connect() when the player submits.
}
