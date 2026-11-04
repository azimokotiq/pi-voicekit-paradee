# pi-voicekit-no-double-narration

Stops an assistant reply being spoken **twice**.

`upstream-issue.md` has the full write-up; short version: auto-speak has a
streaming path and a "legacy `turn_end` fallback", and the fallback's guard is
`if (messageStreams.get(id)) return;`. But `message_end` deletes that state as soon
as playback finishes, so the guard is a race against speech duration. A slow model
(Kokoro, RTF ≈ 1.1) is still playing when `turn_end` arrives and the fallback
correctly skips; a fast model (Paradee, RTF 0.085) is done in ~0.9 s, the state is
gone, and the fallback re-speaks the entire message. **Switching to a faster TTS
model is what made this fire every turn.**

The fix is a bounded FIFO of ids the streaming path already spoke
(`spokenMessageIds` / `markReplySpoken`), marked in `message_end` only when the
stream actually queued something, and honoured by the `turn_end` guard. The
fallback now also logs `turn_end fallback speak`, so the condition is visible in
`PI_VOICE_DEBUG=1` output rather than only audible.

- 4 hunks, `no-double-narration.patch`, `extensions/voice.ts` 4114 → 4134 lines.
- Depends on `pi-voicekit-esc-stops-reply` (the hunk context contains
  `markReplyCancelled`), so it runs after it in `../apply_all.sh`.
- Self-test: `node test_no_double_narration.mjs` — 8 wiring checks, 3 uniqueness
  counts, and an assertion that the old un-tombstoned guard is gone.
- Idempotency marker: `spokenMessageIds`.
- Not verified audibly by me: `pi -p` exits mid-playback, so the probe run can only
  show that no `turn_end fallback speak` line appears. Ear confirmation needs an
  interactive session, and the extension loads at process start — restart pi.
