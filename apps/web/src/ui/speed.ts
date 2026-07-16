import { sendSpeed } from '../net/client';
import { game } from '../state/game';

const SPEEDS: { label: string; value: number; title: string }[] = [
  { label: '❚❚', value: 0, title: 'Pause' },
  { label: '1×', value: 1, title: 'Normal speed' },
  { label: '2×', value: 2, title: '2× speed' },
  { label: '4×', value: 4, title: '4× speed' },
  { label: '8×', value: 8, title: '8× speed' },
];

/** Speed control buttons. The host is authoritative over speed, so we just
 *  send setSpeed and reflect whatever the host reports back in `game.speed`. */
export function mountSpeed(el: HTMLElement): void {
  el.classList.add('speed');
  el.innerHTML = SPEEDS.map(
    (s) => `<button class="speed-btn" data-value="${s.value}" title="${s.title}">${s.label}</button>`,
  ).join('');

  el.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => sendSpeed(Number(btn.dataset.value)));
  });

  game.subscribe((s) => {
    el.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.value) === s.speed);
    });
  });
}
