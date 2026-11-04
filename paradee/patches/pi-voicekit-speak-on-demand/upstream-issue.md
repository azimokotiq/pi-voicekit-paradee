# Feature request: speak on demand — read the last reply on a key, and cap auto-narration by length

**Version:** 0.4.2 (pi 1.3.0, Windows Terminal)

## The problem

`voice.ttsAutoSpeak` defaults to `true`, so once TTS is on, **every** assistant
reply is narrated. Two things are missing:

1. **A length limit.** The only guard in the auto-speak path is
   `prepareForSpeech(chunk, { maxChars: 2000 })`, and it is applied per
   *sentence chunk*, not per reply. A 6 000-character info dump is narrated in
   full, sentence by sentence. In a coding session that is the common case — most
   of those replies I only ever wanted to *see*.
2. **A way to ask for one reply.** There is no "read the last message" action.
   `/voice-speak <text>` needs the text typed in, and the only switch is
   `/voice-speak-toggle`, which is the TTS **master** — silencing narration also
   silences reading on request. So "be quiet for now" and "read me that one" both
   cost a round trip through a command.

## What I'd like

| action | behaviour |
|---|---|
| shortcut (I use `alt+s`) | if something is speaking → stop it; otherwise read the last assistant reply |
| shortcut (I use `alt+a`) | mute/unmute `ttsAutoSpeak` **without** touching `ttsEnabled` |
| `/voice-read [text]` | same, plus speak arbitrary text |
| `/voice-autospeak on\|off\|status\|<maxChars>` | the mute switch and the length cap |
| `voice.ttsAutoSpeakMaxChars` | spoken-char cap for auto-narration; `0` = today's behaviour |

Reading the last reply is easy from an extension: `ctx.sessionManager.getBranch()`
walked backwards for the newest `type: "message"`, `role: "assistant"` entry, then
`prepareForSpeech(..., { maxChars: Infinity })` and the existing `speak()` path.

## The design question: what does a cap mean when narration streams?

`maybeSpeakNew()` streams sentence by sentence off `message_update`, which is why
the first word lands ~1 s after the agent produces it — that is the best thing in
this package and I don't want to lose it. But a length cap is not decidable
mid-stream: a 20-character first sentence looks identical to the opening of a
2 000-character dump.

My patch buffers when a cap is set: every non-final `message_update` returns
early, and the decision happens at `message_end` — speak the whole reply, or stay
silent and say so once:

```
Not reading that reply — 1243 chars, over the 400 cap. Alt+S or /voice-read to hear it.
```

Cost: ~1–2 s of extra latency on short replies. Alternative I rejected: narrate
the first sentences and cut off when the text crosses the cap — that reads the
opening of every long answer and then stops mid-thought.

Worth noting the cap has to be enforced in **both** auto-speak paths — the
streaming one and the `turn_end` fallback — or the fallback re-offers the reply
the streaming path just declined (this is the same two-path hazard as #… the
double-narration race: `message_end` deletes the stream state, so `turn_end`
cannot tell "already spoken" from "declined"). Marking the declined reply in the
same bounded FIFO that marks a spoken one fixes it.

## Two constraints I'd hold to

* **Key bindings are global-only and resolved at load.** `pi.registerShortcut()`
  runs once when the extension loads, so a cloned repository's `.pi/settings.json`
  must not be able to rebind keys in someone else's terminal — exactly the rule
  `serializeConfig()` already applies to `toggleShortcut`. Same for a project
  *save*.
* **Manual reads are not length-capped.** The cap exists to stop narration the
  user did not ask for; `alt+s`/`/voice-read` *is* the request, so they should use
  `maxChars: Infinity` like `/voice-speak` does.

## Patch

`apply.sh` in this directory re-applies it to an installed copy (two files:
`extensions/voice.ts`, `extensions/voice/config.ts`) and self-tests it. Happy to
turn it into a PR — I'd want your call on the buffer-vs-cut-off choice above, and
on whether `ttsAutoSpeakMaxChars` should default to `0` (kept `0` here so the
patch is behaviour-preserving until configured).
