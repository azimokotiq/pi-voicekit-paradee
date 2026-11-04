# Auto-spoken reply is narrated twice when the TTS model is fast

**pi-voicekit 0.4.2**, `extensions/voice.ts`. Windows, local TTS (`ttsBackend: "local"`).

## Symptom

With auto-speak on, the assistant's reply is spoken **twice in full** — the second
time immediately after the first. Not per sentence: the whole message.

It only reproduces with a TTS model that synthesizes faster than real time. With
Kokoro (RTF ≈ 1.1) it never happened; switching to a model at RTF 0.085 made it
happen every turn, which is what surfaced it.

## Cause

Two paths can speak one assistant reply:

1. the streaming path — `message_update` / `message_end` → `maybeSpeakNew()`, which
   chunks at sentence boundaries and tracks `state.spokenLen`;
2. the "legacy `turn_end` fallback" for Pi versions that don't emit `message_update`.

The fallback's guard is:

```ts
const state = messageStreams.get(id);
if (state || cancelledMessageIds.has(id)) return;
```

but `message_end` deletes that state as soon as the last chunk finishes playing:

```ts
state.pending.finally(() => {
    if (messageStreams.get(id) === state) messageStreams.delete(id);
});
```

So the guard is a race against playback. A slow model is still speaking when
`turn_end` arrives → `state` exists → the fallback correctly skips. A fast model
finishes a 10 s utterance in ~0.9 s → the state is gone → "no state" is read as
"nobody spoke this" → the fallback re-speaks everything.

Compounding it: `lastAutoSpeakAt`, the 3000 ms limiter that exists precisely to
stop a duplicate, is written **only** by the fallback (line 3032) and never by the
streaming path — so it could never suppress this.

## Fix

A bounded FIFO of ids the streaming path already spoke, same shape as the
`cancelledMessageIds` set:

```ts
const spokenMessageIds = new Set<string>();
function markReplySpoken(id: string): void {
	spokenMessageIds.add(id);
	if (spokenMessageIds.size > 64) spokenMessageIds.delete(spokenMessageIds.values().next().value as string);
}
```

`message_end` marks the reply **only when the stream actually queued speech**
(`flushed.spokenLen > 0`), so a reply that could not be spoken — e.g. the mic was
hot, or TTS was mid-toggle — still gets the fallback:

```ts
const flushed = messageStreams.get(id);
if (flushed && flushed.spokenLen > 0) {
	markReplySpoken(id);
	lastAutoSpeakAt = Date.now();   // streaming path now feeds the limiter too
}
```

and `turn_end` refuses it:

```ts
if (state || cancelledMessageIds.has(id) || spokenMessageIds.has(id)) return;
```

The fallback also logs `voiceDebug("turn_end fallback speak", …)` now, so the race
is visible in `PI_VOICE_DEBUG=1` output instead of being something you can only
notice by ear.
