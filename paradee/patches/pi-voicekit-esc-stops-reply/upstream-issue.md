# Esc / /voice-speak-stop only cancels the current utterance, not the queued chunks

With auto-speak on, pi-voicekit 0.4.2 splits a streaming reply into
sentence-sized chunks and chains them:

```ts
state.pending = state.pending.then(async () => {
	try {
		await runSpeak(ctx, prepared.text);
```

Every stop affordance — the `TtsPlaybackIndicator` `onStop` (`voice.ts:3732`),
`/voice-speak-stop` (`3855`), disabling TTS, and starting a recording — only
calls `abortActiveSpeak()` (`3524`), which cancels the **active** utterance.
Everything already queued behind it keeps synthesizing and playing, so pressing
Esc repeatedly during a long reply appears to "restart on the next paragraph"
and the reply cannot be silenced.

Expected: one Esc stops speech for the rest of that reply.

Proposed fix (verified locally against 0.4.2, `voice.ts`): a `cancelled` flag
per `MessageStreamState`, flipped by a `cancelMessageStreams()` helper at every
stop site, checked by the chunk chain before synthesizing the next chunk, plus a
bounded set of cancelled message ids so the `turn_end` fallback cannot re-speak
the message:

```ts
export function cancelMessageStreams(streams: Map<string, { cancelled: boolean }>): number {
	let dropped = 0;
	for (const state of streams.values()) {
		if (!state.cancelled) {
			state.cancelled = true;
			dropped++;
		}
	}
	return dropped;
}
```

Happy to open a PR.
