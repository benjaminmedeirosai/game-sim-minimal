import {
  PAN_SPEED_MAX,
  PAN_SPEED_MIN,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
  SIDEBAR_W_STEP,
  settings,
  ZOOM_SENS_MAX,
  ZOOM_SENS_MIN,
} from '../state/settings';
import { viewportInfo } from '../render/viewport';

/** Client-side view/UX settings panel. */
export function mountSettings(el: HTMLElement): void {
  const s = settings.get();
  el.innerHTML = `
    <h2>Settings</h2>
    <div class="form">
      <label>Zoom speed
        <input type="range" name="zoomSensitivity"
               min="${ZOOM_SENS_MIN}" max="${ZOOM_SENS_MAX}" step="0.0001"
               value="${s.zoomSensitivity}" />
        <span class="range-ends"><span>Gentle</span><span>Fast</span></span>
      </label>
      <label class="check">
        <input type="checkbox" name="zoomToCursor" ${s.zoomToCursor ? 'checked' : ''} />
        Zoom toward cursor
      </label>
      <p class="hint">Off = zoom keeps the screen center fixed.</p>

      <label>Keyboard pan speed
        <input type="range" name="panSpeed"
               min="${PAN_SPEED_MIN}" max="${PAN_SPEED_MAX}" step="0.1"
               value="${s.panSpeed}" />
        <span class="range-ends"><span>Gentle</span><span>Fast</span></span>
      </label>
      <p class="hint">How fast WASD / arrow keys slide the map.</p>

      <label>Sidebar width <span class="range-val" id="sbw-val">${s.sidebarWidth}px</span>
        <span class="stepper">
          <button type="button" class="icon-btn" id="sbw-minus" title="Narrower">−</button>
          <input type="range" name="sidebarWidth"
                 min="${SIDEBAR_W_MIN}" max="${SIDEBAR_W_MAX}" step="1"
                 value="${s.sidebarWidth}" />
          <button type="button" class="icon-btn" id="sbw-plus" title="Wider">+</button>
        </span>
      </label>
      <p class="hint">Width of the ☰ Sidebar layout (${SIDEBAR_W_MIN}–${SIDEBAR_W_MAX}px).</p>
    </div>

    <h2 class="mt">Zoom limit</h2>
    <div class="hud-grid" id="zoom-limit"></div>
    <p class="hint">Read-only. Max zoom-out is capped to keep tiles drawn within
      the budget; the result depends on the window's aspect ratio.</p>`;

  const sens = el.querySelector<HTMLInputElement>('input[name="zoomSensitivity"]')!;
  sens.addEventListener('input', () => {
    settings.set({ zoomSensitivity: Number(sens.value) });
  });

  const cursor = el.querySelector<HTMLInputElement>('input[name="zoomToCursor"]')!;
  cursor.addEventListener('change', () => {
    settings.set({ zoomToCursor: cursor.checked });
  });

  const pan = el.querySelector<HTMLInputElement>('input[name="panSpeed"]')!;
  pan.addEventListener('input', () => {
    settings.set({ panSpeed: Number(pan.value) });
  });

  // Sidebar width: − / slider / +. Buttons nudge by a step; all three clamp to
  // the allowed range and write through the same setter.
  const sbw = el.querySelector<HTMLInputElement>('input[name="sidebarWidth"]')!;
  const sbwVal = el.querySelector<HTMLElement>('#sbw-val')!;
  const applyWidth = (px: number): void => {
    const w = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(px)));
    sbw.value = String(w);
    sbwVal.textContent = `${w}px`;
    settings.set({ sidebarWidth: w });
  };
  sbw.addEventListener('input', () => applyWidth(Number(sbw.value)));
  el.querySelector<HTMLButtonElement>('#sbw-minus')!.addEventListener('click', () =>
    applyWidth(settings.get().sidebarWidth - SIDEBAR_W_STEP),
  );
  el.querySelector<HTMLButtonElement>('#sbw-plus')!.addEventListener('click', () =>
    applyWidth(settings.get().sidebarWidth + SIDEBAR_W_STEP),
  );

  const limitEl = el.querySelector<HTMLElement>('#zoom-limit')!;
  viewportInfo.subscribe((vi) => {
    const across = Math.round(vi.maxTilesAcross);
    const down = Math.round(vi.maxTilesDown);
    limitEl.innerHTML = `
      <div class="hud-k">tile budget</div><div class="hud-v">${vi.budget.toLocaleString()}</div>
      <div class="hud-k">aspect</div><div class="hud-v">${vi.aspect.toFixed(2)}</div>
      <div class="hud-k">max zoom</div><div class="hud-v">${across} × ${down} tiles</div>
      <div class="hud-k">drawn at max</div><div class="hud-v">${(across * down).toLocaleString()} tiles</div>`;
  });
}
