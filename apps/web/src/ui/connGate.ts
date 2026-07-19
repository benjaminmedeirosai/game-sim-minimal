// A full-screen gate shown over the app until we're in a live session. It has
// four faces:
//  - idle / rejected : the JOIN form (name, world, "play from other computers").
//                      'rejected' adds the host's reason (name taken, etc.).
//  - connecting      : a quiet loader while the handshake completes.
//  - error           : the host is unreachable — a landing page explaining how to
//                      start the server, with Retry.
// Once connected it hides and the world takes over. This is the first (and, on a
// static deploy with no host up, only) thing a visitor sees, so it doubles as
// the project's landing screen.
import { connect, net, reconnect } from '../net/client';
import { knownNames, savedAllowOthers, savedName } from '../state/identity';

// Sentinel <option> value for "create a new character" in the player picker.
const NEW_PLAYER = '__new__';

export function mountConnGate(el: HTMLElement): void {
  net.subscribe((s) => {
    if (s.status === 'connected') {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (s.status === 'connecting') el.innerHTML = connecting();
    else if (s.status === 'error') el.innerHTML = offline(s.error);
    else el.innerHTML = joinForm(s.status === 'rejected' ? s.error : undefined);

    el.querySelector<HTMLButtonElement>('#gate-retry')?.addEventListener('click', () => reconnect());
    wireJoinForm(el);
  });

  // Returning players already have a device token and last-used character in
  // local storage, so reconnect directly instead of making a refresh look like
  // a fresh login. A rejected/unreachable attempt still lands on the gate.
  const name = savedName().trim();
  if (name) connect(name, savedAllowOthers());
}

/** Wire the join form: the player picker toggles the name field (existing
 *  character vs. new one), and submit → connect(name, allowOthers). No-op when
 *  the form isn't the current face. */
function wireJoinForm(el: HTMLElement): void {
  const form = el.querySelector<HTMLFormElement>('#gate-join');
  if (!form) return;
  const picker = form.querySelector<HTMLSelectElement>('#gate-player'); // absent for a first-time browser
  const nameRow = form.querySelector<HTMLElement>('#gate-name-row')!;
  const input = form.querySelector<HTMLInputElement>('#gate-name')!;

  // Show the free-text name field only when creating a new character (or when
  // there's no picker at all — a brand-new browser starts on the new flow).
  const isNew = (): boolean => !picker || picker.value === NEW_PLAYER;
  const syncNameRow = (): void => {
    nameRow.hidden = !isNew();
    if (isNew()) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };
  picker?.addEventListener('change', () => {
    if (isNew()) input.value = '';
    syncNameRow();
  });
  syncNameRow();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // An existing character comes from the picker; a new one from the text field.
    const name = isNew() ? input.value.trim() : picker!.value;
    if (!name) {
      input.focus();
      return;
    }
    const allowOthers = form.querySelector<HTMLInputElement>('#gate-allow')!.checked;
    connect(name, allowOthers);
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

function joinForm(rejectedReason?: string): string {
  const known = knownNames();
  const last = savedName();
  const allow = savedAllowOthers() ? 'checked' : '';
  const banner = rejectedReason
    ? `<p class="gate-reject">${escapeHtml(rejectedReason)}</p>`
    : '';
  // The name field is prefilled only for a first-time browser (no picker yet);
  // returning players choose their character from the picker instead.
  const namePrefill = known.length === 0 ? escapeHtml(last) : '';
  return shell(`
    ${banner}
    <form class="gate-form" id="gate-join">
      ${playerPicker(known, last)}

      <div id="gate-name-row" class="gate-name-row">
        <label class="gate-label" for="gate-name">${known.length ? 'New character name' : 'Your name'}</label>
        <input class="gate-input" id="gate-name" type="text" maxlength="24" autocomplete="off"
               spellcheck="false" placeholder="Pick a name" value="${namePrefill}" />
      </div>

      <label class="gate-label" for="gate-world">World</label>
      <select class="gate-input" id="gate-world">
        <option value="main" selected>Main colony</option>
      </select>

      <label class="gate-check">
        <input type="checkbox" id="gate-allow" ${allow} />
        <span>Allow my user to play from other computers
          <small>Opens this name to a new device once — turn it off after you've added it.</small>
        </span>
      </label>

      <button class="btn gate-join-btn" type="submit">Join the colony</button>
    </form>`);
}

/** The player picker: known characters on this browser + a "new character"
 *  entry. Returns '' for a first-time browser (nothing to pick yet — the name
 *  field stands alone). Preselects the last-used character. */
function playerPicker(known: string[], last: string): string {
  if (known.length === 0) return '';
  const lastKey = last.trim().toLowerCase();
  const opts = known
    .map((n) => {
      const sel = n.trim().toLowerCase() === lastKey ? ' selected' : '';
      return `<option value="${escapeHtml(n)}"${sel}>${escapeHtml(n)}</option>`;
    })
    .join('');
  return `
    <label class="gate-label" for="gate-player">Player</label>
    <select class="gate-input" id="gate-player">
      ${opts}
      <option value="${NEW_PLAYER}">＋ New character…</option>
    </select>`;
}

function connecting(): string {
  return shell(`
    <div class="gate-status">
      <span class="gate-spinner" aria-hidden="true"></span>
      <span>Joining the colony…</span>
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
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
