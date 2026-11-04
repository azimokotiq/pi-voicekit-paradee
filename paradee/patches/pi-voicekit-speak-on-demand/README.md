# pi-voicekit-speak-on-demand

Read a reply **when you ask for it**, and stop pi-voicekit narrating everything.

## What the user gets

| | |
|---|---|
| `alt+s` | Read the last assistant reply aloud. Press again while it is speaking → stop. |
| `alt+a` | Mute/unmute automatic narration **without** turning TTS off, so `alt+s` still works while muted. |
| `/voice-read [text]` | Same as `alt+s`; with an argument it reads that text instead. |
| `/voice-autospeak on\|off\|status\|<maxChars>` | The mute switch, and the length cap, from the keyboard. |
| `/voice-speak-info` | Now shows the cap and both keys. |

Settings (`~/.pi/agent/settings.json` → `voice`), all validated at load:

```json
"ttsAutoSpeakMaxChars": 400,   // 0 = narrate every reply (upstream default)
"speakShortcut": "alt+s",      // global-only; invalid value → default + warning
"autoSpeakShortcut": "alt+a"   // global-only, same rule as toggleShortcut
```

## Why the cap buffers to the end of a reply

Auto-speak streams **sentence by sentence**: `message_update` fires as tokens
arrive and each finished sentence is queued for synthesis, which is what makes
the first word land ~1 s after the agent produces it. A length cap cannot be
decided mid-stream — a 20-character first sentence is indistinguishable from the
opening of a 2 000-character info dump.

Two honest options; buffering won:

* **buffer to `message_end`, then decide** — long replies never start talking.
  Costs ~1–2 s of extra latency on short replies (at ~26 tok/s, a 400-char
  reply finishes generating in about 2 s).
* start narrating and cut itself off when the text crosses the cap — reads the
  first sentence of every long answer, then goes silent mid-thought.

So with a cap set, `maybeSpeakNew()` returns early for every non-final
`message_update`, and the whole reply is spoken in one pass at `message_end`
— or skipped, in which case it says so once:

```
Not reading that reply — 1243 chars, over the 400 cap. Alt+S or /voice-read to hear it.
```

The skipped reply is passed to `markReplySpoken()` (from
`pi-voicekit-no-double-narration`) so the legacy `turn_end` fallback cannot
offer it again — the cap is applied in **both** auto-speak paths.

## Files touched

* `speak-on-demand.patch` → `extensions/voice.ts`
* `autospeak-config.patch` → `extensions/voice/config.ts`

Manual reads (`alt+s`, `/voice-read`) are deliberately **not** length-capped —
the cap exists to stop narration you did not ask for. They call
`prepareForSpeech(..., { maxChars: Infinity })` like upstream's `/voice-speak`.

## ORDERING

Apply **last**. Its hunks sit inside code introduced by
`pi-voicekit-esc-stops-reply` (`cancelledMessageIds`) and
`pi-voicekit-no-double-narration` (`markReplySpoken`, `spokenMessageIds`).

## Self-test

```
node ~/.pi/agent/patches/pi-voicekit-speak-on-demand/test_speak_on_demand.mjs
```

Checks the wiring (two `registerShortcut` calls, two commands, one cap accessor);
that **both** auto-speak paths size `prepareForSpeech` by the cap and that a
skipped-long reply is marked handled; that the master
`!config.ttsEnabled || !config.ttsAutoSpeak` gates are still there (2 of them,
so muting still short-circuits); and behaviour against the real modules — the cap
parses, a string or negative cap falls back, an invalid shortcut is rejected with
the default kept, a **project** block can neither rebind the keys at load nor
persist them through `saveConfig` (a cloned repo must not steer the terminal), and
the length probe reports `stats.finalChars` as the honest spoken length.

## Regression risk

The two new keys are `alt+s` / `alt+a` — free in pi's default map (pi uses
`alt+enter`, `alt+up`, `alt+v`, `alt+p`, `alt+b/f/d/y`, `alt+backspace/delete`).
If a terminal eats `alt+`, set `speakShortcut` to e.g. `ctrl+shift+r` — that is
what the config field is for. Nothing else in pi-voicekit's key handling changed;
hold-to-talk on SPACE and `ctrl+shift+v` are untouched.
