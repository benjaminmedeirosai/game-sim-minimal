// The Controls panel, two tabs:
//   • Hotkeys — keyboard shortcuts only (things you press).
//   • Guide   — what the mouse and the toolbar buttons do (things you click).
// A floating panel, so it can be left open beside the map for reference;
// clicking the map re-arms the keyboard without closing it.
interface Row {
  keys: string[]; // rendered as <kbd> chips
  desc: string;
}

function grid(rows: Row[]): string {
  return `<div class="ctl-grid">${rows
    .map(
      (r) =>
        `<div class="ctl-keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</div>` +
        `<div class="ctl-desc">${r.desc}</div>`,
    )
    .join('')}</div>`;
}

function section(title: string, rows: Row[]): string {
  return `<h2 class="mt">${title}</h2>${grid(rows)}`;
}

// Keyboard shortcuts — the things you actually press.
function hotkeysTab(): string {
  return (
    section('Map', [
      { keys: ['W', 'A', 'S', 'D'], desc: 'Pan the map' },
      { keys: ['↑', '↓', '←', '→'], desc: 'Pan the map' },
    ]) +
    section('General', [
      { keys: ['Esc'], desc: 'Cancel placement, then deselect, then close a panel' },
    ]) +
    `<p class="hint">Keys only pan when the map is active — click the map to
      re-arm them after using a panel or the chat. Pan speed is adjustable in
      Settings.</p>`
  );
}

// What things do — mouse gestures and the toolbar buttons.
function guideTab(): string {
  return (
    section('Mouse', [
      { keys: ['Click'], desc: 'Select the unit under the cursor' },
      { keys: ['Click'], desc: 'With a unit selected: move it to that tile' },
      { keys: ['Click'], desc: 'With a unit selected: harvest a resource tile' },
      { keys: ['Click'], desc: 'In placement mode: site the pending building' },
      { keys: ['Drag'], desc: 'Pan the map' },
      { keys: ['Wheel'], desc: 'Zoom in / out' },
    ]) +
    section('Toolbar', [
      { keys: ['⏸', '1×', '2×', '4×', '8×'], desc: 'Simulation speed' },
      { keys: ['−', '+'], desc: 'Zoom out / in (or the slider)' },
      { keys: ['⌖'], desc: 'Recenter the camera' },
      { keys: ['☰'], desc: 'Toggle the left sidebar layout' },
    ])
  );
}

export function mountControls(el: HTMLElement): void {
  let tab: 'hotkeys' | 'guide' = 'hotkeys';
  el.innerHTML = `
    <h2>Controls</h2>
    <div class="ai-tabs" id="ctl-tabs">
      <button class="ai-tab" data-tab="hotkeys">Hotkeys</button>
      <button class="ai-tab" data-tab="guide">Guide</button>
    </div>
    <div id="ctl-body"></div>`;

  const tabs = el.querySelector<HTMLElement>('#ctl-tabs')!;
  const body = el.querySelector<HTMLElement>('#ctl-body')!;

  const render = (): void => {
    tabs.querySelectorAll<HTMLElement>('.ai-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    body.innerHTML = tab === 'hotkeys' ? hotkeysTab() : guideTab();
  };

  tabs.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.ai-tab');
    if (!btn) return;
    tab = btn.dataset.tab === 'guide' ? 'guide' : 'hotkeys';
    render();
  });

  render();
}
