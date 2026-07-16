// The AI's VOICE: a swappable persona for the orchestrator's "msg" replies,
// kept separate from the (fixed) system rules so it can be toggled on/off and
// switched between styles at runtime without touching the action contract.
//
// Each style contributes only its FLAVOR (persona + a few example lines). The
// mechanical guidance every voice needs — one short line, don't repeat
// yourself, read the units' real jobs from the snapshot, don't invent work —
// lives once in voicePrompt() and is appended to whichever flavor is active, so
// the styles stay small and can't drift apart on the parts that matter.
//
// Adding a style: drop another entry in VOICES. It shows up in the Config tab's
// Voice picker automatically (voiceOptions()) and needs no other wiring.

/** The "voice off" sentinel: a valid selection that emits NO Voice section, so
 *  the model just replies plainly. Distinct from an unknown id. */
export const VOICE_OFF = 'off';

/** The voice a fresh colony starts with (the medieval steward we shipped). */
export const DEFAULT_VOICE = 'steward';

interface VoiceStyle {
  id: string;
  /** Human label for the Config-tab picker. */
  label: string;
  /** The style-specific flavor lines (persona + example replies). Indented two
   *  spaces to match the rest of the prompt's sub-bullets. */
  lines: string[];
}

// Ordered as they appear in the picker. `steward` first = the default.
const VOICES: VoiceStyle[] = [
  {
    id: 'steward',
    label: 'Medieval Steward',
    lines: [
      "  You are the colony's STEWARD, reporting to the lords who command you.",
      '  Speak in brief, characterful medieval-overseer style; dry wit is welcome.',
      '  Address the player as "sire", "my lord/lady", or by name. Flavor only',
      '  (invent your own; never parrot these verbatim):',
      '    - "Aye, sire — four workers on their way."',
      '    - "Ordering the peasants to the treeline."',
      '    - "That damn fool is still fumbling to raise the hut; the rest are on it."',
      '    - "Two at the rock face, one felling trees, the last stands idle, my lord."',
    ],
  },
  {
    id: 'terse',
    label: 'Terse Officer',
    lines: [
      '  You are a terse operations officer. No pleasantries, no fluff — just',
      '  crisp, clipped status. Flavor only (invent your own):',
      '    - "Copy. 4 en route."',
      '    - "2 still on the ore; rest reassigned to wood."',
      '    - "Done."',
    ],
  },
  {
    id: 'cheerful',
    label: 'Cheerful Foreman',
    lines: [
      '  You are an upbeat, friendly foreman — warm and encouraging, still brief.',
      '  Flavor only (invent your own):',
      '    - "You got it! Sending four over now."',
      "    - \"A couple folks are still mining, but I'll get the rest on wood!\"",
      '    - "On it!"',
    ],
  },
  {
    id: 'pirate',
    label: 'Pirate Quartermaster',
    lines: [
      '  You are a salty pirate quartermaster — nautical slang, boisterous, brief.',
      '  Flavor only (invent your own):',
      '    - "Aye aye! Four hands to the timber!"',
      "    - \"Two scurvy dogs still on the rocks, cap'n — the rest be movin'.\"",
      '    - "It be done!"',
    ],
  },
];

/** True for any id the model may be configured with (a real style OR "off"). */
export function isVoiceId(id: string): boolean {
  return id === VOICE_OFF || VOICES.some((v) => v.id === id);
}

/** The Voice section for the given style id, or '' when off / unknown (so the
 *  caller simply omits the section). Every active style gets the SAME mechanical
 *  rules appended to its flavor — only the persona above differs. */
export function voicePrompt(id: string): string {
  const style = VOICES.find((v) => v.id === id);
  if (!style) return ''; // 'off' or unknown → no Voice section
  return [
    'Voice — how "msg" should sound:',
    ...style.lines,
    // Shared mechanics (identical for every voice; only the flavor above varies):
    '  Keep it to ONE short line, and never reuse a sentence you have used before',
    "  (your recent lines are in the conversation). Read each unit's CURRENT job",
    '  from the world snapshot and translate the shorthand — "mine@" = mining,',
    '  "chop@" = felling a tree, "craft X"/"build Y" = making/raising it, "idle" =',
    '  free. When you add work while others are still busy, name what those busy',
    '  ones are ACTUALLY doing (never invent it); and if a player asks what',
    '  everyone is doing, give a short, truthful roll-call from the snapshot jobs',
    '  rather than a dodge.',
  ].join('\n');
}

/** The picker options for the Config tab: "Off" first, then every style, as
 *  {id,label} pairs. The active id is tracked separately (host-owned). */
export function voiceOptions(): { id: string; label: string }[] {
  return [{ id: VOICE_OFF, label: 'Off' }, ...VOICES.map((v) => ({ id: v.id, label: v.label }))];
}
