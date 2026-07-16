// A single ordered stack of dismissible UI layers, so one Escape press closes
// exactly the most-recently-opened thing — a floating panel, placement mode,
// the selected unit, the AI window, or the command bar — instead of every
// listener firing at once. Owners call openLayer when their thing appears and
// closeLayer when it's dismissed by any other means (a button, a backdrop
// click, selecting something else); Escape itself pops the top and closes it.
type Layer = { id: string; close: () => void };

const stack: Layer[] = [];

/** Mark a layer open, or move it to the top if it's already open. `close` tears
 *  down whatever UI state the layer owns; it runs when Escape reaches it. */
export function openLayer(id: string, close: () => void): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i >= 0) stack.splice(i, 1);
  stack.push({ id, close });
}

/** Mark a layer closed (dismissed by something other than Escape). No-op if it
 *  isn't on the stack, so it's safe to call unconditionally from a subscriber. */
export function closeLayer(id: string): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i >= 0) stack.splice(i, 1);
}

// One capture-phase handler owns Escape: pop the top layer and close only that
// one. stopPropagation keeps element-level handlers from double-acting, and we
// only swallow the key when there's actually something to close.
let installed = false;
export function installEscStack(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || stack.length === 0) return;
      const top = stack.pop()!;
      e.preventDefault();
      e.stopPropagation();
      top.close();
    },
    true,
  );
}
