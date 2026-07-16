import { connect, net } from '../net/client';
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

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <span class="brand">game-sim-minimal</span>
        <span class="spacer"></span>
        <div class="topbar-actions">
          <button class="btn btn-ghost" data-panel="new" title="Create a new world">New World</button>
          <button class="btn btn-ghost" data-panel="room" title="Room: connected players & host">Room <span id="peer-count" class="count">0</span></button>
          <button class="btn btn-ghost" data-ai title="AI history &amp; prompt config">AI</button>
          <button class="btn btn-ghost" data-panel="hud" title="Performance stats (server + this client)">Perf</button>
          <button class="btn btn-ghost" data-panel="settings" title="Settings (zoom, pan speed, sidebar width, …)">Settings</button>
          <button class="btn btn-ghost" data-panel="controls" title="Controls &amp; hotkeys reference">Controls</button>
          <button class="btn btn-ghost" data-layout title="Toggle the left sidebar (AI chat + actions)">☰ Sidebar</button>
        </div>
        <div class="controls">
          <div id="speed" class="speed"></div>
          <div id="zoomctl"></div>
          <span class="coord-badge" id="coord-badge" title="Camera center tile (x, y)"></span>
          <span class="coord-badge coord-mouse" id="mouse-badge" title="Tile under the cursor (x, y)"></span>
        </div>
      </header>
      <div class="stage">
        <aside class="sidebar" id="sidebar"></aside>
        <main id="world" class="world"></main>
      </div>
      <aside class="panel-float" data-name="new" hidden></aside>
      <aside class="panel-float" data-name="room" hidden></aside>
      <aside class="panel-float panel-hud" data-name="hud" hidden></aside>
      <aside class="panel-float" data-name="settings" hidden></aside>
      <aside class="panel-float" data-name="controls" hidden></aside>
      <div class="conn-gate" id="conn-gate"></div>
    </div>`;

  const worldEl = root.querySelector<HTMLElement>('#world')!;
  const panels = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('.panel-float').forEach((p) => {
    panels.set(p.dataset.name!, p);
  });

  const togglePanel = (name: string): void => {
    for (const [n, p] of panels) {
      p.hidden = n === name ? !p.hidden : true;
    }
    // Re-render the settings form each time it opens so it reflects the world.
    if (name === 'new' && !panels.get('new')!.hidden) {
      mountNewWorld(panels.get('new')!, () => togglePanel('new'));
    }
    // Sync the Esc stack: at most one floating panel is open at a time, so it's
    // a single 'panel' layer that Esc closes before falling through to a unit.
    const open = [...panels].find(([, p]) => !p.hidden);
    if (open) {
      openLayer('panel', () => {
        open[1].hidden = true;
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
  mountControls(panels.get('controls')!);
  const sidebarEl = root.querySelector<HTMLElement>('#sidebar')!;
  mountSidebar(sidebarEl);
  mountZoomControls(root.querySelector<HTMLElement>('#zoomctl')!);

  // Interacting with the sidebar takes keyboard focus away from the map, so
  // WASD panning pauses while you're reading/typing there.
  sidebarEl.addEventListener('pointerdown', () => setActive('sidebar'));

  // Left-sidebar layout is an opt-in alternative to the floating panels; toggle
  // adds/removes the class on .app. The floating cards/command bar are untouched.
  const app = root.querySelector<HTMLElement>('.app')!;
  root.querySelector<HTMLButtonElement>('[data-layout]')!.addEventListener('click', () => {
    app.classList.toggle('layout-sidebar');
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

  // Topbar live bits: peer count + tick.
  const peerCount = root.querySelector<HTMLElement>('#peer-count')!;
  net.subscribe((s) => {
    peerCount.textContent = String(s.roster.length);
  });
  // Live camera-center tile coordinate.
  const coordBadge = root.querySelector<HTMLElement>('#coord-badge')!;
  const syncCoord = (): void => {
    const c = camera.get();
    coordBadge.textContent = game.get().world
      ? `◎ ${Math.floor(c.cx)}, ${Math.floor(c.cy)}`
      : '';
  };
  camera.subscribe(syncCoord);
  game.subscribe(syncCoord);

  // Live tile under the mouse cursor (blank when off the map).
  const mouseBadge = root.querySelector<HTMLElement>('#mouse-badge')!;
  pointerTile.subscribe((p) => {
    mouseBadge.textContent = p.tile ? `↖ ${p.tile.x}, ${p.tile.y}` : '';
  });

  const name = `Player-${Math.floor(Math.random() * 1000)}`;
  connect(name);
}
