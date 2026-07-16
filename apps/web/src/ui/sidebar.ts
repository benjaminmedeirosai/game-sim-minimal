// The optional left sidebar — an alternative layout that gathers the AI chat
// and the actions feed into one column. It's additive: the floating unit card
// and the command bar stay exactly as they were; a topbar toggle just adds/
// removes `.layout-sidebar` on `.app` to reveal this. The chat is the shared
// colony conversation (one transcript, everyone's commands + the AI's replies)
// rendered straight from aiData — completed exchanges followed by any pending
// commands still awaiting the model.
import { ORCHESTRATOR_AGENT, describeAction } from '@game/shared';
import type { AiExchange, AiPending } from '@game/shared';
import { aiData, sendAiClear, sendCommand } from '../net/client';
import { mountActionsPanel } from './actionsPanel';

const AI_COLOR = '#a78bfa';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// A stable-ish hue from a player name, so the same person reads the same color
// across their chat bubbles. (Actions use peer-id hues; here we only have the
// name, which is close enough for the chat.)
function nameColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 62%, 62%)`;
}

/** The submitter's command bubble (shared by finished + pending turns). */
function userBubble(who: string, command: string): string {
  return (
    `<div class="chat-msg chat-user">` +
    `<span class="chat-who" style="color:${nameColor(who)}">${esc(who)}</span>` +
    `<span class="chat-text">${esc(command)}</span></div>`
  );
}

/** One exchange as chat: the submitter's command bubble, an optional AI reply
 *  bubble, and a compact line of the actions it ran. */
function chatTurn(x: AiExchange): string {
  const who = x.input.onBehalfOf ?? 'someone';

  const acts = x.output.actions.length
    ? `<div class="chat-acts">${x.output.actions
        .map((a) => `<span class="chat-act">${esc(describeAction(a))}</span>`)
        .join('')}</div>`
    : '';

  const reply = x.output.msg
    ? `<div class="chat-msg chat-ai"><span class="chat-who" style="color:${AI_COLOR}">AI</span>` +
      `<span class="chat-text">${esc(x.output.msg)}</span></div>`
    : '';

  const err = x.output.error
    ? `<div class="chat-msg chat-ai chat-err"><span class="chat-text">${esc(x.output.error)}</span></div>`
    : '';

  // A brain badge flags that this response changed the AI's saved memory (the
  // new memory itself lives in the AI window — here we only signal it happened).
  const mem = x.output.memory
    ? `<div class="chat-mem"><span class="chat-mem-icon" title="AI memory updated">🧠</span></div>`
    : '';

  return `<div class="chat-turn">${userBubble(who, x.input.command)}${reply}${mem}${acts}${err}</div>`;
}

/** A command that's landed but hasn't been answered yet: the submitter's bubble
 *  plus a "thinking" indicator. The whole turn glows to show it's processing. */
function pendingTurn(p: AiPending): string {
  const who = p.submitter ?? 'someone';
  const dots = `<div class="chat-msg chat-ai chat-thinking"><span class="chat-dots"><i></i><i></i><i></i></span></div>`;
  return `<div class="chat-turn chat-pending">${userBubble(who, p.command)}${dots}</div>`;
}

export function mountSidebar(aside: HTMLElement): void {
  aside.innerHTML = `
    <section class="sb-section sb-chat">
      <div class="sb-chat-head">
        <h2>AI Chat</h2>
        <button class="sb-clear" id="sb-chat-clear" type="button"
                title="Clear the AI chat history (does not touch the world or saved memory)">Clear</button>
      </div>
      <div class="chat-log" id="sb-chat-log"></div>
      <form class="chat-form" id="sb-chat-form">
        <input class="chat-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="Tell the AI what to do…" title="Type an instruction for the AI" />
        <button class="btn" type="submit" title="Send this command to the AI">Send</button>
      </form>
    </section>
    <section class="sb-section sb-actions">
      <div id="sb-actions"></div>
    </section>`;

  const log = aside.querySelector<HTMLElement>('#sb-chat-log')!;
  const form = aside.querySelector<HTMLFormElement>('#sb-chat-form')!;
  const input = aside.querySelector<HTMLInputElement>('.chat-input')!;
  const clearBtn = aside.querySelector<HTMLButtonElement>('#sb-chat-clear')!;

  // Reuse the exact Actions panel renderer in the sidebar's actions slot.
  mountActionsPanel(aside.querySelector<HTMLElement>('#sb-actions')!);

  // Chat: render the shared conversation, oldest→newest, with in-flight
  // commands trailing after the finished ones. Autoscroll to the bottom.
  aiData.subscribe((data) => {
    const orch = data.exchanges.filter((x) => x.agent === ORCHESTRATOR_AGENT);
    const pending = data.pending.filter((p) => p.agent === ORCHESTRATOR_AGENT);
    const html = orch.map(chatTurn).join('') + pending.map(pendingTurn).join('');
    log.innerHTML =
      html || `<div class="sb-empty">No messages yet. Ask the AI to do something.</div>`;
    log.scrollTop = log.scrollHeight;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendCommand(text);
    input.value = '';
  });

  // Clear the shared chat history on the host (removes context poisoning). We
  // confirm first since it wipes the whole transcript for everyone; the host
  // broadcasts the empty log back, so the view updates via the aiData sub.
  clearBtn.addEventListener('click', () => {
    if (log.querySelector('.chat-turn') && !confirm('Clear the AI chat history for everyone? This cannot be undone.')) return;
    sendAiClear(ORCHESTRATOR_AGENT);
  });
}
