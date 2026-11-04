# pi-voicekit patch: Esc stops the whole spoken reply

**Bug:** with `ttsAutoSpeak` on, a reply is streamed as sentence-sized chunks
chained through `state.pending = state.pending.then(() => runSpeak(…))`
(`voice.ts` ~2859). Every stop affordance called `abortActiveSpeak()`, which
cancels only the utterance currently playing (`voice.ts:3732`, `3524`) — the
queued chunks kept starting, so Esc "kept restarting on the next paragraph"
and a long reply could not be interrupted.

**Fix:** add a `cancelled` flag to `MessageStreamState`;
`cancelMessageStreams()` flips it for every live stream; the chunk chain and the
streaming entry check it; all stop sites (playback indicator `onStop`,
`/voice-speak-stop`, disabling TTS, `startPreRecording`, `startRecording`) now
call `stopSpeechAndQueuedChunks()`, and `cancelledMessageIds` (bounded FIFO of
64) stops the legacy `turn_end` fallback from re-speaking a stopped reply.

- Target: `extensions/voice.ts` (0.4.2), 135-line unified diff `esc-stop.patch`
- Ordering: apply **after** `pi-voicekit-win-mic-device` (context lines come
  from a mic-patched voice.ts); `apply_all.sh` handles the order.
- Self-test: `test_esc_stop.mjs` — jiti-loads the patched voice.ts, exercises
  `cancelMessageStreams` (flip-once + drop count + idempotent) and asserts all
  9 wiring sites.
