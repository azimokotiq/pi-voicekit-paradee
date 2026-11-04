# pi-voicekit-tts-warmup — the first spoken reply of a session stops paying a hidden model load

**Upstream:** `pi-voicekit` 0.4.2 (`@ghulom/pi-voicekit`), installed under
`~/.pi/agent/npm/node_modules/pi-voicekit`. Verified applied on 2026-10-17.

## The symptom

Every pi process speaks its **first** reply noticeably slower than all the rest:

| model | first utterance | every later utterance |
|---|---|---|
| `paradee-8m-v1_0` | **4 107 ms** for 8.65 s of audio (RTF 0.475) | 696–782 ms (RTF 0.080–0.090) |
| `kokoro-int8-en-v0_19` | ~1.9 s | ~1.5 s (RTF ≈ 2.2) |
| `kitten-nano-en-v0_2` | similar | 0.48 |

Nothing about the text explains it: it is ONNX session creation + graph
optimisation + the first G2P load, happening *inside* the reply.

## The cause

`extensions/voice/tts-engine.ts:274` **exports `warmupTts()` and nothing in the
package ever calls it**:

```
$ grep -rn "warmupTts" extensions/
extensions/voice/tts-engine.ts:274:export async function warmupTts(
```

The function is even Paradee-aware in this fork (it dispatches to
`preloadParadee()` for `backend: "paradee"` models instead of wrongly building an
`OfflineTts` through sherpa), so it just sits there unused. Upstream already
applies the trick one file over — at `session_start` it calls
`preparePunctuation()` so "no dictation ever waits for a background build" — but
not for speech output.

## The fix (`tts-warmup.patch`, 4 hunks in `extensions/voice.ts`)

One module-scope helper plus three call sites:

```ts
const ttsWarmupAttempted = new Set<string>();
export async function warmupSelectedTts(getConfig: () => VoiceConfig, reason: string): Promise<boolean>
```

* **gated** — returns immediately unless `ttsEnabled === true` *and* the backend
  is `local` (cloud TTS has nothing to warm) *and* the model is installed, so a
  voice-disabled session loads no model and pays nothing;
* **keyed on model id** — runs once per model per process; switching models in
  the settings panel warms the new one without re-warming the old;
* **best-effort** — never throws, never blocks (every call site uses `void`), and
  a failed attempt is removed from the Set so a later turn can retry;
* **`getConfig` is a thunk** because `config` is reassigned at every
  `session_start` and settings save — a captured value would be stale.

Call sites:

1. `session_start`, immediately after the existing `preparePunctuation()` block —
   the load overlaps with the user typing their first message.
2. `/voice-speak-toggle` when enabling TTS.
3. `finalizeAndSaveSetup()`, so a model chosen in the settings panel is resident
   before the next reply.

## Result (measured on this machine)

```
✓ warmupSelectedTts() warm (model resident, ONNX session + G2P): 3722 ms   ← background, at session_start
✓ first synthesize() after warmup: 163200 samples in 827 ms  (was 4111 ms unwarmed)
```

## Re-applying after an update

pi-voicekit installs in `node_modules`, so **pi-auto-update wipes this patch on
any version bump**. One command re-applies all local patches in dependency order
and self-tests each:

```
bash ~/.pi/agent/patches/apply_all.sh
```

This patch is last in that order: two of its hunks have context lines that only
exist after `pi-voicekit-win-mic-device` and `pi-voicekit-esc-stops-reply`.

`apply.sh` is idempotent — it greps `extensions/voice.ts` for
`warmupSelectedTts` (patch present) and for a direct `warmupTts(`/`void warmupTts(`
call (upstream fixed it themselves), and does nothing in either case.

## Self-test

`test_warmup.mjs` (run by `apply.sh`) checks all three layers against the
*installed* files:

1. **wiring** — helper defined exactly once, all three call sites present,
   `voice.ts` is the only caller of `warmupTts` (line-based check, so doc
   comments and the definition itself don't count);
2. **gating** — disabled TTS, `deepgram` backend and an unknown model id each
   return `false` and do no work, and nothing throws;
3. **effect** — with the real configured model, `warmupSelectedTts()` returns
   `true`, a second call is a no-op, and a **real `synthesize()`** afterwards
   finishes in under 1.5 s (assertion fails if the warmup didn't actually make
   the engine resident).

It sets its own `NODE_PATH` for pi's packages rather than inheriting it, because
the harness shell does not always export it.

## Caveats

* With TTS enabled, the session keeps the TTS engine resident from the first
  moment. For Paradee that's 9 MB; for Kokoro-int8 it is a few hundred MB. That
  is the same trade upstream already makes for the punctuation engine (~292 MB
  resident), and it is what removes the latency — but it is a real trade, not a
  free win.
* The warmup runs at `session_start`, so `pi --print` one-shot runs that never
  speak also pay it. It costs a few seconds of CPU in a process that is about to
  exit; if that bothers you, gate it on `ctx.hasUI`.
* An `--extension` that speaks before `session_start` finishes will still race;
  the engine is cached, so whoever gets there first wins legitimately.
