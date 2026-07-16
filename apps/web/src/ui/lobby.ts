import { net } from '../net/client';
import type { NetState } from '../net/client';

function roleTag(p: NetState['roster'][number]): string {
  const label = p.isHost ? 'HOST' : p.role.toUpperCase();
  const svc = p.serviceType ? `<span class="tag tag-svc">${p.serviceType}</span>` : '';
  return `<span class="tag${p.isHost ? ' tag-host' : ''}">${label}</span>${svc}`;
}

/** Renders the room roster into a panel element. */
export function mountRoom(el: HTMLElement): void {
  net.subscribe((s) => {
    const status =
      s.status === 'connected'
        ? `Connected as ${s.me?.name ?? '?'}`
        : s.status === 'connecting'
          ? 'Connecting to room…'
          : `Error: ${s.error ?? 'unknown'}`;

    el.innerHTML = `
      <h2>Room</h2>
      <p class="status" data-status="${s.status}">${status}</p>
      <ul class="roster">
        ${
          s.roster.length
            ? s.roster
                .map((p) => `<li><span class="peer-name">${p.name}</span> ${roleTag(p)}</li>`)
                .join('')
            : '<li class="empty">No peers yet.</li>'
        }
      </ul>`;
  });
}
