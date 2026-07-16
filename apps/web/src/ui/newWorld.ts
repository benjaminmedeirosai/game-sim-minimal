import type { WorldSettings } from '@game/shared';
import { sendNewWorld } from '../net/client';
import { game } from '../state/game';

/** New-world settings form. `onDone` is called after a world is requested so
 *  the host can close the panel. */
export function mountNewWorld(el: HTMLElement, onDone: () => void): void {
  const cur = game.get().world?.settings;
  const defaults: WorldSettings = cur ?? { width: 48, height: 48, seed: 1337, zoom: 20 };

  el.innerHTML = `
    <h2>New World</h2>
    <form class="form" id="new-world-form">
      <label>Width <input name="width" type="number" min="8" max="120" value="${defaults.width}" /></label>
      <label>Height <input name="height" type="number" min="8" max="120" value="${defaults.height}" /></label>
      <label>Zoom (tiles across) <input name="zoom" type="number" min="4" max="160" value="${defaults.zoom}" /></label>
      <label>Seed <input name="seed" type="number" value="${defaults.seed}" /></label>
      <div class="form-row">
        <button type="button" class="btn btn-ghost" id="seed-random">Random seed</button>
        <button type="submit" class="btn">Generate</button>
      </div>
      <p class="hint">Generating replaces the shared world for everyone in the room.</p>
    </form>`;

  const form = el.querySelector<HTMLFormElement>('#new-world-form')!;
  const seedInput = form.querySelector<HTMLInputElement>('input[name="seed"]')!;

  el.querySelector<HTMLButtonElement>('#seed-random')!.addEventListener('click', () => {
    seedInput.value = String(Math.floor(Math.random() * 1_000_000));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const num = (k: string): number => Number(data.get(k));
    sendNewWorld({
      width: num('width'),
      height: num('height'),
      zoom: num('zoom'),
      seed: num('seed'),
    });
    onDone();
  });
}
