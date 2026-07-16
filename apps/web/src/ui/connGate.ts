// A full-screen gate shown over the app until we're connected to a host. While
// connecting it's a quiet loader; if the host can't be reached it becomes a
// proper landing page explaining what's wrong and how to start the server, with
// a Retry button. Once connected it hides and the world takes over. This is the
// first (and, on a static GitHub Pages deploy with no host up, only) thing a
// visitor sees, so it doubles as the project's landing screen.
import { net, reconnect } from '../net/client';

export function mountConnGate(el: HTMLElement): void {
  net.subscribe((s) => {
    if (s.status === 'connected') {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = s.status === 'connecting' ? connecting() : offline(s.error);
    const retry = el.querySelector<HTMLButtonElement>('#gate-retry');
    retry?.addEventListener('click', () => reconnect());
  });
}

function shell(inner: string): string {
  return `
    <div class="gate-card">
      <div class="gate-logo" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="56" height="56">
          <rect x="6" y="6" width="52" height="52" rx="10" fill="#1b1e27" stroke="#2b2f3a"/>
          <circle cx="24" cy="26" r="5" fill="#6ea8fe"/>
          <circle cx="40" cy="26" r="5" fill="#52c785"/>
          <circle cx="32" cy="42" r="5" fill="#d1963c"/>
        </svg>
      </div>
      <h1 class="gate-title">game-sim-minimal</h1>
      <p class="gate-sub">A milestone-gated multiplayer colony sim.</p>
      ${inner}
    </div>`;
}

function connecting(): string {
  return shell(`
    <div class="gate-status">
      <span class="gate-spinner" aria-hidden="true"></span>
      <span>Connecting to the colony…</span>
    </div>`);
}

function offline(error?: string): string {
  const detail = error ?? 'Host is not reachable.';
  return shell(`
    <div class="gate-offline">
      <p class="gate-msg">Can't reach a host. ${escapeHtml(detail)}</p>
      <p class="gate-hint">The colony runs on a local host process. Start it, then retry:</p>
      <pre class="gate-code"><code>npm install
npm run dev</code></pre>
      <p class="gate-hint">This opens the host (server) and the web client together.
        Already running? Make sure it started without errors, then retry.</p>
      <button class="btn" id="gate-retry">Retry connection</button>
    </div>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
