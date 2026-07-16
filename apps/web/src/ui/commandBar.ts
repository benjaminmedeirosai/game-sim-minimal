// The natural-language command bar. Pinned bottom-center of the world; the
// player types an instruction and it goes to the host's AI orchestrator as a
// { m: 'command' } message. Results show up in the world (actions apply) and,
// attributed to the AI, in the Actions panel + AI History window.
import { sendCommand } from '../net/client';
import { closeLayer, openLayer } from './escStack';

export function mountCommandBar(world: HTMLElement): void {
  const bar = document.createElement('form');
  bar.className = 'cmd-bar';
  bar.innerHTML = `
    <span class="cmd-glyph">✦</span>
    <input class="cmd-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="Tell the AI what to do…  (e.g. “send everyone to chop the nearest trees”)" />
    <button class="cmd-send btn" type="submit">Send</button>`;
  world.appendChild(bar);

  const input = bar.querySelector<HTMLInputElement>('.cmd-input')!;

  // Collapsed by default: just the ✦ glyph. Clicking it expands the bar and
  // drops the cursor in the input; it re-collapses on Escape, on blur when
  // empty, and after a command is sent.
  bar.classList.add('collapsed');
  const expand = (): void => {
    bar.classList.remove('collapsed');
    input.focus();
    // Expanded bar is the top Esc layer; Esc clears + collapses it.
    openLayer('cmdbar', () => {
      input.value = '';
      collapse();
      input.blur();
    });
  };
  const collapse = (): void => {
    bar.classList.add('collapsed');
    closeLayer('cmdbar');
  };

  // Keep world pan/zoom/click from firing while typing in the bar.
  for (const ev of ['pointerdown', 'pointerup', 'click'] as const) {
    bar.addEventListener(ev, (e) => e.stopPropagation());
  }

  bar.addEventListener('click', () => {
    if (bar.classList.contains('collapsed')) expand();
  });
  input.addEventListener('blur', () => {
    if (!input.value.trim()) collapse();
  });

  bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendCommand(text);
    input.value = '';
    bar.classList.add('sent');
    setTimeout(() => bar.classList.remove('sent'), 400);
    collapse();
  });
}
