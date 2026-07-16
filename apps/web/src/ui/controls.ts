// A static reference card for the game's controls / hotkeys. Lives in a
// floating panel so it can be left open beside the map while you play —
// clicking the map re-arms the keyboard without closing this.
interface Row {
  keys: string[]; // rendered as <kbd> chips (joined visually)
  desc: string;
}

function section(title: string, rows: Row[]): string {
  const body = rows
    .map(
      (r) =>
        `<div class="ctl-keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</div>` +
        `<div class="ctl-desc">${r.desc}</div>`,
    )
    .join('');
  return `<h2 class="mt">${title}</h2><div class="ctl-grid">${body}</div>`;
}

export function mountControls(el: HTMLElement): void {
  el.innerHTML = `
    <h2>Controls</h2>
    ${section('Mouse', [
      { keys: ['Click'], desc: 'Select the unit under the cursor' },
      { keys: ['Click'], desc: 'With a unit selected: move it to that tile' },
      { keys: ['Click'], desc: 'With a unit selected: harvest a resource tile' },
      { keys: ['Click'], desc: 'In placement mode: site the pending building' },
      { keys: ['Drag'], desc: 'Pan the map' },
      { keys: ['Wheel'], desc: 'Zoom in / out' },
    ])}
    ${section('Keyboard', [
      { keys: ['W', 'A', 'S', 'D'], desc: 'Pan the map (also arrow keys)' },
      { keys: ['↑', '↓', '←', '→'], desc: 'Pan the map' },
      { keys: ['Esc'], desc: 'Cancel placement, then deselect, then close a panel' },
    ])}
    ${section('Toolbar', [
      { keys: ['⏸', '1×', '2×', '4×', '8×'], desc: 'Simulation speed' },
      { keys: ['−', '+'], desc: 'Zoom out / in (or the slider)' },
      { keys: ['⌖'], desc: 'Recenter the camera' },
      { keys: ['☰'], desc: 'Toggle the left sidebar layout' },
    ])}
    <p class="hint">Keys only pan when the map is active — click the map to
      re-arm them after using a panel or the chat. Pan speed is adjustable in
      Settings.</p>`;
}
